// In-memory tests for Keeproxy: every guard in every circuit, the five
// powers end to end, and the privacy invariants in docs/SPEC.md. No network,
// no proofs: `npm run compile:fast && npm run test:sim`.

import { beforeEach, describe, expect, it } from 'vitest';
import { Sim, assertNotInPublicState, expectRejects, findInPublicState } from './sim.js';
import { Contract, Phase, Role, ledger, pureCircuits as pc } from '../../contract/managed/proxy/contract/index.js';
import { type KeeproxyPrivateState, witnesses } from '../../contract/witnesses.js';
import {
  DAY, INACTIVITY, T0, THRESHOLD, VETO, WEEK, addr, asAgent, asGuardian, asHeir, asOwner, bytes32, deploy, now, vaultOf, world,
  type World,
} from './world.js';

describe('deploy', () => {
  it('stores the owner as a vault-bound hash, and the sealed rules', async () => {
    const owner = bytes32();
    const sim = await deploy(owner);
    const l = sim.ledger();
    expect(l.ownerKey).toEqual(pc.ownerKeyOf(owner, vaultOf(sim)));
    expect(l.threshold).toBe(THRESHOLD);
    expect(l.inactivitySeconds).toBe(INACTIVITY);
    expect(l.vetoSeconds).toBe(VETO);
    expect(l.phase).toBe(Phase.ACTIVE);
    expect(l.lastSeen).toBe(BigInt(T0));
    expect(l.balance).toBe(0n);
  });

  it('rejects a zero threshold and a veto window longer than the inactivity period', async () => {
    const mk = (args: [Uint8Array, bigint, bigint, bigint, bigint]) =>
      Sim.deploy({ contract: new Contract(witnesses), ledger, privateState: { ownerSecret: bytes32() }, args, time: T0 });
    await expectRejects(() => mk([bytes32(), 0n, INACTIVITY, VETO, BigInt(T0)]), 'Threshold must be at least 1');
    await expectRejects(() => mk([bytes32(), 2n, VETO, INACTIVITY, BigInt(T0)]), 'Inactivity period must exceed the veto window');
  });

  it('gives the same owner secret unlinkable keys in two vaults', async () => {
    const owner = bytes32();
    const a = await deploy(owner);
    const b = await deploy(owner);
    expect(a.ledger().ownerKey).not.toEqual(b.ledger().ownerKey);
  });
});

describe('owner', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it('accepts deposits from anyone and tracks the balance', async () => {
    w.sim.privateState = {};
    const { ledger: l } = await w.sim.call('deposit', 250n);
    expect(l.balance).toBe(1250n);
    await expectRejects(() => w.sim.call('deposit', 0n), 'Deposit must be positive');
  });

  it('lets only the owner withdraw, within the balance', async () => {
    const to = addr();
    asOwner(w, bytes32());
    await expectRejects(() => w.sim.call('withdraw', to, 10n), 'Only the owner can do this');
    asOwner(w);
    await expectRejects(() => w.sim.call('withdraw', to, 5000n), 'Insufficient vault balance');
    expect((await w.sim.call('withdraw', to, 100n)).ledger.balance).toBe(900n);
  });

  it('lets only the owner enroll roles, and counts guardians', async () => {
    asOwner(w, bytes32());
    await expectRejects(() => w.sim.call('enroll', Role.GUARDIAN, bytes32()), 'Only the owner can do this');
    expect(w.sim.ledger().guardianCount).toBe(3n);
  });

  it('records a heartbeat only from the owner and only at the block time', async () => {
    w.sim.advance(DAY);
    asOwner(w, bytes32());
    await expectRejects(() => w.sim.call('heartbeat', now(w.sim)), 'Only the owner can do this');
    asOwner(w);
    await expectRejects(() => w.sim.call('heartbeat', now(w.sim) + 60n), 'Timestamp is in the future');
    await expectRejects(() => w.sim.call('heartbeat', now(w.sim) - 3600n), 'Timestamp is stale');
    expect((await w.sim.call('heartbeat', now(w.sim))).ledger.lastSeen).toBe(now(w.sim));
  });
});

