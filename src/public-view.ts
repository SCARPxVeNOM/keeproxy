// SPDX-License-Identifier: Apache-2.0
//
// "What the chain sees": a vault's public ledger, exactly what any indexer
// user can read, made JSON-safe. Shared by keeproxyd and the read-only viewer.

import { Phase, type Ledger } from '../contract/index.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export type PublicView = ReturnType<typeof publicViewOf>;

export function publicViewOf(l: Ledger, address: string, network: string) {
  return {
    address,
    network,
    phase: Phase[l.phase] as 'ACTIVE' | 'RECOVERING' | 'INHERITED',
    vaultId: hex(l.vaultId),
    threshold: Number(l.threshold),
    inactivitySeconds: Number(l.inactivitySeconds),
    vetoSeconds: Number(l.vetoSeconds),
    ownerKey: hex(l.ownerKey),
    ownerRotations: Number(l.ownerRotations),
    lastSeen: Number(l.lastSeen),
    balance: l.balance.toString(),
    guardianCount: Number(l.guardianCount),
    guardianRoot: l.guardians.root().field.toString(16),
    heirRoot: l.heirs.root().field.toString(16),
    mandateRoot: l.mandates.root().field.toString(16),
    payeeRoot: l.payees.root().field.toString(16),
    mandateGeneration: Number(l.mandateGeneration),
    epochSpend: [...l.epochSpend].map(([k, v]) => ({ key: hex(k), spent: v.toString() })),
    recoveryRound: Number(l.recoveryRound),
    pendingOwner: hex(l.pendingOwner),
    pendingDeviceKey: hex(l.pendingDeviceKey),
    recoveryOpenedAt: Number(l.recoveryOpenedAt),
    approvals: Number(l.approvals),
    approvalNullifiers: [...l.approvalNullifiers].map(hex),
    restoredRound: Number(l.restoredRound),
    backupDigest: hex(l.backupDigest),
    backupVersion: Number(l.backupVersion),
    releasedShares: [...l.releasedShares].map(([k, v]) => ({ nullifier: hex(k), bytes: v.length })),
    estate: l.estate.toString(),
    estatePaid: l.estatePaid.toString(),
    heirClaims: [...l.heirClaims].map(hex),
  };
}
