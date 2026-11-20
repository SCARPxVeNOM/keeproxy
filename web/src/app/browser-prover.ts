// SPDX-License-Identifier: Apache-2.0
//
// Proves Keeproxy's circuits in this browser, so no proof server is needed for
// them. The wallet still balances each transaction and proves its own fee
// inputs with whatever prover it is configured for.
//
// Key material comes from the same pinned set the wallet path uses (the
// contract's integrity manifest), and the public parameters from the viewer,
// each checked against the hash the Midnight wallet SDK publishes for it
// (@midnightntwrk/wallet-sdk-prover-client, KeyMaterial.js), since
// srs.midnight.network does not allow cross-origin reads.

import { ZKConfigRegistry, zkConfigToProvingKeyMaterial, createLedger9ProofProvider } from '@midnight-ntwrk/midnight-js-types';
import type { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { CostModel } from '@midnight-ntwrk/midnight-js-protocol/v9';

/** SHA-256 of bls_midnight_2p<k>; Keeproxy's circuits use k = 9 to 15. */
const PARAMS: Record<number, string> = {
  9: 'b9009f1098bcefffec3c461ab3a5e3a17f7e5599f0f08c70fcdc55a89227bcbd',
  10: '46b2290933cbed4c378889e4ba971f1a92888331ffb09466acd4ff61a1e2cb42',
  11: '9901589d7956ff58be0d85569b2f455b77b58c3758026ffb5bbe4807000b96d1',
  12: 'ef08eb3fcf62df8f72c515cffa027e681808b530cb016eea104115545ef6d5c8',
  13: 'd3324910969c4cc54143b8045b649e5c3a4bd5fb7b8f85fe1b770f640ce1c803',
  14: 'fc253016885ec830e97808c9ec920bb5cab5c21af590380a6cb5eb0538e2b244',
  15: '724c7c3d779148bb113c7ee9c034b2f27db16e6bdf315fde90105a9bad00b1de',
  16: '09c877216d6589b370263e18af40a030a901b41a7a7c37ef58c9901db41f05c6',
};

const sha256 = async (b: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (x) => x.toString(16).padStart(2, '0')).join('');

export function browserProofProvider(zk: FetchZkConfigProvider<string>, paramsBase: string) {
  const registry = new ZKConfigRegistry([zk]);
  const params = new Map<number, Promise<Uint8Array>>();

  const lookupKey = async (keyLocation: string) => {
    const resolved = await registry.resolveKeyLocation(keyLocation);
    return resolved === undefined ? undefined : zkConfigToProvingKeyMaterial(resolved);
  };
  const getParams = (k: number) => {
    let p = params.get(k);
    if (!p) {
      p = (async () => {
        const expected = PARAMS[k];
        if (!expected) throw new Error(`No pinned public parameters for k = ${k}`);
        const r = await fetch(`${paramsBase}bls_midnight_2p${k}`);
        if (!r.ok) throw new Error(`Could not fetch public parameters (k = ${k}): HTTP ${r.status}`);
        const b = new Uint8Array(await r.arrayBuffer());
        if ((await sha256(b)) !== expected) throw new Error(`Public parameters for k = ${k} do not match their pinned hash`);
        return b;
      })();
      p.catch(() => params.delete(k));
      params.set(k, p);
    }
    return p;
  };

  const run = <T>(msg: { op: 'check' | 'prove'; preimage: Uint8Array; binding?: bigint }) =>
    new Promise<T>((resolve, reject) => {
      const worker = new Worker(new URL('./prover.worker.ts', import.meta.url), { type: 'module' });
      const finish = (f: () => void) => {
        worker.terminate();
        f();
      };
      worker.addEventListener('message', ({ data }: MessageEvent) => {
        if (data.op === 'ready') return worker.postMessage(msg);
        if (data.op === 'done') return finish(() => resolve(data.value as T));
        if (data.op === 'failed') return finish(() => reject(new Error(data.error)));
        const answer = data.op === 'lookupKey' ? lookupKey(data.keyLocation) : getParams(data.k);
        answer.then(
          (value) => worker.postMessage({ op: 'reply', id: data.id, value }),
          (e: unknown) => worker.postMessage({ op: 'reply', id: data.id, error: e instanceof Error ? e.message : String(e) }),
        );
      });
      worker.addEventListener('error', (e) => finish(() => reject(new Error(e.message || 'The prover worker failed'))));
    });

  const provingProvider = {
    check: (preimage: Uint8Array, _keyLocation: string) => run<(bigint | undefined)[]>({ op: 'check', preimage }),
    prove: (preimage: Uint8Array, _keyLocation: string, binding?: bigint) => run<Uint8Array>({ op: 'prove', preimage, binding }),
    lookupKey,
  };
  return createLedger9ProofProvider(provingProvider as Parameters<typeof createLedger9ProofProvider>[0], CostModel.initialCostModel());
}