describe('DELEGATE: agent payments under a private mandate', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it('pays an allowlisted recipient within the cap', async () => {
    const { ledger: l } = await asAgent(w).call('agentPay', w.payee, 120n, now(w.sim));
    expect(l.balance).toBe(880n);
    expect(l.epochSpend.size()).toBe(1n);
  });

  it('refuses a payment over the cap for the epoch, counting earlier spends', async () => {
    await asAgent(w).call('agentPay', w.payee, 150n, now(w.sim));
    await expectRejects(() => w.sim.call('agentPay', w.payee, 51n, now(w.sim)), "exceeds the mandate's cap");
    await w.sim.call('agentPay', w.payee, 50n, now(w.sim));
  });

  it('gives the agent a fresh cap in the next epoch, under an unlinkable spend key', async () => {
    await asAgent(w).call('agentPay', w.payee, 200n, now(w.sim));
    w.sim.advance(WEEK);
    const { ledger: l } = await w.sim.call('agentPay', w.payee, 200n, now(w.sim));
    const keys = [...l.epochSpend].map(([k]) => Buffer.from(k).toString('hex'));
    expect(new Set(keys).size).toBe(2);
  });

  it('refuses a recipient that is not on the mandate allowlist', async () => {
    await expectRejects(() => asAgent(w).call('agentPay', addr(), 10n, now(w.sim)), 'Recipient is not enrolled');
  });

  it("refuses a payee enrolled under another mandate's salt", async () => {
    const other = addr();
    asOwner(w);
    await w.sim.call('enroll', Role.PAYEE, pc.payeeLeafOf(other.bytes, bytes32()));
    await expectRejects(() => asAgent(w).call('agentPay', other, 10n, now(w.sim)), 'Recipient is not enrolled');
  });

  it('refuses an agent that does not hold the mandate key', async () => {
    await expectRejects(
      () => asAgent(w, w.mandate, bytes32()).call('agentPay', w.payee, 10n, now(w.sim)),
      "Caller is not this mandate's agent",
    );
  });

  it('refuses a mandate the owner never enrolled (forged terms)', async () => {
    const forged = { ...w.mandate, capPerEpoch: 1_000_000n };
    await expectRejects(() => asAgent(w, forged).call('agentPay', w.payee, 10n, now(w.sim)), 'Mandate is not enrolled');
  });

  it('refuses an expired mandate', async () => {
    w.sim.advance(31 * DAY);
    await expectRejects(() => asAgent(w).call('agentPay', w.payee, 10n, now(w.sim)), 'Mandate has expired');
  });

  it('refuses every mandate after the kill switch', async () => {
    asOwner(w, bytes32());
    await expectRejects(() => w.sim.call('revokeMandates'), 'Only the owner can do this');
    asOwner(w);
    await w.sim.call('revokeMandates');
    await expectRejects(() => asAgent(w).call('agentPay', w.payee, 10n, now(w.sim)), 'Mandate was revoked');
  });

  it('refuses a stale timestamp and an amount larger than the vault', async () => {
    await expectRejects(() => asAgent(w).call('agentPay', w.payee, 10n, now(w.sim) - 3600n), 'Timestamp is stale');
    const rich = { ...w.mandate, capPerEpoch: 10_000n, salt: bytes32() };
    asOwner(w);
    await w.sim.call('enroll', Role.MANDATE, pc.mandateLeafOf(rich));
    await w.sim.call('enroll', Role.PAYEE, pc.payeeLeafOf(w.payee.bytes, rich.salt));
    await expectRejects(() => asAgent(w, rich).call('agentPay', w.payee, 5000n, now(w.sim)), 'Insufficient vault balance');
  });

  it('refuses a lying witness that claims the wrong epoch', async () => {
    const lying = new Contract<KeeproxyPrivateState>({ ...witnesses, epochIndexOf: ({ privateState }) => [privateState, 0n] });
    const sim = await deploy(w.owner, lying);
    const m = { ...w.mandate, agentPk: pc.agentKeyOf(w.agent, vaultOf(sim)) };
    await sim.call('enroll', Role.MANDATE, pc.mandateLeafOf(m));
    await sim.call('enroll', Role.PAYEE, pc.payeeLeafOf(w.payee.bytes, m.salt));
    await sim.call('deposit', 100n);
    sim.privateState = { agentSecret: w.agent, mandate: m };
    await expectRejects(() => sim.call('agentPay', w.payee, 10n, BigInt(T0)), 'Wrong epoch index');
  });
});

