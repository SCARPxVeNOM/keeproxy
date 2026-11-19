// SPDX-License-Identifier: Apache-2.0
//
// Where a chain's dust event timeline crosses into ledger 9, so a fresh wallet
// can start its dust sync there instead of replaying the ledger-8 history (two
// million events on preprod, about two days at replay speed).
//
// The wallet SDK has the same search behind `skipLedgerV8DustHistory`, but
// against Blockfrost it comes back empty and the wallet silently replays
// everything. This one runs every probe over a single connection, retries, and
// caches the answer: the boundary of a chain never moves.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

/** Protocol version a ledger-9 node line reports (wallet-sdk's V9NativeForkVersion). */
export const V9_BOUNDARY = 2_000_000n;

export interface DustStart {
  /** The last dust event below the boundary: the cursor the V2 variant starts after. */
  cursor: bigint;
  /** The version of the first dust event at or past the boundary. */
  version: bigint;
}

interface Probe {
  id: number;
  maxId: number;
  version: bigint;
}

/** Opens one graphql-transport-ws connection and answers "first dust event from id" probes over it. */
async function connect(wsUrl: string) {
  const ws = new WebSocket(wsUrl, 'graphql-transport-ws');
  await new Promise<void>((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
    ws.on('message', function ack(m) {
      if ((JSON.parse(String(m)) as { type: string }).type === 'connection_ack') {
        ws.off('message', ack);
        resolve();
      }
    });
  });
  let seq = 0;
  const firstFrom = (id: number | null, timeoutMs = 10_000) =>
    new Promise<Probe>((resolve, reject) => {
      const sub = String(++seq);
      const timer = setTimeout(() => done(new Error(`no dust event from ${id} within ${timeoutMs}ms`)), timeoutMs);
      const onMessage = (m: unknown) => {
        const j = JSON.parse(String(m)) as {
          id?: string;
          type: string;
          payload?: { data?: { dustLedgerEvents?: { id: number; maxId: number; protocolVersion: number } } };
        };
        if (j.id !== sub) return;
        const e = j.payload?.data?.dustLedgerEvents;
        if (j.type === 'next' && e) done(null, { id: e.id, maxId: e.maxId, version: BigInt(e.protocolVersion) });
        else if (j.type === 'error' || j.type === 'complete') done(new Error(`dust events at ${id}: ${JSON.stringify(j.payload)}`));
      };
      const done = (err: Error | null, p?: Probe) => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: sub, type: 'complete' }));
        if (err) reject(err);
        else resolve(p!);
      };
      ws.on('message', onMessage);
      ws.send(
        JSON.stringify({
          id: sub,
          type: 'subscribe',
          payload: {
            query: 'subscription ($id: Int) { dustLedgerEvents(id: $id) { id maxId protocolVersion } }',
            variables: { id },
          },
        }),
      );
    });
  return { firstFrom, close: () => ws.close() };
}

/** Searches the timeline. Nothing if it starts at or past the boundary, or has not reached it. */
export async function searchDustStart(indexerWs: string, boundary = V9_BOUNDARY): Promise<DustStart | null> {
  const c = await connect(indexerWs);
  const probe = async (id: number | null): Promise<Probe> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await c.firstFrom(id);
      } catch (e) {
        if (attempt >= 3) throw e;
      }
    }
  };
  try {
    const first = await probe(null);
    const last = await probe(first.maxId);
    if (first.version >= boundary || last.version < boundary) return null;
    // Same invariant as the SDK's narrowToBoundary: every event below `low` is
    // under the boundary, `low - 1` is one of them, `atHigh` is not.
    let low = first.id + 1;
    let high = last.id;
    let atHigh = last;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const p = await probe(middle);
      if (p.version >= boundary) {
        high = middle;
        atHigh = p;
      } else {
        low = p.id + 1;
      }
    }
    return { cursor: BigInt(low - 1), version: atHigh.version };
  } finally {
    c.close();
  }
}

/** The search, cached per network under the gitignored .wallet-state/. */
export async function dustStart(networkId: string, indexerWs: string): Promise<DustStart | null> {
  const file = path.resolve('.wallet-state', `dust-boundary-${networkId}.json`);
  if (existsSync(file)) {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { cursor: string; version: string };
    return { cursor: BigInt(j.cursor), version: BigInt(j.version) };
  }
  const found = await searchDustStart(indexerWs);
  if (found) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ cursor: found.cursor.toString(), version: found.version.toString() }, null, 2));
  }
  return found;
}
