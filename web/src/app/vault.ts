// SPDX-License-Identifier: Apache-2.0
//
// The browser side of Keeproxy: a visitor's own vault, driven through their
// own Midnight wallet over the DApp Connector API.
//
// The wallet balances, pays for, proves and submits every transaction; this
// module builds them. The role secrets it generates (owner, guardian, heir,
// agent, a recovering device) never leave this browser: they sit in
// localStorage, and the contract only ever sees their hashes. A visitor can
// download them as a key file and import that file elsewhere.

import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import {
  dappConnectorNetwork,
  dappConnectorProofProvider,
  dappConnectorWalletProviders,
} from '@midnight-ntwrk/midnight-js-dapp-connector-proof-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { CostModel } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk-address-format';
import {
  compiledKeeproxy,
  ledger as decodeLedger,
  pureCircuits as pc,
  Role,
  type KeeproxyPrivateState,
  type Ledger,
  type Mandate,
} from '../../../contract/core';
import { deployStaged } from '../../../src/staged-deploy';
import { publicViewOf, type PublicView } from '../../../src/public-view';

/** The network the hosted app targets; the wallet must be on it. */
export const NETWORK = (import.meta.env.VITE_KEEPROXY_NETWORK as string | undefined) ?? 'preprod';
/** Where the public proving artifacts are served (keeproxy-viewer's /zk/ route). */
const ZK_ORIGIN = ((import.meta.env.VITE_KEEPROXY_API as string | undefined) ?? '').replace(/\/$/, '');
const ZK_BASE = `${ZK_ORIGIN}/zk/${__KEEPROXY_ZK_VERSION__}/`;
/** The proving artifacts this build pins, fetched from the viewer. */
export const zkProvider = () =>
  new FetchZkConfigProvider<string>(ZK_BASE, {
    expectedManifestHash: __KEEPROXY_ZK_VERSION__,
    // Called as a method otherwise, which the browser refuses ("Illegal invocation").
    fetchFunc: ((input, init) => globalThis.fetch(input as RequestInfo, init as RequestInit)) as typeof fetch,
  });
/** The connector API major this app is written against. */
const API_MAJOR = '4.';

// ------------------------------------------------------------------ bytes ----

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => {
  if (!/^([0-9a-f]{2})*$/i.test(s)) throw new Error('Not a hex string');
  return Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
};
const bytes32 = () => crypto.getRandomValues(new Uint8Array(32));
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

// ----------------------------------------------------------------- wallets ----

export interface WalletChoice {
  key: string;
  name: string;
  icon: string;
  apiVersion: string;
  supported: boolean;
}

function injected(): Record<string, InitialAPI> {
  return ((globalThis as { midnight?: Record<string, InitialAPI> }).midnight ?? {}) as Record<string, InitialAPI>;
}

/** Midnight wallets the browser has injected under window.midnight. */
export function listWallets(): WalletChoice[] {
  return Object.entries(injected())
    .filter(([, w]) => w && typeof w.connect === 'function')
    .map(([key, w]) => ({
      key,
      name: String(w.name ?? key),
      icon: String(w.icon ?? ''),
      apiVersion: String(w.apiVersion ?? ''),
      supported: String(w.apiVersion ?? '').startsWith(API_MAJOR),
    }));
}

// ------------------------------------------------------------- held roles ----

/** What this browser holds for one vault. Every field is a secret except `address`. */
export interface Held {
  address: string;
  network: string;
  label: string;
  createdAt: string;
  owner?: string;
  guardian?: string;
  heir?: { sk: string; bps: string };
  agent?: { sk: string; mandate: Record<string, string> };
  /** A device asking guardians to make it the owner. */
  newDevice?: { ownerSecret: string };
}

const STORE = 'keeproxy:held:v1';

export function loadHeld(): Held[] {
  try {
    const all = JSON.parse(localStorage.getItem(STORE) ?? '[]') as Held[];
    return all.filter((h) => h.network === NETWORK);
  } catch {
    return [];
  }
}

function saveHeld(next: Held) {
  let all: Held[] = [];
  try {
    all = JSON.parse(localStorage.getItem(STORE) ?? '[]') as Held[];
  } catch {
    /* start over */
  }
  const i = all.findIndex((h) => h.address === next.address && h.network === next.network);
  if (i >= 0) all[i] = next;
  else all.push(next);
  localStorage.setItem(STORE, JSON.stringify(all));
}