describe('RECOVER: anonymous guardians with a veto window', () => {
  let w: World;
  const newOwner = bytes32();
  const deviceKey = bytes32();
  beforeEach(async () => {
    w = await world();
  });
  const open = (i = 0) => asGuardian(w, i).call('openRecovery', pc.ownerKeyOf(newOwner, w.vault), deviceKey, now(w.sim));

  it('rotates the owner after k approvals and the veto window', async () => {
    await open(0);
    await asGuardian(w, 1).call('approveRecovery');
    w.sim.advance(Number(VETO));
    const { ledger: l } = await w.sim.call('finalizeRecovery', now(w.sim));
    expect(l.ownerKey).toEqual(pc.ownerKeyOf(newOwner, w.vault));
    expect(l.phase).toBe(Phase.ACTIVE);
    expect(l.ownerRotations).toBe(1n);
    // The lost device is now useless.
    await expectRejects(() => asOwner(w).call('heartbeat', now(w.sim)), 'Only the owner can do this');
    await asOwner(w, newOwner).call('heartbeat', now(w.sim));
  });

  it('refuses a stranger who is not a guardian', async () => {
    w.sim.privateState = { guardianSecret: bytes32() };
    await expectRejects(
      () => w.sim.call('openRecovery', bytes32(), bytes32(), now(w.sim)),
      'Guardian is not enrolled',
    );
  });

  it('refuses the same guardian approving twice', async () => {
    await open(0);
    await expectRejects(() => asGuardian(w, 0).call('approveRecovery'), 'This guardian already approved');
  });

  it('refuses to finalize below the threshold', async () => {
    await open(0);
    w.sim.advance(Number(VETO));
    await expectRejects(() => w.sim.call('finalizeRecovery', now(w.sim)), 'Not enough guardian approvals');
  });

  it('refuses to finalize inside the veto window', async () => {
    await open(0);
    await asGuardian(w, 1).call('approveRecovery');
    w.sim.advance(Number(VETO) - 60);
    await expectRejects(() => w.sim.call('finalizeRecovery', now(w.sim)), 'Veto window is still open');
  });

  it('lets the owner veto a hostile recovery with one heartbeat', async () => {
    await open(0);
    await asGuardian(w, 1).call('approveRecovery');
    w.sim.advance(DAY);
    const { ledger: l } = await asOwner(w).call('heartbeat', now(w.sim));
    expect(l.phase).toBe(Phase.ACTIVE);
    expect(l.approvals).toBe(0n);
    w.sim.advance(Number(VETO));
    await expectRejects(() => w.sim.call('finalizeRecovery', now(w.sim)), 'No recovery is open');
  });

  it('starts a fresh round after a veto, so earlier approvals do not carry over', async () => {
    await open(0);
    await asOwner(w).call('heartbeat', now(w.sim));
    await open(0); // the same guardian can open the next round
    expect(w.sim.ledger().recoveryRound).toBe(2n);
    expect(w.sim.ledger().approvals).toBe(1n);
  });

  it('freezes agent payments while a recovery is open and kills mandates after it', async () => {
    await open(0);
    await expectRejects(() => asAgent(w).call('agentPay', w.payee, 10n, now(w.sim)), 'Vault is not active');
    await asGuardian(w, 1).call('approveRecovery');
    w.sim.advance(Number(VETO));
    await w.sim.call('finalizeRecovery', now(w.sim));
    await expectRejects(() => asAgent(w).call('agentPay', w.payee, 10n, now(w.sim)), 'Mandate was revoked');
  });

  it('refuses a recovery when the vault has fewer guardians than its threshold', async () => {
    const sim = await deploy();
    sim.privateState = { guardianSecret: bytes32() };
    await expectRejects(
      () => sim.call('openRecovery', bytes32(), bytes32(), BigInt(T0)),
      'Vault has fewer guardians than its threshold',
    );
  });
});

