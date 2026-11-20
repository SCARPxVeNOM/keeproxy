// SPDX-License-Identifier: Apache-2.0
//
// keeproxy-viewer: the hosted, watch-only backend for the console. It holds no
// keys, no wallet and no private state: everything it serves is read from the
// indexer, which anyone can query. Safe to expose publicly.
//
//   MIDNIGHT_NETWORK=preprod KEEPROXY_ADDRESS=<contract> npm run viewer
//
// Same JSON shapes as keeproxyd (/api/status, /api/state, /api/events,
// /api/tx/:hash), plus `watch: true`, `devices: null` and the vault's call
// history, so the console renders it in watch mode.
//
// It also serves the contract's public proving artifacts under
// /zk/<manifest sha-256>/{compiler,keys,zkir}/<file>, and the public proving
// parameters under /zk/params/, for browsers that prove. None of it is secret.

import { createServer, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { WebSocket } from 'ws';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { LOCAL_CONFIG, getConfig } from '../src/config.js';
import { ledgerState } from '../src/providers.js';
import { publicViewOf, type PublicView } from '../src/public-view.js';
import { txReceipt } from '../src/tx-receipt.js';
import { ledger } from '../contract/index.js';

// @ts-expect-error WebSocket global for the indexer's GraphQL subscriptions
globalThis.WebSocket ??= WebSocket;

const network = process.env['MIDNIGHT_NETWORK'] ?? 'local';
if (network !== 'local' && existsSync(`.env.${network}`)) {
  const { loadEnv } = await import('vite');
  Object.assign(process.env, { ...loadEnv(network, process.cwd(), ''), ...process.env });
}
// A missing network credential is reported on /health and /api/state, not fatal.
const configError = (() => {
  try {
    getConfig();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
})();
const config = configError ? { ...LOCAL_CONFIG, indexer: 'https://unconfigured.invalid/' } : getConfig();
const PORT = Number(process.env['PORT'] ?? 8788);
const HOST = process.env['HOST'] ?? '0.0.0.0';
const POLL_MS = Number(process.env['KEEPROXY_POLL_MS'] ?? 6000);
const ZK_DIR = path.resolve(process.env['KEEPROXY_ZK_DIR'] ?? 'contract/managed/proxy');
const ZK_MANIFEST = path.join(ZK_DIR, 'compiler', 'contract-manifest.json');
// The web build pins this hash; it is also the cache key in every /zk/ URL.
const zkVersion = existsSync(ZK_MANIFEST) ? createHash('sha256').update(readFileSync(ZK_MANIFEST)).digest('hex') : null;

function vaultAddress(): string | null {
  const env = process.env['KEEPROXY_ADDRESS']?.trim();
  if (env) return env;
  const file = `deployments/${network}.json`;
  if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { contractAddress: string }).contractAddress;
  return null;
}
const address = vaultAddress();

// The indexer URL may carry a Blockfrost project_id; it never leaves this process.
const publicIndexer = (() => {
  const u = new URL(config.indexer);
  u.searchParams.delete('project_id');
  return u.toString();
})();

interface HistoryItem {
  kind: 'deploy' | 'call' | 'maintenance';
  entryPoint: string | null;
  hash: string;
  height: number;
  at: number;
  status: string | null;
}

interface WatchEvent {
  at: number;
  kind: 'tx' | 'info' | 'error';
  circuit?: string;
  message: string;
  txId?: string;
}

const HISTORY_QUERY = `query ($address: HexEncoded!, $limit: Int) {
  contract(address: $address) {
    actions(limit: $limit) {
      __typename
      ... on ContractCall { entryPoint transaction { hash block { height timestamp } ... on RegularTransaction { transactionResult { status } } } }
      ... on ContractDeploy { transaction { hash block { height timestamp } } }
      ... on ContractUpdate { transaction { hash block { height timestamp } } }
    }
  }
}`;

interface RawAction {
  __typename: 'ContractCall' | 'ContractDeploy' | 'ContractUpdate';
  entryPoint?: string;
  transaction: { hash: string; block: { height: number; timestamp: number }; transactionResult?: { status: string } };
}

async function fetchHistory(addr: string): Promise<HistoryItem[]> {
  const r = await fetch(config.indexer, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: HISTORY_QUERY, variables: { address: addr, limit: 200 } }),
  });
  if (!r.ok) throw new Error(`indexer HTTP ${r.status}`);
  const b = (await r.json()) as { data?: { contract: { actions: RawAction[] } | null }; errors?: { message: string }[] };
  if (b.errors?.length) throw new Error(b.errors[0]!.message);
  return (b.data?.contract?.actions ?? [])
    .map((a) => ({
      kind: a.__typename === 'ContractCall' ? ('call' as const) : a.__typename === 'ContractDeploy' ? ('deploy' as const) : ('maintenance' as const),
      entryPoint: a.entryPoint ?? null,
      hash: a.transaction.hash,
      height: a.transaction.block.height,
      at: a.transaction.block.timestamp,
      status: a.transaction.transactionResult?.status ?? null,
    }))
    .sort((x, y) => x.height - y.height);
}