export function forgetHeld(address: string) {
  const all = (JSON.parse(localStorage.getItem(STORE) ?? '[]') as Held[]).filter((h) => h.address !== address);
  localStorage.setItem(STORE, JSON.stringify(all));
}

/** A key file for one vault: everything this browser holds for it. */
export function exportHeld(h: Held): string {
  return JSON.stringify({ format: 'keeproxy-keys/1', ...h }, null, 2);
}

export function importHeld(text: string): Held {
  const j = JSON.parse(text) as Held & { format?: string };
  if (j.format !== 'keeproxy-keys/1' || !/^[0-9a-f]{64}$/.test(j.address ?? '')) throw new Error('Not a Keeproxy key file');
  const { format: _f, ...h } = j;
  saveHeld(h);
  return h;
}

// ------------------------------------------------------------------ codes ----
//
// A role is joined by handing the owner a code: the leaf the contract stores,
// never the secret behind it.

export type JoinCode = { role: 'guardian' | 'heir'; vault: string; leaf: string; bps?: number };

const CODE_PREFIX = { guardian: 'kpg1', heir: 'kph1' } as const;

export function encodeJoin(c: JoinCode): string {
  return `${CODE_PREFIX[c.role]}.${c.vault}.${c.leaf}${c.bps !== undefined ? `.${c.bps}` : ''}`;
}

export function decodeJoin(code: string): JoinCode {
  const [p, vault, leaf, bps] = code.trim().split('.');
  const role = p === CODE_PREFIX.guardian ? 'guardian' : p === CODE_PREFIX.heir ? 'heir' : null;
  if (!role || !/^[0-9a-f]{64}$/.test(vault ?? '') || !/^[0-9a-f]{64}$/.test(leaf ?? '')) {
    throw new Error('Not a Keeproxy guardian or heir code');
  }
  return { role, vault: vault!, leaf: leaf!, bps: bps ? Number(bps) : undefined };
}

/** A recovering device's request: the owner key it wants and nothing secret. */
export function encodeRecovery(vault: string, ownerKey: string, deviceKey: string) {
  return `kpr1.${vault}.${ownerKey}.${deviceKey}`;
}

export function decodeRecovery(code: string) {
  const [p, vault, ownerKey, deviceKey] = code.trim().split('.');
  if (p !== 'kpr1' || ![vault, ownerKey, deviceKey].every((x) => /^[0-9a-f]{64}$/.test(x ?? ''))) {
    throw new Error('Not a Keeproxy recovery request');
  }
  return { vault: vault!, ownerKey: ownerKey!, deviceKey: deviceKey! };
}

// ------------------------------------------------------------------ vault ----

export type Device = 'owner' | 'guardian' | 'heir' | 'agent' | 'newDevice';

export interface Outcome {
  ok: boolean;
  txId?: string;
  error?: string;
}

export type Progress = (message: string) => void;

/** Turns a contract assert or a wallet rejection into one readable line. */
function reason(e: unknown): string {
  const parts: string[] = [];
  for (let x: unknown = e; x && parts.length < 4; x = (x as { cause?: unknown }).cause) {
    const m = x instanceof Error ? x.message : String(x);
    if (m && !parts.includes(m)) parts.push(m);
  }
  const all = parts.join(' · ');
  const failed = /failed assert: ([^\n·]+)/.exec(all);
  if (failed) return failed[1]!.trim();
  if (/reject|denied|cancel/i.test(all)) return 'The wallet declined the transaction';
  if (/ProtocolVersionMismatch|built for protocol version/i.test(all)) {
    return 'Your wallet is still syncing past the ledger 9 upgrade. Leave it open until it catches up, then try again';
  }
  if (/insufficient|not enough|dust/i.test(all) && /fee|balance|dust/i.test(all)) {
    return 'Not enough DUST for the fee: designate NIGHT for DUST generation in your wallet and wait a few minutes';
  }
  return parts[parts.length - 1] ?? 'Unknown error';
}

function privateStatePassword(): string {
  // levelPrivateStateProvider encrypts at rest and wants a strong password.
  // It protects nothing beyond this browser profile, like the key store.
  const k = 'keeproxy:psk';
  let p = localStorage.getItem(k);
  if (!p) {
    p = `Kp-${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))}9a`;
    localStorage.setItem(k, p);
  }
  return p;
}

