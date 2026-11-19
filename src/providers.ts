// SPDX-License-Identifier: Apache-2.0
// Adapted from examples/private-tip-jar/src/providers.ts in
// midnightntwrk/midnight-examples (Apache-2.0).
//
// One provider set per (wallet, role). Each set gets its own private-state
// store, which is exactly the point of Keeproxy: the owner's laptop, the
// agent's runtime, a guardian's phone and an heir's wallet each hold only
// their own secrets.

import {
  createLedger9MidnightProvider,
  createLedger9WalletProvider,
  type MidnightProviders,
  type ContractStateRead,
} from '@midnight-ntwrk/midnight-js-types';
import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { type MidnightWalletProvider } from './wallet.js';
import { type NetworkConfig } from './config.js';
import { type ImpureCircuits } from '../contract/index.js';

export type KeeproxyCircuits = keyof ImpureCircuits<unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type KeeproxyProviders = MidnightProviders<any>;

const TX_TTL_SECONDS = Number(process.env['MIDNIGHT_TX_TTL_SECONDS'] ?? 3600);

export interface ProviderOptions {
  /** Name of the private-state store (one per device/role). */
  storeName?: string;
  /** Password for the encrypted private-state store. */
  password?: string;
}

export function buildProviders(
  wallet: MidnightWalletProvider,
  zkConfigPath: string,
  config: NetworkConfig,
  opts: ProviderOptions = {},
): KeeproxyProviders {
  const zkConfigProvider = new NodeZkConfigProvider<KeeproxyCircuits>(zkConfigPath);
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: opts.storeName ?? `keeproxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      privateStoragePasswordProvider: () =>
        opts.password ?? process.env['KEEPROXY_STATE_PASSWORD'] ?? 'Keeproxy-Local-Dev-Password!1',
      accountId: wallet.getCoinPublicKey(),
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
    walletProvider: createLedger9WalletProvider(wallet),
    midnightProvider: createLedger9MidnightProvider((tx) => wallet.submitTx(tx)),
    config: { networkId: config.networkId, ttlSeconds: TX_TTL_SECONDS },
  };
}

/** Decodes a contract state read from the indexer (ledger 9). */
export function ledgerState(read: ContractStateRead | null) {
  if (read === null) throw new Error('contract state not found');
  if (read.contractState.era !== 'v9') throw new Error('expected a ledger 9 contract state');
  return read.contractState.deserialize({ v9: ContractState }).data;
}