const publicData = indexerPublicDataProvider(config.indexer, config.indexerWS);
let chain: PublicView | null = null;
let history: HistoryItem[] = [];
let lastError: string | null = null;
const log: WatchEvent[] = [];
const listeners = new Set<(e: WatchEvent) => void>();

function emit(e: WatchEvent) {
  log.push(e);
  if (log.length > 300) log.shift();
  for (const l of listeners) l(e);
}

const describe = (h: HistoryItem) =>
  h.kind === 'deploy' ? 'vault deployed' : h.kind === 'maintenance' ? 'verifier key added' : `${h.entryPoint} confirmed · block ${h.height}`;

async function poll() {
  if (!address || configError) return;
  try {
    const [read, hist] = await Promise.all([publicData.queryContractState(address), fetchHistory(address)]);
    chain = publicViewOf(ledger(ledgerState(read)), address, network);
    const seen = new Set(history.map((h) => h.hash + (h.entryPoint ?? '')));
    const fresh = hist.filter((h) => !seen.has(h.hash + (h.entryPoint ?? '')));
    history = hist;
    for (const h of fresh.filter((x) => x.kind !== 'maintenance')) {
      emit({ at: h.at, kind: 'tx', circuit: h.kind === 'call' ? h.entryPoint ?? undefined : 'deploy', message: describe(h), txId: h.hash });
    }
    if (lastError) emit({ at: Date.now(), kind: 'info', message: 'indexer reachable again' });
    lastError = null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== lastError) emit({ at: Date.now(), kind: 'error', message: `indexer: ${msg}` });
    lastError = msg;
  }
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  // Everything served here is public chain data.
  res.setHeader('access-control-allow-origin', process.env['ALLOW_ORIGIN'] ?? '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': 'GET', 'access-control-max-age': '86400' });
    return res.end();
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'watch-only: this backend holds no keys and cannot act' });
  try {
    if (url.pathname === '/' || url.pathname === '/health') {
      return json(res, 200, { ok: true, network, address, synced: chain !== null, zk: zkVersion, error: configError ?? lastError });
    }
    if (url.pathname === '/api/status') return json(res, 200, { network, address, busy: null, watch: true });
    if (url.pathname === '/api/state') {
      return json(res, 200, {
        network,
        busy: null,
        watch: true,
        chain,
        devices: null,
        history,
        indexer: publicIndexer,
        error: configError ?? (address ? lastError : 'No vault address configured yet (KEEPROXY_ADDRESS)'),
        now: Math.floor(Date.now() / 1000),
      });
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      for (const e of log.slice(-60)) res.write(`data: ${JSON.stringify(e)}\n\n`);
      const on = (e: WatchEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      listeners.add(on);
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        listeners.delete(on);
        clearInterval(ping);
      });
      return;
    }
    // Public parameters (scripts/fetch-params.sh), checked by the browser too.
    const params = /^\/zk\/params\/(bls_midnight_2p\d{1,2})$/.exec(url.pathname);
    if (params) {
      const file = path.join(ZK_DIR, 'params', params[1]!);
      if (!existsSync(file)) return json(res, 404, { error: 'no such parameters' });
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': statSync(file).size,
        'cache-control': 'public, max-age=31536000, immutable',
      });
      return void createReadStream(file).pipe(res);
    }
    const zk = /^\/zk\/([0-9a-f]{64})\/(compiler|keys|zkir)\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
    if (zk) {
      if (zk[1] !== zkVersion) return json(res, 404, { error: 'unknown artifact version', version: zkVersion });
      const file = path.join(ZK_DIR, zk[2]!, zk[3]!);
      if (!existsSync(file)) return json(res, 404, { error: 'no such artifact' });
      res.writeHead(200, {
        'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        'content-length': statSync(file).size,
        'cache-control': 'public, max-age=31536000, immutable',
      });
      return void createReadStream(file).pipe(res);
    }
    const tx = /^\/api\/tx\/([0-9a-fA-F]{64})$/.exec(url.pathname);
    if (tx) {
      const r = await txReceipt(config.indexer, tx[1]!.toLowerCase());
      return r ? json(res, 200, { ...r, indexer: publicIndexer }) : json(res, 404, { error: 'The indexer has no transaction with that hash' });
    }
    return json(res, 404, { error: 'no such endpoint' });
  } catch (e) {
    return json(res, 500, { error: e instanceof Error ? e.message.replace(/project_id=[^&\s"]+/g, 'project_id=…') : String(e) });
  }
});

await poll();
setInterval(() => void poll(), POLL_MS);
server.listen(PORT, HOST, () => {
  console.log(`keeproxy-viewer on http://${HOST}:${PORT} (network: ${network}, vault: ${address ?? 'none'}, watch-only)`);
});
