// SPDX-License-Identifier: Apache-2.0
//
// A receipt for one transaction, built from the indexer rather than from
// anything keeproxyd remembers: which block included it, whether it
// succeeded, which circuit it called on which contract, and the
// zero-knowledge proof bytes the node verified before accepting it.

import { ContractCall, ContractDeploy, Transaction, type Binding, type Proof, type SignatureEnabled } from '@midnightntwrk/ledger-v9';

export interface TxReceipt {
  hash: string;
  status: string;
  block: { height: number; hash: string; timestamp: number };
  fee: string;
  protocolVersion: number;
  rawBytes: number;
  calls: { kind: 'call' | 'deploy' | 'maintenance'; address: string; entryPoint?: string; proofBytes?: number; proofHead?: string }[];
  outputs: { value: string; owner: string }[];
  indexer: string;
}

const QUERY = `query($hash: HexEncoded!) {
  transactions(offset: { hash: $hash }) {
    hash
    protocolVersion
    raw
    ... on RegularTransaction {
      fee
      transactionResult { status }
      block { height hash timestamp }
      unshieldedCreatedOutputs { value owner }
    }
  }
}`;

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export async function txReceipt(indexer: string, hash: string): Promise<TxReceipt | null> {
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error('Not a transaction hash');
  const r = await fetch(indexer, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { hash } }),
  });
  const body = (await r.json()) as {
    data?: { transactions: Array<{
      hash: string; protocolVersion: number; raw: string; fee?: string;
      transactionResult?: { status: string };
      block?: { height: number; hash: string; timestamp: number };
      unshieldedCreatedOutputs?: { value: string; owner: string }[];
    }> };
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new Error(body.errors[0]!.message);
  const t = body.data?.transactions[0];
  if (!t) return null;

  const raw = Buffer.from(t.raw, 'hex');
  const calls: TxReceipt['calls'] = [];
  // Deserialising with the 'proof' marker only succeeds if the transaction
  // carries real proofs, not proof-erased placeholders.
  const tx = Transaction.deserialize<SignatureEnabled, Proof, Binding>('signature', 'proof', 'binding', raw);
  for (const intent of tx.intents?.values() ?? []) {
    for (const a of intent.actions) {
      if (a instanceof ContractCall) {
        const proof = a.proof.serialize();
        calls.push({
          kind: 'call',
          address: String(a.address),
          entryPoint: typeof a.entryPoint === 'string' ? a.entryPoint : new TextDecoder().decode(a.entryPoint),
          proofBytes: proof.length,
          proofHead: hex(proof.slice(0, 24)),
        });
      } else if (a instanceof ContractDeploy) {
        calls.push({ kind: 'deploy', address: String(a.address) });
      } else {
        calls.push({ kind: 'maintenance', address: String((a as { address?: unknown }).address ?? '') });
      }
    }
  }

  return {
    hash: t.hash,
    status: t.transactionResult?.status ?? 'UNKNOWN',
    block: t.block ?? { height: 0, hash: '', timestamp: 0 },
    fee: t.fee ?? '0',
    protocolVersion: t.protocolVersion,
    rawBytes: raw.length,
    calls,
    outputs: t.unshieldedCreatedOutputs ?? [],
    indexer,
  };
}
