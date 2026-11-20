// SPDX-License-Identifier: Apache-2.0
//
// VaultService: one place that drives a Keeproxy vault on a real network.
// The console server (server/keeproxyd.ts) and the agent's MCP server both
// go through it, so the web UI and Claude see the same vault.
//
// In this demo one process holds every role's device: the owner's laptop,
// the agent's runtime, three guardians' phones, two heirs and the "new
// device" a recovery restores onto. Each keeps its own private-state id, and
// every action runs as exactly one of them. What one device knows is never
// handed to another except through the chain (sealed shares) — the same
// boundary separate machines would have.

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import pino from 'pino';
import { submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { type ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { type EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';

import { getConfig, type NetworkConfig } from './config.js';
import { MidnightWalletProvider, startWallet } from './wallet.js';
import { buildProviders, ledgerState, type KeeproxyProviders } from './providers.js';
import { deployStaged } from './staged-deploy.js';
import { publicViewOf } from './public-view.js';
import {
  combineShares,
  decodeShare,
  decryptBackup,
  deviceKeysFromSecret,
  encodeShare,
  encryptBackup,
  openSealed,
  sealTo,
  splitSecret,
  type EncryptedBackup,
} from './restore.js';
import {
  CompiledKeeproxyContract,
  Phase,
  Role,
  ledger,
  pureCircuits as pc,
  zkConfigPath,
  type KeeproxyPrivateState,
  type Ledger,
  type Mandate,
} from '../contract/index.js';

// @ts-expect-error WebSocket global for the indexer's GraphQL subscriptions
globalThis.WebSocket ??= WebSocket;

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const bytes32 = () => new Uint8Array(randomBytes(32));
const nowSec = () => BigInt(Math.floor(Date.now() / 1000) - 30);

export type DeviceId =
  | 'owner'
  | 'agent'
  | 'guardian0'
  | 'guardian1'
  | 'guardian2'
  | 'heir0'
  | 'heir1'
  | 'newDevice'
  | 'lostLaptop';

/** Everything the demo's devices hold, persisted so the server can restart. Local only, gitignored. */
interface VaultFile {
  network: string;
  address: ContractAddress;
  createdAt: string;
  timers: { threshold: string; inactivity: string; veto: string };
  owner: string; // current owner secret
  lostOwner?: string; // the secret on the laptop a recovery rotated away from
  agent: string;
  mandate: Record<keyof Mandate, string>;
  guardians: string[];
  guardianShares: (string | null)[]; // each guardian's share of the latest backup key
  heirs: { sk: string; bps: string }[];
  payee: string; // unshielded address bytes the mandate may pay
  stranger: string; // an address that is on no allowlist
  newDevice: { ownerSecret: string; deviceSecret: string } | null;
  backups: { version: string; blob: string; digest: string }[];
  restored: { version: string; payload: unknown } | null;
}

export interface VaultEvent {
  at: number;
  kind: 'tx' | 'refused' | 'info' | 'progress' | 'error';
  device?: DeviceId | 'anyone';
  circuit?: string;
  message: string;
  txId?: string;
}

export interface ActResult {
  ok: boolean;
  txId?: string;
  error?: string;
  detail?: unknown;
}

const ser = (m: Mandate): VaultFile['mandate'] => ({
  agentPk: hex(m.agentPk),
  capPerEpoch: m.capPerEpoch.toString(),
  epochSeconds: m.epochSeconds.toString(),
  expiresAt: m.expiresAt.toString(),
  generation: m.generation.toString(),
  salt: hex(m.salt),
});
const de = (m: VaultFile['mandate']): Mandate => ({
  agentPk: unhex(m.agentPk),
  capPerEpoch: BigInt(m.capPerEpoch),
  epochSeconds: BigInt(m.epochSeconds),
  expiresAt: BigInt(m.expiresAt),
  generation: BigInt(m.generation),
  salt: unhex(m.salt),
});

/** Short, human error text from a rejected circuit or a failed submission. */
export function reason(e: unknown): string {
  // midnight-js wraps witness/assert failures; the useful text is in the cause chain.
  const parts: string[] = [];
  for (let cur: unknown = e, i = 0; cur && i < 8; i++) {
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur = cur instanceof Error ? (cur as Error & { cause?: unknown }).cause : undefined;
  }
  const msg = parts.join('\n');
  const m = /failed assert: ([^\n]+)/.exec(msg) ?? /((?:Guardian|Heir|Mandate|Recipient) is not enrolled in this vault|This device holds no [^\n]+)/.exec(msg);
  if (m) return m[1]!.trim();
  return parts[0]!.split('\n')[0]!.slice(0, 240);
}

export class VaultService extends EventEmitter {
  readonly config: NetworkConfig;
  readonly network: string;
  private alice!: MidnightWalletProvider;
  /** Local only: the payee wallet. Elsewhere the fee wallet doubles as payee, saving a second sync. */
  private bob?: MidnightWalletProvider;
  private prov!: KeeproxyProviders;
  private file: VaultFile | null = null;
  private readonly stateDir: string;
  private queue: Promise<unknown> = Promise.resolve();
  busy: string | null = null;
  readonly log: VaultEvent[] = [];
  readonly logger = pino({ level: process.env['LOG_LEVEL'] ?? 'warn', transport: { target: 'pino-pretty' } });

  private constructor(network: string, stateDir: string) {
    super();
    this.network = network;
    this.config = getConfig();
    this.stateDir = stateDir;
  }

  static async start(opts: { network?: string; stateDir?: string } = {}): Promise<VaultService> {
    const network = opts.network ?? process.env['MIDNIGHT_NETWORK'] ?? 'local';
    const svc = new VaultService(network, opts.stateDir ?? path.resolve('.keeproxy', network));
    mkdirSync(svc.stateDir, { recursive: true });
    const c = svc.config;
    const env: EnvironmentConfiguration = {
      walletNetworkId: c.networkId,
      networkId: c.networkId,
      indexer: c.indexer,
      indexerWS: c.indexerWS,
      node: c.node,
      nodeWS: c.nodeWS,
      faucet: c.faucet,
      proofServer: c.proofServer,
    };
    const syncTimeoutMs = network === 'local' ? 10 * 60_000 : 60 * 60_000;
    svc.emitEvent({ kind: 'info', message: `Syncing wallets on ${network}…` });
    svc.alice = await startWallet(svc.logger, env, { network, role: 'ALICE', faucet: c.faucet, syncTimeoutMs });
    if (network === 'local') svc.bob = await startWallet(svc.logger, env, { network, role: 'BOB', faucet: c.faucet, syncTimeoutMs });
    svc.prov = buildProviders(svc.alice, zkConfigPath, c, { storeName: `keeproxy-${network}` });
    const f = path.join(svc.stateDir, 'vault.json');
    if (existsSync(f)) svc.file = JSON.parse(readFileSync(f, 'utf8')) as VaultFile;
    svc.emitEvent({ kind: 'info', message: svc.file ? `Loaded vault ${svc.file.address}` : 'Ready. No vault yet.' });
    return svc;
  }

  async stop() {
    await this.alice?.stop();
    await this.bob?.stop();
  }

  get address(): ContractAddress | null {
    return this.file?.address ?? null;
  }

  // ------------------------------------------------------------ plumbing ----

  private emitEvent(e: Omit<VaultEvent, 'at'>) {
    const ev = { at: Date.now(), ...e };
    this.log.push(ev);
    if (this.log.length > 500) this.log.shift();
    this.emit('event', ev);
  }

  private save() {
    if (this.file) writeFileSync(path.join(this.stateDir, 'vault.json'), JSON.stringify(this.file, null, 2));
  }

  /** One transaction at a time: they share a fee wallet. */
  private serial<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      this.busy = label;
      try {
        return await fn();
      } finally {
        this.busy = null;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private psOf(d: DeviceId): KeeproxyPrivateState {
    const f = this.need();
    switch (d) {
      case 'owner':
        return { ownerSecret: unhex(f.owner) };
      case 'agent':
        return { agentSecret: unhex(f.agent), mandate: de(f.mandate) };
      case 'guardian0':
      case 'guardian1':
      case 'guardian2':
        return { guardianSecret: unhex(f.guardians[Number(d.slice(-1))]!) };
      case 'heir0':
      case 'heir1': {
        const h = f.heirs[Number(d.slice(-1))]!;
        return { heirSecret: unhex(h.sk), heirShareBps: BigInt(h.bps) };
      }
      case 'newDevice':
        if (!f.newDevice) throw new Error('No new device has been set up');
        return { ownerSecret: unhex(f.newDevice.ownerSecret) };
      case 'lostLaptop':
        return { ownerSecret: unhex(f.lostOwner ?? f.owner) };
    }
  }

  private need(): VaultFile {
    if (!this.file) throw new Error('No vault yet: create one first');
    return this.file;
  }

  private async call(device: DeviceId, circuit: string, ...args: unknown[]): Promise<ActResult> {
    const f = this.need();
    const id = `${f.address.slice(0, 12)}-${device}`;
    await this.prov.privateStateProvider.forContract(f.address).set(id, this.psOf(device));
    try {
      const tx = (await submitCallTx(this.prov, {
        compiledContract: CompiledKeeproxyContract,
        contractAddress: f.address,
        privateStateId: id,
        circuitId: circuit,
        args,
      } as never)) as unknown as { public: { txId?: string; txHash?: string } };
      const txId = tx.public.txHash ?? tx.public.txId;
      this.emitEvent({ kind: 'tx', device, circuit, message: `${circuit} confirmed`, txId });
      return { ok: true, txId };
    } catch (e) {
      const why = reason(e);
      this.emitEvent({ kind: 'refused', device, circuit, message: why });
      return { ok: false, error: why };
    }
  }

  async ledger(): Promise<Ledger> {
    const f = this.need();
    return ledger(ledgerState(await this.prov.publicDataProvider.queryContractState(f.address)));
  }

  // -------------------------------------------------------------- create ----

  /** Deploys a fresh vault and sets up every role. Takes a few minutes: ~20 transactions. */
  createVault(timers = { threshold: 2n, inactivity: 600n, veto: 180n }): Promise<ActResult> {
    return this.serial('create-vault', async () => {
      const owner = bytes32();
      const vaultId = bytes32();
      this.emitEvent({ kind: 'info', message: 'Deploying vault (staged: constructor + verifier keys)…' });
      const d = await deployStaged(this.prov, {
        privateStateId: `deploy-${hex(vaultId).slice(0, 8)}`,
        initialPrivateState: { ownerSecret: owner },
        args: [vaultId, timers.threshold, timers.inactivity, timers.veto, nowSec()],
        onProgress: ({ stage, circuit, index, total }) =>
          this.emitEvent({
            kind: 'progress',
            message: stage === 'deploy' ? `tx ${index}/${total} deploy` : `tx ${index}/${total} verifier key: ${circuit}`,
          }),
      });
      return this.setupRoles(d.contractAddress, owner, vaultId, timers);
    });
  }

  /**
   * Takes over a vault deployed elsewhere (npm run deploy) with its owner
   * secret, then sets up every role the way createVault does.
   */
  adoptVault(address: ContractAddress, ownerSecret: Uint8Array): Promise<ActResult> {
    return this.serial('adopt-vault', async () => {
      const l = ledger(ledgerState(await this.prov.publicDataProvider.queryContractState(address)));
      if (l.guardianCount > 0n) throw new Error('This vault already has guardians: adopt only a fresh deploy');
      this.emitEvent({ kind: 'info', message: `Adopting vault ${address}…` });
      return this.setupRoles(address, ownerSecret, l.vaultId, {
        threshold: l.threshold,
        inactivity: l.inactivitySeconds,
        veto: l.vetoSeconds,
      });
    });
  }

  /** Enrolls 3 guardians, 2 heirs, an agent mandate and a payee, then deposits. */
  private async setupRoles(
    address: ContractAddress,
    owner: Uint8Array,
    vault: Uint8Array,
    timers: { threshold: bigint; inactivity: bigint; veto: bigint },
  ): Promise<ActResult> {
    const bobAddr = new Uint8Array((await (this.bob ?? this.alice).wallet.unshielded.getAddress()).data);
    const agent = bytes32();
    const mandate: Mandate = {
      agentPk: pc.agentKeyOf(agent, vault),
      capPerEpoch: 200n,
      epochSeconds: 604_800n,
      expiresAt: nowSec() + 30n * 86_400n,
      generation: 0n,
      salt: bytes32(),
    };
    this.file = {
      network: this.network,
      address,
      createdAt: new Date().toISOString(),
      timers: {
        threshold: timers.threshold.toString(),
        inactivity: timers.inactivity.toString(),
        veto: timers.veto.toString(),
      },
      owner: hex(owner),
      agent: hex(agent),
      mandate: ser(mandate),
      guardians: [bytes32(), bytes32(), bytes32()].map(hex),
      guardianShares: [null, null, null],
      heirs: [
        { sk: hex(bytes32()), bps: '6000' },
        { sk: hex(bytes32()), bps: '4000' },
      ],
      payee: hex(bobAddr),
      stranger: hex(bytes32()),
      newDevice: null,
      backups: [],
      restored: null,
    };
    this.save();
    this.emitEvent({ kind: 'info', message: `Vault at ${address}. Enrolling roles…` });
    const f = this.file;
    for (const g of f.guardians) await this.mustCall('owner', 'enroll', Role.GUARDIAN, pc.guardianLeafOf(unhex(g), vault));
    for (const h of f.heirs)
      await this.mustCall('owner', 'enroll', Role.HEIR, pc.heirLeafOf(pc.heirKeyOf(unhex(h.sk), vault), BigInt(h.bps)));
    await this.mustCall('owner', 'enroll', Role.MANDATE, pc.mandateLeafOf(mandate));
    await this.mustCall('owner', 'enroll', Role.PAYEE, pc.payeeLeafOf(bobAddr, mandate.salt));
    await this.mustCall('owner', 'deposit', 1000n);
    this.emitEvent({ kind: 'info', message: 'Vault ready: 3 guardians (2 needed), 2 heirs, 1 agent mandate, 1000 NIGHT.' });
    return { ok: true, detail: { address } };
  }

  private async mustCall(device: DeviceId, circuit: string, ...args: unknown[]) {
    const r = await this.call(device, circuit, ...args);
    if (!r.ok) throw new Error(`${circuit} failed: ${r.error}`);
    return r;
  }

  // -------------------------------------------------------------- actions ----

  /**
   * Runs one named action as one device. Every action maps to exactly one
   * circuit call (RESTORE's off-chain steps happen on the acting device).
   */
  act(action: string, params: Record<string, unknown> = {}): Promise<ActResult> {
    return this.serial(action, async () => {
      const f = this.need();
      const vault = (await this.ledger()).vaultId;
      const amount = BigInt(String(params['amount'] ?? '0'));
      const to = (which: unknown) => ({ bytes: unhex(which === 'stranger' ? f.stranger : f.payee) });
      switch (action) {
        case 'deposit':
          return this.call('owner', 'deposit', amount);
        case 'withdraw':
          return this.call('owner', 'withdraw', to('payee'), amount);
        case 'heartbeat':
          return this.call('owner', 'heartbeat', nowSec());
        case 'revokeMandates':
          return this.call('owner', 'revokeMandates');
        case 'agentPay':
          return this.call('agent', 'agentPay', to(params['recipient']), amount, nowSec());
        case 'backup':
          return this.backup(vault);
        case 'openRecovery':
          return this.openRecovery(vault, Number(params['guardian'] ?? 0));
        case 'approveRecovery':
          return this.call(`guardian${Number(params['guardian'] ?? 1)}` as DeviceId, 'approveRecovery');
        case 'finalizeRecovery':
          return this.finalizeRecovery();
        case 'releaseShare':
          return this.releaseShare(Number(params['guardian'] ?? 0));
        case 'restore':
          return this.restore();
        case 'triggerInheritance':
          return this.call('guardian0', 'triggerInheritance', nowSec());
        case 'claimInheritance':
          return this.call(`heir${Number(params['heir'] ?? 0)}` as DeviceId, 'claimInheritance', to('payee'));
        case 'stolenDeviceHeartbeat':
          // The old laptop, after the owner key rotated away from it.
          return this.call('lostLaptop', 'heartbeat', nowSec());
        case 'agentNote':
          // Off chain: a message from the agent to the owner's console.
          this.emitEvent({ kind: 'info', device: 'agent', message: String(params['message'] ?? '').slice(0, 500) });
          return { ok: true };
        default:
          return { ok: false, error: `Unknown action '${action}'` };
      }
    });
  }

  /** RESTORE 1–2: encrypt the owner device's private state, split the key 2-of-3, anchor the digest. */
  private async backup(vault: Uint8Array): Promise<ActResult> {
    const f = this.need();
    const l = await this.ledger();
    const version = l.backupVersion + 1n;
    const payload = {
      vault: hex(vault),
      ownerSecret: f.owner,
      mandates: [f.mandate],
      guardians: f.guardians.map((g) => hex(pc.guardianLeafOf(unhex(g), vault))),
      heirs: f.heirs.map((h) => ({ leaf: hex(pc.heirLeafOf(pc.heirKeyOf(unhex(h.sk), vault), BigInt(h.bps))), bps: h.bps })),
      notes: 'Seed phrases and dApp secrets for other Midnight apps would live here too.',
      savedAt: new Date().toISOString(),
    };
    const { backup, key } = encryptBackup(new TextEncoder().encode(JSON.stringify(payload)), version);
    const shares = splitSecret(key, Number(l.threshold), f.guardians.length);
    const r = await this.call('owner', 'anchorBackup', backup.digest, version);
    if (r.ok) {
      f.backups.push({ version: version.toString(), blob: hex(backup.blob), digest: hex(backup.digest) });
      f.guardianShares = shares.map((s) => hex(encodeShare(s)));
      this.save();
      this.emitEvent({ kind: 'info', device: 'owner', message: `Backup v${version} encrypted, key split 2-of-3 to guardians` });
    }
    return { ...r, detail: { version: version.toString(), digest: hex(backup.digest), bytes: backup.blob.length } };
  }

  /** The new device makes fresh keys; guardian `g` opens a recovery towards them. */
  private async openRecovery(vault: Uint8Array, g: number): Promise<ActResult> {
    const f = this.need();
    const ownerSecret = bytes32();
    const deviceSecret = bytes32();
    const dev = deviceKeysFromSecret(deviceSecret);
    const r = await this.call(
      `guardian${g}` as DeviceId,
      'openRecovery',
      pc.ownerKeyOf(ownerSecret, vault),
      dev.publicKey,
      nowSec(),
    );
    if (r.ok) {
      f.newDevice = { ownerSecret: hex(ownerSecret), deviceSecret: hex(deviceSecret) };
      this.save();
    }
    return r;
  }

  private async finalizeRecovery(): Promise<ActResult> {
    const f = this.need();
    const r = await this.call('guardian2', 'finalizeRecovery', nowSec());
    if (r.ok && f.newDevice) {
      // The new device is the owner now; the old laptop keeps its stale secret.
      f.lostOwner = f.owner;
      f.owner = f.newDevice.ownerSecret;
      this.save();
    }
    return r;
  }

  /** RESTORE 3: a guardian seals its key share to the new device's published key. */
  private async releaseShare(g: number): Promise<ActResult> {
    const f = this.need();
    const share = f.guardianShares[g];
    if (!share) return { ok: false, error: 'This guardian holds no backup share (make a backup first)' };
    const l = await this.ledger();
    const sealed = sealTo(l.pendingDeviceKey, unhex(share));
    return this.call(`guardian${g}` as DeviceId, 'releaseShare', sealed);
  }

  /** RESTORE 4: the new device opens the released shares and decrypts the anchored backup. */
  private async restore(): Promise<ActResult> {
    const f = this.need();
    if (!f.newDevice) return { ok: false, error: 'No new device has been set up' };
    const l = await this.ledger();
    const dev = deviceKeysFromSecret(unhex(f.newDevice.deviceSecret));
    const opened = [...l.releasedShares].flatMap(([, sealed]) => {
      try {
        return [decodeShare(openSealed(dev, sealed))];
      } catch {
        return [];
      }
    });
    if (opened.length < Number(l.threshold)) {
      const msg = `Only ${opened.length} of ${l.threshold} shares released to this device`;
      this.emitEvent({ kind: 'refused', device: 'newDevice', circuit: 'restore', message: msg });
      return { ok: false, error: msg };
    }
    const latest = f.backups.find((b) => BigInt(b.version) === l.backupVersion);
    if (!latest) return { ok: false, error: 'The anchored backup blob is not available' };
    const backup: EncryptedBackup = { version: BigInt(latest.version), blob: unhex(latest.blob), digest: unhex(latest.digest) };
    try {
      const key = combineShares(opened.slice(0, Number(l.threshold)));
      const plain = decryptBackup(backup, key, { digest: l.backupDigest, version: l.backupVersion });
      const payload = JSON.parse(new TextDecoder().decode(plain)) as unknown;
      f.restored = { version: latest.version, payload };
      this.save();
      this.emitEvent({ kind: 'info', device: 'newDevice', message: `Restored backup v${latest.version}: digest matches the chain` });
      return { ok: true, detail: f.restored };
    } catch (e) {
      const msg = reason(e);
      this.emitEvent({ kind: 'refused', device: 'newDevice', circuit: 'restore', message: msg });
      return { ok: false, error: msg };
    }
  }

  // ---------------------------------------------------------------- views ----

  /** The public ledger, exactly what any indexer user can read, made JSON-safe. */
  async publicView() {
    if (!this.file) return null;
    return publicViewOf(await this.ledger(), this.file.address, this.network);
  }

  /** What each device holds privately. Never on chain. */
  deviceView() {
    const f = this.file;
    if (!f) return null;
    const short = (s: string) => `${s.slice(0, 10)}…`;
    return {
      owner: { secret: short(f.owner), holds: 'owner secret' },
      agent: {
        secret: short(f.agent),
        mandate: {
          capPerEpoch: f.mandate.capPerEpoch,
          epochSeconds: f.mandate.epochSeconds,
          expiresAt: Number(f.mandate.expiresAt),
          generation: f.mandate.generation,
        },
      },
      guardians: f.guardians.map((g, i) => ({ secret: short(g), hasShare: f.guardianShares[i] !== null })),
      heirs: f.heirs.map((h) => ({ secret: short(h.sk), shareBps: Number(h.bps) })),
      newDevice: f.newDevice ? { secret: short(f.newDevice.ownerSecret) } : null,
      backups: f.backups.map((b) => ({ version: Number(b.version), digest: b.digest, bytes: b.blob.length / 2 })),
      restored: f.restored,
      timers: f.timers,
    };
  }
}
