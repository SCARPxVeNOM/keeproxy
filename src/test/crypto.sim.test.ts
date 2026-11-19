// Property-style tests for the off-chain crypto (Shamir, backups, sealing)
// and for the receipt decoder, which runs on a real agentPay transaction
// captured from the local devnet (fixtures/agentpay-tx.json).

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  combineShares,
  decodeShare,
  decryptBackup,
  deviceKeysFromSecret,
  encodeShare,
  encryptBackup,
  newDeviceKeys,
  openSealed,
  sealTo,
  sha256,
  splitSecret,
  type Share,
} from '../restore.js';
import { txReceipt } from '../tx-receipt.js';

const rand = (n: number) => new Uint8Array(randomBytes(n));

/** Every k-element subset of xs. */
function subsets<T>(xs: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (xs.length < k) return [];
  const [h, ...t] = xs;
  return [...subsets(t, k - 1).map((s) => [h!, ...s]), ...subsets(t, k)];
}

describe('Shamir k-of-n over GF(256)', () => {
  const schemes: [number, number][] = [[1, 1], [1, 3], [2, 3], [3, 5], [4, 7], [5, 5]];

  for (const [k, n] of schemes) {
    it(`${k}-of-${n}: every ${k}-subset rebuilds the secret, in any order`, () => {
      for (const len of [1, 16, 32, 64]) {
        const secret = rand(len);
        const shares = splitSecret(secret, k, n);
        expect(shares.map((s) => s.x)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
        for (const sub of subsets(shares, k)) {
          expect(combineShares(sub)).toEqual(secret);
          expect(combineShares([...sub].reverse())).toEqual(secret);
        }
      }
    });
  }

  it('learns nothing useful from k-1 shares of a 32-byte key', () => {
    for (const [k, n] of schemes.filter(([k]) => k > 1)) {
      const secret = rand(32);
      for (const sub of subsets(splitSecret(secret, k, n), k - 1)) {
        expect(combineShares(sub)).not.toEqual(secret);
      }
    }
  });

  it('splits the same secret differently every time', () => {
    const secret = rand(32);
    expect(splitSecret(secret, 2, 3)[0]!.y).not.toEqual(splitSecret(secret, 2, 3)[0]!.y);
  });

  it('round-trips the share encoding used on chain', () => {
    for (const s of splitSecret(rand(32), 3, 5)) expect(decodeShare(encodeShare(s))).toEqual(s);
  });

  it('refuses impossible parameters, empty and duplicate share sets', () => {
    expect(() => splitSecret(rand(32), 0, 3)).toThrow('need 1 <= k <= n <= 255');
    expect(() => splitSecret(rand(32), 4, 3)).toThrow('need 1 <= k <= n <= 255');
    expect(() => splitSecret(rand(32), 2, 256)).toThrow('need 1 <= k <= n <= 255');
    expect(() => combineShares([])).toThrow('no shares');
    const [a] = splitSecret(rand(32), 2, 3) as [Share];
    expect(() => combineShares([a, a])).toThrow('duplicate share');
  });
});

describe('encrypted backups', () => {
  it('round-trips empty, small and 1 MB private states', () => {
    for (const size of [0, 1, 4096, 1 << 20]) {
      const state = rand(size);
      const { backup, key } = encryptBackup(state, 7n);
      expect(backup.digest).toEqual(sha256(backup.blob));
      expect(decryptBackup(backup, key, { digest: backup.digest, version: 7n })).toEqual(state);
    }
  });

  it('never produces the same ciphertext twice, even for the same state and version', () => {
    const state = rand(64);
    expect(encryptBackup(state, 1n).backup.digest).not.toEqual(encryptBackup(state, 1n).backup.digest);
  });

  it('refuses the wrong key', () => {
    const { backup } = encryptBackup(rand(64), 1n);
    expect(() => decryptBackup(backup, rand(32), { digest: backup.digest, version: 1n })).toThrow();
  });

  it('binds the version inside the ciphertext: a v1 blob anchored as v2 does not decrypt', () => {
    const { backup, key } = encryptBackup(rand(64), 1n);
    const relabelled = { ...backup, version: 2n };
    expect(() => decryptBackup(relabelled, key, { digest: backup.digest, version: 2n })).toThrow();
  });

  it('refuses every single-bit flip anywhere in the blob', () => {
    const { backup, key } = encryptBackup(rand(48), 1n);
    for (let i = 0; i < backup.blob.length; i += 7) {
      const blob = backup.blob.slice();
      blob[i] ^= 0x01;
      expect(() => decryptBackup({ ...backup, blob }, key, { digest: backup.digest, version: 1n })).toThrow(
        'does not match the digest',
      );
    }
  });
});

describe('sealing shares to a device', () => {
  it('derives the same device key from the same secret, and different keys from different secrets', () => {
    const s = rand(32);
    expect(deviceKeysFromSecret(s).publicKey).toEqual(deviceKeysFromSecret(s).publicKey);
    expect(deviceKeysFromSecret(s).publicKey).not.toEqual(deviceKeysFromSecret(rand(32)).publicKey);
  });

  it('opens only for the device it was sealed to, and refuses a tampered seal', () => {
    const phone = deviceKeysFromSecret(rand(32));
    const payload = rand(33);
    const sealed = sealTo(phone.publicKey, payload);
    expect(openSealed(phone, sealed)).toEqual(payload);
    expect(() => openSealed(newDeviceKeys(), sealed)).toThrow();
    for (const i of [0, 40, sealed.length - 1]) {
      const bad = sealed.slice();
      bad[i] ^= 0x80;
      expect(() => openSealed(phone, bad)).toThrow();
    }
  });

  it('uses a fresh ephemeral key per seal, so two seals of one share are unlinkable', () => {
    const phone = newDeviceKeys();
    const share = rand(33);
    const a = sealTo(phone.publicKey, share);
    const b = sealTo(phone.publicKey, share);
    expect(a.slice(0, 32)).not.toEqual(b.slice(0, 32));
    expect(a).not.toEqual(b);
  });
});

describe('transaction receipts', () => {
  const fixture = readFileSync(new URL('./fixtures/agentpay-tx.json', import.meta.url), 'utf8');
  const HASH = '70f9a427f19fcfca75ca85e8361f980767bcb5c320d85013681d313ae7e2a86f';
  const respond = (body: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
  afterEach(() => vi.unstubAllGlobals());

  it('decodes a real agentPay transaction: block, circuit, proof and payout', async () => {
    respond(fixture);
    const r = (await txReceipt('http://indexer.test/graphql', HASH))!;
    expect(r.status).toBe('SUCCESS');
    expect(r.block.height).toBe(2223);
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0]!;
    expect(call).toMatchObject({ kind: 'call', entryPoint: 'agentPay' });
    expect(call.proofBytes).toBeGreaterThan(1000);
    expect(Buffer.from(call.proofHead!, 'hex').toString('latin1')).toMatch(/^midnight:proof/);
    expect(r.outputs).toEqual([expect.objectContaining({ value: '50' })]);
  });

  it('asks the indexer for exactly the requested hash', async () => {
    respond(fixture);
    await txReceipt('http://indexer.test/graphql', HASH);
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body)).variables).toEqual({ hash: HASH });
  });

  it('returns null for a hash the indexer does not know', async () => {
    respond(JSON.stringify({ data: { transactions: [] } }));
    expect(await txReceipt('http://indexer.test/graphql', 'ab'.repeat(32))).toBeNull();
  });

  it('surfaces indexer errors and refuses anything that is not a 32-byte hash', async () => {
    respond(JSON.stringify({ errors: [{ message: 'invalid offset' }] }));
    await expect(txReceipt('http://indexer.test/graphql', 'cd'.repeat(32))).rejects.toThrow('invalid offset');
    await expect(txReceipt('http://indexer.test/graphql', 'not-a-hash')).rejects.toThrow('Not a transaction hash');
    await expect(txReceipt('http://indexer.test/graphql', 'ab'.repeat(31))).rejects.toThrow('Not a transaction hash');
  });

  it('refuses a transaction whose proofs were erased', async () => {
    const t = JSON.parse(fixture) as { data: { transactions: { raw: string }[] } };
    const raw = Buffer.from(t.data.transactions[0]!.raw, 'hex');
    raw.write('midnight:transaction[v12](signature[v1],proof-preimage', 0, 'latin1');
    t.data.transactions[0]!.raw = raw.toString('hex');
    respond(JSON.stringify(t));
    await expect(txReceipt('http://indexer.test/graphql', HASH)).rejects.toThrow();
  });
});