describe('RESTORE: anchored backups and sealed share release', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it('anchors a backup digest whose version only moves forward', async () => {
    const d1 = bytes32();
    asOwner(w);
    await w.sim.call('anchorBackup', d1, 1n);
    await expectRejects(() => w.sim.call('anchorBackup', bytes32(), 1n), 'Backup version must increase');
    await expectRejects(() => w.sim.call('anchorBackup', bytes32(), 0n), 'Backup version must increase');
    const { ledger: l } = await w.sim.call('anchorBackup', bytes32(), 2n);
    expect(l.backupVersion).toBe(2n);
    asOwner(w, bytes32());
    await expectRejects(() => w.sim.call('anchorBackup', bytes32(), 3n), 'Only the owner can do this');
  });

  it('refuses share release before any recovery', async () => {
    await expectRejects(
      () => asGuardian(w, 0).call('releaseShare', new Uint8Array([1, 2, 3])),
      'No recovery or inheritance to release shares for',
    );
  });

  it('releases one sealed share per guardian to the new device after a recovery', async () => {
    const newOwner = bytes32();
    await asGuardian(w, 0).call('openRecovery', pc.ownerKeyOf(newOwner, w.vault), bytes32(), now(w.sim));
    await asGuardian(w, 1).call('approveRecovery');
    w.sim.advance(Number(VETO));
    await w.sim.call('finalizeRecovery', now(w.sim));

    await asGuardian(w, 0).call('releaseShare', new Uint8Array([9, 9]));
    await asGuardian(w, 1).call('releaseShare', new Uint8Array([8, 8]));
    await expectRejects(
      () => asGuardian(w, 0).call('releaseShare', new Uint8Array([7])),
      'This guardian already released its share',
    );
    w.sim.privateState = { guardianSecret: bytes32() };
    await expectRejects(() => w.sim.call('releaseShare', new Uint8Array([1])), 'Guardian is not enrolled');
    expect(w.sim.ledger().releasedShares.size()).toBe(2n);
  });
});

