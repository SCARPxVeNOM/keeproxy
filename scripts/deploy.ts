// SPDX-License-Identifier: Apache-2.0
//
// Deploys a Keeproxy vault (staged) and records it in deployments/<network>.json.
//
//   MIDNIGHT_NETWORK=local   npm run deploy
//   MIDNIGHT_NETWORK=preprod npm run deploy     # needs .env.preprod (see .env.preprod.example)
//
// The owner secret and the contract's maintenance key stay in the encrypted
// private-state store; only public facts are written to the deployments file.

import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import pino from 'pino';
import { type EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import { getConfig } from '../src/config.js';
import { startWallet } from '../src/wallet.js';
import { buildProviders } from '../src/providers.js';
import { deployStaged } from '../src/staged-deploy.js';
import { zkConfigPath } from '../contract/index.js';

// @ts-expect-error WebSocket global for the indexer's GraphQL subscriptions
globalThis.WebSocket = WebSocket;

const network = process.env['MIDNIGHT_NETWORK'] ?? 'local';
if (network !== 'local') {
  const { loadEnv } = await import('vite');
  Object.assign(process.env, { ...loadEnv(network, process.cwd(), ''), ...process.env });
}
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

const threshold = BigInt(process.env['KEEPROXY_THRESHOLD'] ?? 2);
const inactivity = BigInt(process.env['KEEPROXY_INACTIVITY'] ?? 180 * 86_400);
const veto = BigInt(process.env['KEEPROXY_VETO'] ?? 3 * 86_400);

const wallet = await startWallet(logger, env, {
  network,
  role: 'ALICE',
  faucet: config.faucet,
  syncTimeoutMs: network === 'local' ? 10 * 60_000 : 60 * 60_000,
});
try {
  const providers = buildProviders(wallet, zkConfigPath, config, { storeName: `keeproxy-deploy-${network}` });
  const ownerSecret = new Uint8Array(randomBytes(32));
  const vaultId = new Uint8Array(randomBytes(32));
  const r = await deployStaged(providers, {
    assets: zkConfigPath,
    privateStateId: 'owner',
    initialPrivateState: { ownerSecret },
    args: [vaultId, threshold, inactivity, veto, BigInt(Math.floor(Date.now() / 1000) - 30)],
    onProgress: ({ stage, circuit, index, total }) => logger.info(`tx ${index}/${total} ${stage}${circuit ? ` ${circuit}` : ''}`),
  });
  mkdirSync('deployments', { recursive: true });
  const out = {
    network,
    contractAddress: r.contractAddress,
    deployTx: r.deployTxId,
    verifierKeyInserts: r.insertedCircuits,
    rules: { threshold: threshold.toString(), inactivitySeconds: inactivity.toString(), vetoSeconds: veto.toString() },
    compactc: '0.36.1',
    deployedAt: new Date().toISOString(),
  };
  writeFileSync(`deployments/${network}.json`, JSON.stringify(out, null, 2));
  logger.info(`Deployed ${r.contractAddress} → deployments/${network}.json`);
  // The owner secret is the only way to act as owner. It goes to a gitignored
  // file, never to the log; move it somewhere safe.
  mkdirSync(`.keeproxy/${network}`, { recursive: true });
  const secretFile = `.keeproxy/${network}/owner-secret-${r.contractAddress.slice(0, 12)}.hex`;
  writeFileSync(secretFile, Buffer.from(ownerSecret).toString('hex'), { mode: 0o600 });
  logger.info(`Owner secret written to ${secretFile} (gitignored). Back it up.`);
} finally {
  await wallet.stop();
}
