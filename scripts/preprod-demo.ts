// SPDX-License-Identifier: Apache-2.0
//
// Puts a deployed vault through its paces on a public network, so the hosted
// console has real history to show. The first run adopts the vault from
// deployments/<network>.json with the owner secret `npm run deploy` wrote,
// and enrolls guardians, heirs, an agent mandate and a payee.
//
//   MIDNIGHT_NETWORK=preprod npm run demo                     # the default steps
//   MIDNIGHT_NETWORK=preprod npm run demo -- heartbeat backup # just these
//
// Every step is one VaultService action; refusals are expected for some
// (an over-cap or off-allowlist agent payment) and are proved locally, so they
// never reach the chain.

import { existsSync, readFileSync } from 'node:fs';
import { VaultService } from '../src/vault-service.js';

const network = process.env['MIDNIGHT_NETWORK'] ?? 'local';
if (network !== 'local') {
  const { loadEnv } = await import('vite');
  Object.assign(process.env, { ...loadEnv(network, process.cwd(), ''), ...process.env });
}

const STEPS: Record<string, [action: string, params?: Record<string, unknown>]> = {
  agentPay: ['agentPay', { recipient: 'payee', amount: 50 }],
  overCap: ['agentPay', { recipient: 'payee', amount: 500 }],
  stranger: ['agentPay', { recipient: 'stranger', amount: 20 }],
  heartbeat: ['heartbeat'],
  backup: ['backup'],
  deposit: ['deposit', { amount: 250 }],
  withdraw: ['withdraw', { amount: 100 }],
  revoke: ['revokeMandates'],
};
const DEFAULT = ['agentPay', 'overCap', 'stranger', 'heartbeat', 'backup', 'deposit'];

const steps = process.argv.slice(2);
for (const s of steps) if (!STEPS[s]) throw new Error(`Unknown step '${s}'. Known: ${Object.keys(STEPS).join(', ')}`);

const svc = await VaultService.start({ network });
svc.on('event', (e: { kind: string; device?: string; message: string; txId?: string }) =>
  console.log(`[${e.kind}]${e.device ? ` ${e.device}:` : ''} ${e.message}${e.txId ? ` (${e.txId})` : ''}`),
);
try {
  if (!svc.address) {
    const dep = JSON.parse(readFileSync(`deployments/${network}.json`, 'utf8')) as { contractAddress: string };
    const secretFile = `.keeproxy/${network}/owner-secret-${dep.contractAddress.slice(0, 12)}.hex`;
    if (!existsSync(secretFile)) throw new Error(`No owner secret at ${secretFile}`);
    const r = await svc.adoptVault(dep.contractAddress, new Uint8Array(Buffer.from(readFileSync(secretFile, 'utf8').trim(), 'hex')));
    if (!r.ok) throw new Error(`Adopting the vault failed: ${r.error}`);
  }
  for (const s of steps.length > 0 ? steps : DEFAULT) {
    const [action, params] = STEPS[s]!;
    const r = await svc.act(action, params);
    console.log(`${s}: ${r.ok ? 'ok' : `refused (${r.error})`}`);
  }
} finally {
  await svc.stop();
}