describe('INHERIT: silence, then private shares', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it('refuses to trigger while the owner is active', async () => {
    w.sim.advance(Number(INACTIVITY) - DAY);
    await expectRejects(() => w.sim.call('triggerInheritance', now(w.sim)), 'Owner is still active');
  });

  it('pays each heir their share once, then closes the estate', async () => {
    w.sim.advance(Number(INACTIVITY));
    w.sim.privateState = {};
    const { ledger: t } = await w.sim.call('triggerInheritance', now(w.sim));
    expect(t.phase).toBe(Phase.INHERITED);
    expect(t.estate).toBe(1000n);

    await asHeir(w, 0).call('claimInheritance', addr());
    expect(w.sim.ledger().balance).toBe(400n);
    await expectRejects(() => asHeir(w, 0).call('claimInheritance', addr()), 'This heir already claimed');
    await asHeir(w, 1).call('claimInheritance', addr());
    const l = w.sim.ledger();
    expect(l.balance).toBe(0n);
    expect(l.estatePaid).toBe(1000n);

    await expectRejects(() => asOwner(w).call('heartbeat', now(w.sim)), 'The estate is closed');
    await expectRejects(() => w.sim.call('deposit', 5n), 'The estate is closed');
    await expectRejects(() => asAgent(w).call('agentPay', w.payee, 1n, now(w.sim)), 'Vault is not active');
  });

  it('refuses a claim before inheritance triggers', async () => {
    await expectRejects(() => asHeir(w, 0).call('claimInheritance', addr()), 'Inheritance has not triggered');
  });

  it('refuses a stranger and an heir who lies about their share', async () => {
    w.sim.advance(Number(INACTIVITY));
    await w.sim.call('triggerInheritance', now(w.sim));
    w.sim.privateState = { heirSecret: bytes32(), heirShareBps: 5000n };
    await expectRejects(() => w.sim.call('claimInheritance', addr()), 'Heir is not enrolled');
    w.sim.privateState = { heirSecret: w.heirs[1]!.sk, heirShareBps: 9000n };
    await expectRejects(() => w.sim.call('claimInheritance', addr()), 'Heir is not enrolled');
    w.sim.privateState = { heirSecret: w.heirs[1]!.sk, heirShareBps: 0n };
    await expectRejects(() => w.sim.call('claimInheritance', addr()), 'Share out of range');
  });

  it('lets a heartbeat push inheritance back', async () => {
    w.sim.advance(Number(INACTIVITY) - DAY);
    await asOwner(w).call('heartbeat', now(w.sim));
    w.sim.advance(2 * DAY);
    await expectRejects(() => w.sim.call('triggerInheritance', now(w.sim)), 'Owner is still active');
  });

  it('DISCLOSE: lets guardians release sealed document shares once inherited', async () => {
    w.sim.advance(Number(INACTIVITY));
    await w.sim.call('triggerInheritance', now(w.sim));
    await asGuardian(w, 2).call('releaseShare', new Uint8Array([4, 2]));
    await expectRejects(() => asGuardian(w, 2).call('releaseShare', new Uint8Array([4])), 'already released');
    await expectRejects(() => w.sim.call('triggerInheritance', now(w.sim)), 'Inheritance already triggered');
  });
});

// docs/SPEC.md → Privacy invariants. One entry per "never on chain" line.
describe('privacy invariants', () => {
  it('keeps every secret, mandate term, payee and heir share out of public state', async () => {
    const w = await world();
    await asAgent(w).call('agentPay', w.payee, 120n, now(w.sim));
    const newOwner = bytes32();
    await asGuardian(w, 0).call('openRecovery', pc.ownerKeyOf(newOwner, w.vault), bytes32(), now(w.sim));
    await asGuardian(w, 2).call('approveRecovery');
    const l = w.sim.ledger();

    // Control: the owner key hash is public by design and is found.
    expect(findInPublicState(l, pc.ownerKeyOf(w.owner, w.vault))).toBe('ownerKey');

    const secrets: Record<string, Uint8Array> = {
      ownerSecret: w.owner,
      newOwnerSecret: newOwner,
      agentSecret: w.agent,
      agentPublicKey: w.mandate.agentPk,
      mandateSalt: w.mandate.salt,
      payeeAddressInTree: w.payee.bytes, // public only as the recipient of a payment effect, never in ledger state
    };
    w.guardians.forEach((g, i) => (secrets[`guardianSecret${i}`] = g));
    w.heirs.forEach((h, i) => {
      secrets[`heirSecret${i}`] = h.sk;
      secrets[`heirKey${i}`] = pc.heirKeyOf(h.sk, w.vault);
    });
    assertNotInPublicState(l, secrets);
  });

  it('never stores which guardian approved: only per-round nullifiers', async () => {
    const w = await world();
    await asGuardian(w, 0).call('openRecovery', bytes32(), bytes32(), now(w.sim));
    const l = w.sim.ledger();
    const leaf = pc.guardianLeafOf(w.guardians[0]!, w.vault);
    const nullifiers = [...l.approvalNullifiers];
    expect(nullifiers).toHaveLength(1);
    expect(nullifiers[0]).not.toEqual(leaf);
    expect(nullifiers[0]).toEqual(pc.approvalNullifierOf(w.guardians[0]!, 1n, w.vault));
  });
});