export class BrowserVault {
  private constructor(
    readonly api: ConnectedAPI,
    readonly walletName: string,
    readonly networkId: string,
    readonly unshieldedAddress: string,
    private readonly providers: MidnightProviders<string>,
  ) {}

  static async connect(choice: WalletChoice): Promise<BrowserVault> {
    const initial = injected()[choice.key];
    if (!initial) throw new Error('That wallet is no longer available');
    if (!choice.supported) throw new Error(`${choice.name} speaks DApp Connector ${choice.apiVersion}; this app needs ${API_MAJOR}x`);
    const api = await initial.connect(NETWORK);
    const network = await dappConnectorNetwork(api);
    if (network.networkId !== NETWORK) throw new Error(`Switch ${choice.name} to ${NETWORK} (it is on ${network.networkId})`);
    const zk = zkProvider();
    const { walletProvider, midnightProvider } = await dappConnectorWalletProviders(api);
    const proofProvider = await dappConnectorProofProvider(api, zk, CostModel.initialCostModel());
    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: `keeproxy-${NETWORK}`,
        privateStoragePasswordProvider: privateStatePassword,
        accountId: String(walletProvider.getCoinPublicKey()),
      }),
      publicDataProvider: indexerPublicDataProvider(network.indexer.queryURL, network.indexer.subscriptionURL),
      zkConfigProvider: zk,
      proofProvider,
      walletProvider,
      midnightProvider,
      config: { networkId: network.networkId, ttlSeconds: 3600 },
    } as unknown as MidnightProviders<string>;
    const { unshieldedAddress } = await api.getUnshieldedAddress();
    return new BrowserVault(api, choice.name, network.networkId, unshieldedAddress, providers);
  }

  /** The wallet's unshielded address as the contract's UserAddress bytes. */
  private myAddress(): Uint8Array {
    return new Uint8Array(MidnightBech32m.parse(this.unshieldedAddress).decode(UnshieldedAddress, this.networkId).data);
  }

  /** Payee or payout address typed by a person: bech32m, or 64 hex characters. */
  addressBytes(text: string): Uint8Array {
    const t = text.trim();
    if (/^[0-9a-f]{64}$/i.test(t)) return unhex(t.toLowerCase());
    return new Uint8Array(MidnightBech32m.parse(t).decode(UnshieldedAddress, this.networkId).data);
  }

  async balances() {
    const [night, dust] = await Promise.all([this.api.getUnshieldedBalances(), this.api.getDustBalance()]);
    const total = Object.values(night).reduce((a, b) => a + b, 0n);
    return { night: total, dust: dust.balance, dustCap: dust.cap };
  }

  async ledger(address: string): Promise<Ledger> {
    const read = await this.providers.publicDataProvider.queryContractState(address);
    if (!read) throw new Error('No Keeproxy vault at that address on this network');
    if (read.contractState.era !== 'v9') throw new Error('Expected a ledger 9 contract');
    return decodeLedger(read.contractState.deserialize({ v9: ContractState }).data);
  }

  async view(address: string): Promise<PublicView> {
    return publicViewOf(await this.ledger(address), address, this.networkId);
  }

  private stateOf(h: Held, d: Device): KeeproxyPrivateState {
    const need = <T>(v: T | undefined, what: string) => {
      if (v === undefined) throw new Error(`This browser holds no ${what} for this vault`);
      return v;
    };
    switch (d) {
      case 'owner':
        return { ownerSecret: unhex(need(h.owner, 'owner key')) };
      case 'guardian':
        return { guardianSecret: unhex(need(h.guardian, 'guardian key')) };
      case 'heir': {
        const x = need(h.heir, 'heir key');
        return { heirSecret: unhex(x.sk), heirShareBps: BigInt(x.bps) };
      }
      case 'agent': {
        const x = need(h.agent, 'agent key');
        return { agentSecret: unhex(x.sk), mandate: mandateFrom(x.mandate) };
      }
      case 'newDevice':
        return { ownerSecret: unhex(need(h.newDevice, 'recovery request').ownerSecret) };
    }
  }

  /** One circuit call as one device; the wallet asks the person to approve it. */
  async call(h: Held, device: Device, circuit: string, ...args: unknown[]): Promise<Outcome> {
    try {
      const id = `${h.address.slice(0, 16)}-${device}`;
      await this.providers.privateStateProvider.forContract(h.address).set(id, this.stateOf(h, device));
      const tx = (await submitCallTx(this.providers, {
        compiledContract: compiledKeeproxy(ZK_BASE),
        contractAddress: h.address,
        privateStateId: id,
        circuitId: circuit,
        args,
      } as never)) as unknown as { public: { txId?: string; txHash?: string } };
      return { ok: true, txId: tx.public.txHash ?? tx.public.txId };
    } catch (e) {
      return { ok: false, error: reason(e) };
    }
  }

  // ------------------------------------------------------------ owner ----

  /**
   * Deploys a vault owned by a fresh secret held in this browser. Ten
   * transactions: the deploy, then nine verifier keys that do not fit in it.
   */
  async createVault(
    rules: { label: string; threshold: bigint; inactivity: bigint; veto: bigint },
    progress: Progress,
  ): Promise<Held> {
    const owner = bytes32();
    const vaultId = bytes32();
    const pendingKey = `keeproxy:pending-owner:${NETWORK}`;
    // Kept until the deploy lands, so a closed tab cannot strand the owner key.
    localStorage.setItem(pendingKey, hex(owner));
    try {
      const d = await deployStaged(this.providers, {
        assets: ZK_BASE,
        privateStateId: `deploy-${hex(vaultId).slice(0, 12)}`,
        initialPrivateState: { ownerSecret: owner },
        args: [vaultId, rules.threshold, rules.inactivity, rules.veto, nowSec() - 30n],
        onProgress: ({ stage, circuit, index, total }) =>
          progress(stage === 'deploy' ? `Approve ${index}/${total}: deploy the vault` : `Approve ${index}/${total}: install ${circuit}`),
      });
      const held: Held = {
        address: d.contractAddress,
        network: NETWORK,
        label: rules.label || 'My vault',
        createdAt: new Date().toISOString(),
        owner: hex(owner),
      };
      saveHeld(held);
      return held;
    } catch (e) {
      throw new Error(reason(e));
    } finally {
      localStorage.removeItem(pendingKey);
    }
  }

  deposit = (h: Held, amount: bigint) => this.call(h, 'owner', 'deposit', amount);
  withdraw = (h: Held, amount: bigint) => this.call(h, 'owner', 'withdraw', { bytes: this.myAddress() }, amount);
  heartbeat = (h: Held) => this.call(h, 'owner', 'heartbeat', nowSec());
  revokeMandates = (h: Held) => this.call(h, 'owner', 'revokeMandates');

  /** Enrolls a guardian or heir from the code they generated on their own device. */
  async enrollCode(h: Held, code: string): Promise<Outcome> {
    const c = decodeJoin(code);
    if (c.vault !== h.address) return { ok: false, error: 'That code was made for a different vault' };
    return this.call(h, 'owner', 'enroll', c.role === 'guardian' ? Role.GUARDIAN : Role.HEIR, unhex(c.leaf));
  }

  /**
   * Issues an AI-agent mandate: a fresh agent key and private terms, enrolled
   * as one hash, plus one payee. The agent's key file is kept here and can be
   * handed to the agent's runtime.
   */
  async issueMandate(
    h: Held,
    terms: { cap: bigint; epochDays: number; expiresInDays: number; payee: string },
    progress: Progress,
  ): Promise<Outcome> {
    const l = await this.ledger(h.address);
    const agent = bytes32();
    const mandate: Mandate = {
      agentPk: pc.agentKeyOf(agent, l.vaultId),
      capPerEpoch: terms.cap,
      epochSeconds: BigInt(Math.round(terms.epochDays * 86_400)),
      expiresAt: nowSec() + BigInt(Math.round(terms.expiresInDays * 86_400)),
      generation: l.mandateGeneration,
      salt: bytes32(),
    };
    const payee = this.addressBytes(terms.payee);
    progress('Approve 1/2: enroll the mandate');
    const m = await this.call(h, 'owner', 'enroll', Role.MANDATE, pc.mandateLeafOf(mandate));
    if (!m.ok) return m;
    progress('Approve 2/2: enroll the payee');
    const p = await this.call(h, 'owner', 'enroll', Role.PAYEE, pc.payeeLeafOf(payee, mandate.salt));
    if (!p.ok) return p;
    h.agent = { sk: hex(agent), mandate: mandateTo(mandate) };
    saveHeld(h);
    return p;
  }

  agentPay = (h: Held, to: string, amount: bigint) =>
    this.call(h, 'agent', 'agentPay', { bytes: this.addressBytes(to) }, amount, nowSec());

  // ------------------------------------------------ guardians and heirs ----

  /** Makes this browser a guardian candidate for `address`; returns the code for the owner. */
  async joinAsGuardian(address: string): Promise<string> {
    const l = await this.ledger(address);
    const prev = loadHeld().find((x) => x.address === address);
    const sk = prev?.guardian ? unhex(prev.guardian) : bytes32();
    const held: Held = prev ?? { address, network: NETWORK, label: 'Guarded vault', createdAt: new Date().toISOString() };
    held.guardian = hex(sk);
    saveHeld(held);
    return encodeJoin({ role: 'guardian', vault: address, leaf: hex(pc.guardianLeafOf(sk, l.vaultId)) });
  }

  async joinAsHeir(address: string, bps: number): Promise<string> {
    if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) throw new Error('A share is 1 to 10000 basis points');
    const l = await this.ledger(address);
    const prev = loadHeld().find((x) => x.address === address);
    const sk = prev?.heir ? unhex(prev.heir.sk) : bytes32();
    const held: Held = prev ?? { address, network: NETWORK, label: 'Inherited vault', createdAt: new Date().toISOString() };
    held.heir = { sk: hex(sk), bps: String(bps) };
    saveHeld(held);
    const leaf = pc.heirLeafOf(pc.heirKeyOf(sk, l.vaultId), BigInt(bps));
    return encodeJoin({ role: 'heir', vault: address, leaf: hex(leaf), bps });
  }

  /** A new device asks to become the owner; a guardian opens the recovery with this code. */
  async requestRecovery(address: string): Promise<string> {
    const l = await this.ledger(address);
    const prev = loadHeld().find((x) => x.address === address);
    const ownerSecret = prev?.newDevice ? unhex(prev.newDevice.ownerSecret) : bytes32();
    const held: Held = prev ?? { address, network: NETWORK, label: 'Recovering vault', createdAt: new Date().toISOString() };
    held.newDevice = { ownerSecret: hex(ownerSecret) };
    saveHeld(held);
    const deviceKey = new Uint8Array(await crypto.subtle.digest('SHA-256', ownerSecret));
    return encodeRecovery(address, hex(pc.ownerKeyOf(ownerSecret, l.vaultId)), hex(deviceKey));
  }

  async openRecovery(h: Held, code: string): Promise<Outcome> {
    const r = decodeRecovery(code);
    if (r.vault !== h.address) return { ok: false, error: 'That request was made for a different vault' };
    return this.call(h, 'guardian', 'openRecovery', unhex(r.ownerKey), unhex(r.deviceKey), nowSec());
  }

  approveRecovery = (h: Held) => this.call(h, 'guardian', 'approveRecovery');
  finalizeRecovery = (h: Held) => this.call(h, 'guardian', 'finalizeRecovery', nowSec());
  triggerInheritance = (h: Held) => this.call(h, 'guardian', 'triggerInheritance', nowSec());
  claimInheritance = (h: Held) => this.call(h, 'heir', 'claimInheritance', { bytes: this.myAddress() });

  /** After a recovery finalizes to this device's key, it becomes the owner here. */
  async adoptRecoveredOwnership(h: Held): Promise<boolean> {
    if (!h.newDevice) return false;
    const l = await this.ledger(h.address);
    if (hex(l.ownerKey) !== hex(pc.ownerKeyOf(unhex(h.newDevice.ownerSecret), l.vaultId))) return false;
    h.owner = h.newDevice.ownerSecret;
    delete h.newDevice;
    saveHeld(h);
    return true;
  }
}

const mandateTo = (m: Mandate): Record<string, string> => ({
  agentPk: hex(m.agentPk),
  capPerEpoch: m.capPerEpoch.toString(),
  epochSeconds: m.epochSeconds.toString(),
  expiresAt: m.expiresAt.toString(),
  generation: m.generation.toString(),
  salt: hex(m.salt),
});

const mandateFrom = (m: Record<string, string>): Mandate => ({
  agentPk: unhex(m['agentPk']!),
  capPerEpoch: BigInt(m['capPerEpoch']!),
  epochSeconds: BigInt(m['epochSeconds']!),
  expiresAt: BigInt(m['expiresAt']!),
  generation: BigInt(m['generation']!),
  salt: unhex(m['salt']!),
});
