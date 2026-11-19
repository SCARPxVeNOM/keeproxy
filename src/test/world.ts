// Shared fixtures for the in-memory tests: a deployed vault with roles
// enrolled, and helpers that switch which device is acting.

import { randomBytes } from 'node:crypto';
import { Sim } from './sim.js';
import {
  Contract,
  Role,
  ledger,
  pureCircuits as pc,
  type Ledger,
  type Mandate,
} from '../../contract/managed/proxy/contract/index.js';
import { type KeeproxyPrivateState, witnesses } from '../../contract/witnesses.js';

export const bytes32 = () => new Uint8Array(randomBytes(32));
export const addr = () => ({ bytes: bytes32() });

export const T0 = 1_800_000_000; // a fixed "now" so the timers are readable
export const DAY = 86_400;
export const WEEK = 7 * DAY;
export const THRESHOLD = 2n;
export const INACTIVITY = BigInt(180 * DAY);
export const VETO = BigInt(3 * DAY);

export type KSim = Sim<Contract<KeeproxyPrivateState>, KeeproxyPrivateState, Ledger>;

export interface World {
  sim: KSim;
  vault: Uint8Array;
  owner: Uint8Array;
  guardians: Uint8Array[];
  heirs: { sk: Uint8Array; bps: bigint }[];
  agent: Uint8Array;
  mandate: Mandate;
  payee: { bytes: Uint8Array };
}

export const now = (sim: KSim) => BigInt(sim.time);

export async function deploy(owner: Uint8Array = bytes32(), contract = new Contract(witnesses), vaultId = bytes32()): Promise<KSim> {
  return Sim.deploy({
    contract,
    ledger,
    privateState: { ownerSecret: owner },
    args: [vaultId, THRESHOLD, INACTIVITY, VETO, BigInt(T0)],
    time: T0,
  });
}

/** The vault id every key and nullifier is bound to. */
export const vaultOf = (sim: KSim) => sim.ledger().vaultId;

/** Owner device acting. */
export const asOwner = (w: World, sk = w.owner) => {
  w.sim.privateState = { ownerSecret: sk };
  return w.sim;
};
export const asGuardian = (w: World, i: number) => {
  w.sim.privateState = { guardianSecret: w.guardians[i]! };
  return w.sim;
};
export const asAgent = (w: World, mandate = w.mandate, sk = w.agent) => {
  w.sim.privateState = { agentSecret: sk, mandate };
  return w.sim;
};
export const asHeir = (w: World, i: number) => {
  w.sim.privateState = { heirSecret: w.heirs[i]!.sk, heirShareBps: w.heirs[i]!.bps };
  return w.sim;
};

export interface WorldOptions {
  owner?: Uint8Array;
  guardians?: Uint8Array[];
  heirBps?: bigint[];
  deposit?: bigint;
}

/**
 * A vault with 3 guardians (2 needed), 2 heirs (60/40), one agent mandate
 * (cap 200 a week, 30 days) and one payee, funded with 1000. Options change
 * the roles and the deposit.
 */
export async function world(opts: WorldOptions = {}): Promise<World> {
  const owner = opts.owner ?? bytes32();
  const sim = await deploy(owner);
  const vault = vaultOf(sim);
  const w: World = {
    sim,
    vault,
    owner,
    guardians: opts.guardians ?? [bytes32(), bytes32(), bytes32()],
    heirs: (opts.heirBps ?? [6000n, 4000n]).map((bps) => ({ sk: bytes32(), bps })),
    agent: bytes32(),
    mandate: undefined as unknown as Mandate,
    payee: addr(),
  };
  w.mandate = {
    agentPk: pc.agentKeyOf(w.agent, vault),
    capPerEpoch: 200n,
    epochSeconds: BigInt(WEEK),
    expiresAt: BigInt(T0 + 30 * DAY),
    generation: 0n,
    salt: bytes32(),
  };
  asOwner(w);
  for (const g of w.guardians) await sim.call('enroll', Role.GUARDIAN, pc.guardianLeafOf(g, vault));
  for (const h of w.heirs) await sim.call('enroll', Role.HEIR, pc.heirLeafOf(pc.heirKeyOf(h.sk, vault), h.bps));
  await sim.call('enroll', Role.MANDATE, pc.mandateLeafOf(w.mandate));
  await sim.call('enroll', Role.PAYEE, pc.payeeLeafOf(w.payee.bytes, w.mandate.salt));
  await sim.call('deposit', opts.deposit ?? 1000n);
  return w;
}

/** Guardians `approvers[0]` opens and the rest approve a recovery to `newOwner`, then it finalizes after the veto window. */
export async function recover(w: World, newOwner: Uint8Array, approvers = [0, 1], deviceKey = bytes32()) {
  await asGuardian(w, approvers[0]!).call('openRecovery', pc.ownerKeyOf(newOwner, w.vault), deviceKey, now(w.sim));
  for (const g of approvers.slice(1)) await asGuardian(w, g).call('approveRecovery');
  w.sim.advance(Number(VETO));
  return w.sim.call('finalizeRecovery', now(w.sim));
}
