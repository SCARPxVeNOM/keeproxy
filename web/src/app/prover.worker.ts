// SPDX-License-Identifier: Apache-2.0
//
// Proves one circuit with the ZKIR v3 WASM prover, off the page's main thread.
// The worker holds no key material: each key and parameter lookup is asked of
// the page, which fetches it and checks it against the hashes the build pins.
//
//   worker → page   { op: 'ready' }   once the WASM has loaded; earlier
//                                      messages would be lost
//   page → worker   { op: 'check' | 'prove', preimage, binding? }
//   worker → page   { op: 'lookupKey', id, keyLocation } | { op: 'getParams', id, k }
//   page → worker   { op: 'reply', id, value } | { op: 'reply', id, error }
//   worker → page   { op: 'done', value } | { op: 'failed', error }

import { check, prove } from '@midnightntwrk/zkir-v3';

type Pending = { resolve: (v: never) => void; reject: (e: Error) => void };
const pending = new Map<number, Pending>();
let next = 0;

const ask = <T>(msg: { op: 'lookupKey'; keyLocation: string } | { op: 'getParams'; k: number }): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve: resolve as (v: never) => void, reject });
    postMessage({ ...msg, id });
  });

const keyMaterial = {
  lookupKey: (keyLocation: string) => ask<{ proverKey: Uint8Array; verifierKey: Uint8Array; ir: Uint8Array } | undefined>({ op: 'lookupKey', keyLocation }),
  getParams: (k: number) => ask<Uint8Array>({ op: 'getParams', k }),
};

addEventListener('message', ({ data }: MessageEvent) => {
  if (data.op === 'reply') {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) p?.reject(new Error(data.error));
    else p?.resolve(data.value as never);
    return;
  }
  const run = data.op === 'check' ? check(data.preimage, keyMaterial) : prove(data.preimage, keyMaterial, data.binding);
  run.then(
    (value: unknown) => postMessage({ op: 'done', value }),
    (e: unknown) => postMessage({ op: 'failed', error: e instanceof Error ? e.message : String(e) }),
  );
});

postMessage({ op: 'ready' });
