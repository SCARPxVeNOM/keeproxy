// SPDX-License-Identifier: Apache-2.0
//
// Off-chain halves of the Keeproxy circuits. Every secret below lives only in
// the private state of the device that holds the role; the contract sees
// hashes, commitments and Merkle roots.
//
// This file runs in the browser too (the web app proves locally), so it must
// not import node:* modules.

import type { Ledger, Mandate, Witnesses } from './managed/proxy/contract/index.js';

/**
 * One device's view of the vault. A device usually holds one role (the owner's
 * laptop, the agent's runtime, a guardian's phone, an heir's wallet), but
 * nothing stops one person holding several.
 */
export type KeeproxyPrivateState = {
  readonly ownerSecret?: Uint8Array;
  readonly agentSecret?: Uint8Array;
  readonly mandate?: Mandate;
  readonly guardianSecret?: Uint8Array;
  readonly heirSecret?: Uint8Array;
  readonly heirShareBps?: bigint;
};

export const emptyPrivateState = (): KeeproxyPrivateState => ({});

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`This device holds no ${what}`);
  return value;
};

type Tree = Ledger['guardians'];
const pathIn = (tree: Tree, leaf: Uint8Array, what: string) => {
  const path = tree.findPathForLeaf(leaf);
  if (path === undefined) throw new Error(`${what} is not enrolled in this vault`);
  return path;
};

export const witnesses: Witnesses<KeeproxyPrivateState> = {
  ownerSecret: ({ privateState }) => [privateState, need(privateState.ownerSecret, 'owner secret')],
  agentSecret: ({ privateState }) => [privateState, need(privateState.agentSecret, 'agent secret')],
  guardianSecret: ({ privateState }) => [privateState, need(privateState.guardianSecret, 'guardian secret')],
  heirSecret: ({ privateState }) => [privateState, need(privateState.heirSecret, 'heir secret')],
  activeMandate: ({ privateState }) => [privateState, need(privateState.mandate, 'mandate')],
  heirShareBps: ({ privateState }) => [privateState, need(privateState.heirShareBps, 'heir share')],

  // Paths are looked up in the ledger state the circuit runs against, so they
  // match the root the circuit checks.
  guardianPath: ({ privateState, ledger }, leaf) => [privateState, pathIn(ledger.guardians, leaf, 'Guardian')],
  heirPath: ({ privateState, ledger }, leaf) => [privateState, pathIn(ledger.heirs, leaf, 'Heir')],
  mandatePath: ({ privateState, ledger }, leaf) => [privateState, pathIn(ledger.mandates, leaf, 'Mandate')],
  payeePath: ({ privateState, ledger }, leaf) => [privateState, pathIn(ledger.payees, leaf, 'Recipient')],

  // Division is cheap off chain; the circuit checks the result by multiplying.
  epochIndexOf: ({ privateState }, now, epochSeconds) => [privateState, now / epochSeconds],
  shareOf: ({ privateState }, estate, bps) => [privateState, (estate * bps) / 10_000n],
};

export type { Ledger, Mandate, Witnesses };
