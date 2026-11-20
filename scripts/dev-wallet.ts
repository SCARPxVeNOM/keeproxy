// SPDX-License-Identifier: Apache-2.0
//
// A local stand-in for a browser wallet, for testing the wallet app (#/app)
// without waiting for a browser wallet to sync.
//
//   MIDNIGHT_NETWORK=preprod npm run dev-wallet          # http://127.0.0.1:8799
//   open http://localhost:4173/?devwallet=8799#/app
//
// It runs the ALICE wallet from .env.<network> (its synced state is cached in
// .wallet-state/) and answers the calls a DApp Connector wallet would:
// configuration, addresses, balances, balancing and submitting transactions,
// and proving through the local proof server. web/src/app/dev-wallet.ts
// registers it in the page as window.midnight['keeproxy-dev'].
//
// It signs anything the page sends it, with no approval step: it binds to
// 127.0.0.1, answers only localhost origins, and is for test networks only.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import pino from 'pino';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';
import { type EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import { Transaction, type FinalizedTransaction } from '@midnight-ntwrk/midnight-js-protocol/v9';
import {
  MidnightBech32m,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from '@midnightntwrk/wallet-sdk-address-format';
import { getConfig } from '../src/config.js';
import { startWallet } from '../src/wallet.js';

// @ts-expect-error WebSocket global for the indexer's GraphQL subscriptions
globalThis.WebSocket ??= WebSocket;

const network = process.env['MIDNIGHT_NETWORK'] ?? 'local';
if (network === 'mainnet') throw new Error('The dev wallet signs without asking: test networks only');
if (network !== 'local') {
  const { loadEnv } = await import('vite');
  Object.assign(process.env, { ...loadEnv(network, process.cwd(), ''), ...process.env });
}
const PORT = Number(process.env['DEV_WALLET_PORT'] ?? 8799);
const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });
const config = getConfig();
const env: EnvironmentConfiguration = {
  walletNetworkId: config.networkId,
  networkId: config.networkId,
  indexer: config.indexer,
  indexerWS: config.indexerWS,
  node: config.node,
  nodeWS: config.nodeWS,
  faucet: config.faucet,
  proofServer: config.proofServer,
};

const w = await startWallet(logger, env, {
  network,
  role: 'ALICE',
  faucet: config.faucet,
  syncTimeoutMs: network === 'local' ? 10 * 60_000 : 60 * 60_000,
});

const id = config.networkId;
const unshielded = MidnightBech32m.encode(id, await w.wallet.unshielded.getAddress()).asString();
const addresses = {
  shieldedAddress: MidnightBech32m.encode(id, w.getShieldedAddress()).asString(),
  shieldedCoinPublicKey: ShieldedCoinPublicKey.codec.encode(id, ShieldedCoinPublicKey.fromHexString(w.getCoinPublicKey())).asString(),
  shieldedEncryptionPublicKey: ShieldedEncryptionPublicKey.codec
    .encode(id, ShieldedEncryptionPublicKey.fromHexString(w.getEncryptionPublicKey()))
    .asString(),
};

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const localOrigin = (o: string | undefined) => !o || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o);

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const json = (res: ServerResponse, status: number, v: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
};

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!localOrigin(origin)) return json(res, 403, { error: 'localhost origins only' });
  if (origin) res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname === '/info') {
      return json(res, 200, {
        name: `Keeproxy dev wallet (${network})`,
        networkId: id,
        configuration: { indexerUri: config.indexer, indexerWsUri: config.indexerWS, substrateNodeUri: config.node, networkId: id },
        unshieldedAddress: unshielded,
        ...addresses,
      });
    }
    if (url.pathname === '/balances') {
      const s = await Rx.firstValueFrom(w.wallet.state());
      const dust = s.dust.balance(new Date());
      return json(res, 200, { unshielded: s.unshielded.balances, shielded: s.shielded.balances, dust, dustCap: dust });
    }
    if (url.pathname === '/balance' && req.method === 'POST') {
      const { tx } = JSON.parse((await body(req)).toString('utf8')) as { tx: string };
      const unbound = Transaction.deserialize('signature', 'proof', 'pre-binding', fromHex(tx)) as Parameters<typeof w.balanceUnbound>[0];
      logger.info('balancing a transaction for the page');
      const finalized = await w.balanceUnbound(unbound);
      return json(res, 200, { tx: toHex(finalized.serialize()) });
    }
    if (url.pathname === '/submit' && req.method === 'POST') {
      const { tx } = JSON.parse((await body(req)).toString('utf8')) as { tx: string };
      const finalized = Transaction.deserialize('signature', 'proof', 'binding', fromHex(tx)) as FinalizedTransaction;
      const txId = await w.submitTx(finalized);
      logger.info(`submitted ${txId}`);
      return json(res, 200, { txId });
    }
    // Proving: pass the page's proof-server requests through to the local one.
    if (url.pathname.startsWith('/prover/') && req.method === 'POST') {
      const r = await fetch(new URL(url.pathname.slice('/prover'.length), config.proofServer), {
        method: 'POST',
        body: await body(req),
        headers: { 'content-type': req.headers['content-type'] ?? 'application/octet-stream' },
      });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream' });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    return json(res, 404, { error: 'no such endpoint' });
  } catch (e) {
    logger.error(e);
    return json(res, 500, { error: e instanceof Error ? e.message.replace(/project_id=[^&\s"]+/g, 'project_id=…') : String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => logger.info(`dev wallet on http://127.0.0.1:${PORT} (${network}, ${unshielded})`));
const stop = async () => {
  server.close();
  await w.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
