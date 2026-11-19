// SPDX-License-Identifier: Apache-2.0
//
// The off-chain half of RESTORE.
//
//   1. backup:   the owner's private state is encrypted with a fresh
//                AES-256-GCM key; SHA-256(ciphertext) is anchored on chain
//                with a strictly increasing version (anchorBackup).
//   2. split:    the backup key is split k-of-n with Shamir's scheme over
//                GF(256); each guardian keeps one share.
//   3. release:  after a recovery, each guardian seals its share to the new
//                device's X25519 key and posts it (releaseShare).
//   4. restore:  the new device opens k sealed shares, rebuilds the key,
//                checks the backup against the on-chain digest and version,
//                and only then decrypts it.
//
// Node's built-in crypto only; nothing here touches the network.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

// ------------------------------------------------------------ backups ----

export interface EncryptedBackup {
  version: bigint;
  /** iv (12) || tag (16) || ciphertext */
  blob: Uint8Array;
  /** SHA-256 of `blob`: the value anchored on chain. */
  digest: Uint8Array;
}

export const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(b).digest());

function aesSeal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), ct]));
}

function aesOpen(key: Uint8Array, blob: Uint8Array, aad: Uint8Array): Uint8Array {
  const b = Buffer.from(blob);
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAAD(aad);
  d.setAuthTag(b.subarray(12, 28));
  return new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()]));
}

const versionAad = (version: bigint) => new TextEncoder().encode(`keeproxy:backup:v${version}`);

/** Encrypts a serialized private state under a fresh key. */
export function encryptBackup(state: Uint8Array, version: bigint): { backup: EncryptedBackup; key: Uint8Array } {
  const key = new Uint8Array(randomBytes(32));
  const blob = aesSeal(key, state, versionAad(version));
  return { backup: { version, blob, digest: sha256(blob) }, key };
}

/**
 * Decrypts a backup only if it is the one anchored on chain: same digest and
 * same version. A stale or tampered blob is refused before decryption.
 */
export function decryptBackup(
  backup: EncryptedBackup,
  key: Uint8Array,
  anchored: { digest: Uint8Array; version: bigint },
): Uint8Array {
  if (backup.version !== anchored.version) {
    throw new Error(`Stale backup: v${backup.version} is not the anchored v${anchored.version}`);
  }
  if (Buffer.compare(Buffer.from(sha256(backup.blob)), Buffer.from(anchored.digest)) !== 0) {
    throw new Error('Backup does not match the digest anchored on chain');
  }
  return aesOpen(key, backup.blob, versionAad(backup.version));
}

// ------------------------------------------------- Shamir over GF(256) ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x ^= x << 1; // multiply by 3 (generator) in GF(2^8) with the AES polynomial
    if (x & 0x100) x ^= 0x11b;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const gmul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);
const gdiv = (a: number, b: number) => {
  if (b === 0) throw new Error('division by zero');
  return a === 0 ? 0 : EXP[(LOG[a]! + 255 - LOG[b]!) % 255]!;
};

export interface Share {
  /** x coordinate, 1..255 */
  x: number;
  y: Uint8Array;
}

/** Splits `secret` into `n` shares, any `k` of which rebuild it. */
export function splitSecret(secret: Uint8Array, k: number, n: number): Share[] {
  if (k < 1 || k > n || n > 255) throw new Error('need 1 <= k <= n <= 255');
  const shares: Share[] = Array.from({ length: n }, (_, i) => ({ x: i + 1, y: new Uint8Array(secret.length) }));
  for (let b = 0; b < secret.length; b++) {
    const coeffs = new Uint8Array(k);
    coeffs[0] = secret[b]!;
    coeffs.set(randomBytes(k - 1), 1);
    for (const s of shares) {
      let y = 0;
      for (let j = k - 1; j >= 0; j--) y = gmul(y, s.x) ^ coeffs[j]!;
      s.y[b] = y;
    }
  }
  return shares;
}

/** Lagrange interpolation at x = 0. */
export function combineShares(shares: Share[]): Uint8Array {
  if (shares.length === 0) throw new Error('no shares');
  const xs = new Set(shares.map((s) => s.x));
  if (xs.size !== shares.length) throw new Error('duplicate share');
  const len = shares[0]!.y.length;
  const out = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    let acc = 0;
    for (const si of shares) {
      let num = 1;
      let den = 1;
      for (const sj of shares) {
        if (sj.x === si.x) continue;
        num = gmul(num, sj.x);
        den = gmul(den, sj.x ^ si.x);
      }
      acc ^= gmul(si.y[b]!, gdiv(num, den));
    }
    out[b] = acc;
  }
  return out;
}

export const encodeShare = (s: Share): Uint8Array => new Uint8Array([s.x, ...s.y]);
export const decodeShare = (b: Uint8Array): Share => ({ x: b[0]!, y: b.slice(1) });

// ---------------------------------------- sealing shares to a device ----

export interface DeviceKeys {
  /** Raw 32-byte X25519 public key: what openRecovery publishes as deviceKey. */
  publicKey: Uint8Array;
  privateKey: KeyObject;
}

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

const rawPublic = (k: KeyObject) => new Uint8Array(k.export({ format: 'der', type: 'spki' }).subarray(12));
const publicFromRaw = (raw: Uint8Array) =>
  createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' });

export function newDeviceKeys(): DeviceKeys {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey: rawPublic(publicKey), privateKey };
}

export function deviceKeysFromSecret(secret: Uint8Array): DeviceKeys {
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(secret)]),
    format: 'der',
    type: 'pkcs8',
  });
  return { publicKey: rawPublic(createPublicKey(privateKey)), privateKey };
}

const sealKey = (shared: Buffer, ephemeral: Uint8Array, recipient: Uint8Array) =>
  new Uint8Array(
    hkdfSync('sha256', shared, Buffer.concat([Buffer.from(ephemeral), Buffer.from(recipient)]), 'keeproxy:share', 32),
  );

/** Seals a share to a device's X25519 public key (ephemeral ECDH + AES-GCM). */
export function sealTo(recipient: Uint8Array, payload: Uint8Array): Uint8Array {
  const eph = generateKeyPairSync('x25519');
  const ephPub = rawPublic(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromRaw(recipient) });
  const ct = aesSeal(sealKey(shared, ephPub, recipient), payload, recipient);
  return new Uint8Array([...ephPub, ...ct]);
}

export function openSealed(device: DeviceKeys, sealed: Uint8Array): Uint8Array {
  const ephPub = sealed.slice(0, 32);
  const shared = diffieHellman({ privateKey: device.privateKey, publicKey: publicFromRaw(ephPub) });
  return aesOpen(sealKey(shared, ephPub, device.publicKey), sealed.slice(32), device.publicKey);
}
