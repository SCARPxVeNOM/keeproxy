// Off-chain RESTORE crypto: backups bound to the on-chain digest and version,
// Shamir k-of-n, and shares sealed to the new device.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  combineShares,
  decodeShare,
  decryptBackup,
  encodeShare,
  encryptBackup,
  newDeviceKeys,
  openSealed,
  sealTo,
  splitSecret,
} from '../restore.js';

const state = new TextEncoder().encode(JSON.stringify({ ownerSecret: 'aa'.repeat(32), note: 'private' }));

describe('RESTORE crypto', () => {
  it('rebuilds a secret from any k of n shares, and not from k-1', () => {
    const secret = new Uint8Array(randomBytes(32));
    const shares = splitSecret(secret, 2, 3);
    expect(combineShares([shares[0]!, shares[1]!])).toEqual(secret);
    expect(combineShares([shares[2]!, shares[0]!])).toEqual(secret);
    expect(combineShares([shares[1]!])).not.toEqual(secret);
    const s3 = splitSecret(secret, 3, 5);
    expect(combineShares([s3[4]!, s3[1]!, s3[2]!])).toEqual(secret);
    expect(() => combineShares([shares[0]!, shares[0]!])).toThrow('duplicate share');
  });

  it('round-trips a backup that matches the anchored digest and version', () => {
    const { backup, key } = encryptBackup(state, 3n);
    expect(decryptBackup(backup, key, { digest: backup.digest, version: 3n })).toEqual(state);
  });

  it('refuses a stale backup (rollback) and a tampered one', () => {
    const old = encryptBackup(state, 1n);
    const cur = encryptBackup(state, 2n);
    expect(() => decryptBackup(old.backup, old.key, { digest: cur.backup.digest, version: 2n })).toThrow('Stale backup');
    const tampered = { ...cur.backup, blob: cur.backup.blob.slice() };
    tampered.blob[40] ^= 1;
    expect(() => decryptBackup(tampered, cur.key, { digest: cur.backup.digest, version: 2n })).toThrow(
      'does not match the digest',
    );
  });

  it('seals shares so only the new device opens them, then restores end to end', () => {
    const { backup, key } = encryptBackup(state, 1n);
    const shares = splitSecret(key, 2, 3);
    const device = newDeviceKeys();
    const thief = newDeviceKeys();
    const sealed = shares.slice(0, 2).map((s) => sealTo(device.publicKey, encodeShare(s)));
    expect(() => openSealed(thief, sealed[0]!)).toThrow();
    const rebuilt = combineShares(sealed.map((s) => decodeShare(openSealed(device, s))));
    expect(decryptBackup(backup, rebuilt, { digest: backup.digest, version: 1n })).toEqual(state);
  });
});
