// SPDX-License-Identifier: Apache-2.0
//
// Staged deployment.
//
// A Midnight block caps how many bytes one transaction may write, and a
// deploy that carries all 13 of Keeproxy's verifier keys is refused with
// "Transaction would exhaust the block limits". So the deploy transaction
// carries the constructor and the first few keys, and one VerifierKeyInsert
// maintenance transaction per remaining circuit adds the rest. The deployer
// can do that because deployContract made it the contract's maintenance
// authority (its signing key sits in the private-state store).
//
// Technique credit: the Stock & Foil team documented the same limit in the
// Midnight Buildathon (their sdk/src/backend/network.ts).

import {
  createCircuitMaintenanceTxInterfaces,
  deployContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-js';
import { type ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { CompiledKeeproxyContract, Contract, witnesses, zkConfigPath, type KeeproxyPrivateState } from '../contract/index.js';
import { type KeeproxyProviders } from './providers.js';

/** Every provable circuit, in deploy order: the ones a fresh vault needs first come first. */
export const CIRCUIT_IDS = Object.keys(new Contract(witnesses).provableCircuits);

const FIRST = ['enroll', 'deposit', 'heartbeat', 'withdraw'];
export const DEFAULT_KEYS_PER_TX = 4;

/**
 * A Contract whose deploy carries only some entry points. Ledger 9 refuses a
 * deploy with a blank verifier-key slot (VerifierKeyNotSet, custom error 110),
 * so the deferred entry points are dropped from the constructor's state
 * altogether rather than left blank; VerifierKeyInsert adds them later.
 */
function subsetContract(keep: ReadonlySet<string>) {
  return class SubsetKeeproxy extends Contract<KeeproxyPrivateState> {
    constructor(w: typeof witnesses) {
      super(w);
      this.provableCircuits = Object.fromEntries(
        Object.entries(this.provableCircuits).filter(([id]) => keep.has(id)),
      ) as typeof this.provableCircuits;
    }

    override async initialState(...a: Parameters<Contract<KeeproxyPrivateState>['initialState']>) {
      const result = await super.initialState(...a);
      const full = result.currentContractState;
      // Same WASM instance as the original, so the state stays usable downstream.
      const State = full.constructor as new () => typeof full;
      const trimmed = new State();
      trimmed.data = full.data;
      trimmed.balance = full.balance;
      for (const op of full.operations()) {
        const id = typeof op === 'string' ? op : new TextDecoder().decode(op);
        if (keep.has(id)) trimmed.setOperation(op, full.operation(op)!);
      }
      return { ...result, currentContractState: trimmed };
    }
  };
}

export interface StagedDeployOptions {
  privateStateId: string;
  initialPrivateState: KeeproxyPrivateState;
  args: [Uint8Array, bigint, bigint, bigint, bigint];
  keysPerTx?: number;
  onProgress?: (step: { stage: 'deploy' | 'verifier-key'; circuit?: string; index: number; total: number }) => void;
}

export interface StagedDeployResult {
  contractAddress: ContractAddress;
  deployTxId?: string;
  insertedCircuits: string[];
}

export async function deployStaged(providers: KeeproxyProviders, opts: StagedDeployOptions): Promise<StagedDeployResult> {
  const perTx = Math.max(1, opts.keysPerTx ?? DEFAULT_KEYS_PER_TX);
  const ordered = [...FIRST.filter((c) => CIRCUIT_IDS.includes(c)), ...CIRCUIT_IDS.filter((c) => !FIRST.includes(c))];
  const first = ordered.slice(0, perTx);
  const rest = ordered.slice(first.length);
  const total = 1 + rest.length;
  const progress = opts.onProgress ?? (() => {});

  const Subset = subsetContract(new Set(first));
  const compiledSubset = CompiledContract.make('KeeproxyContract', Subset).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );

  progress({ stage: 'deploy', index: 1, total });
  const deployed = (await deployContract(providers, {
    compiledContract: compiledSubset,
    privateStateId: opts.privateStateId,
    initialPrivateState: opts.initialPrivateState,
    args: opts.args,
  } as never)) as unknown as { deployTxData: { public: { contractAddress: ContractAddress; txId?: string } } };
  const { contractAddress, txId } = deployed.deployTxData.public;

  const maintenance = createCircuitMaintenanceTxInterfaces(
    providers as never,
    CompiledKeeproxyContract as never,
    contractAddress,
  ) as unknown as Record<string, { insertVerifierKey(key: Uint8Array): Promise<unknown> }>;

  const inserted: string[] = [];
  for (const [i, circuit] of rest.entries()) {
    progress({ stage: 'verifier-key', circuit, index: i + 2, total });
    const key = await providers.zkConfigProvider.getVerifierKey(circuit as never);
    await maintenance[circuit]!.insertVerifierKey(key as Uint8Array);
    inserted.push(circuit);
  }
  return { contractAddress, deployTxId: txId, insertedCircuits: inserted };
}
