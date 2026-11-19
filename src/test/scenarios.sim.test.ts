// Scenario tests: longer stories that cross several powers, exact boundary
// values for every timer and cap, the estate arithmetic, and unlinkability
// across vaults. Same in-memory simulator as keeproxy.sim.test.ts.

import { describe, expect, it } from 'vitest';
import { expectRejects } from './sim.js';
import { Contract, Phase, Role, pureCircuits as pc } from '../../contract/managed/proxy/contract/index.js';
import { witnesses } from '../../contract/witnesses.js';
import { decryptBackup, encryptBackup } from '../restore.js';
import {
  DAY, INACTIVITY, T0, VETO, WEEK, addr, asAgent, asGuardian, asHeir, asOwner, bytes32, deploy, now, recover, vaultOf, world,
} from './world.js';

describe('scenario: one vault, a whole life', () => {
  it('delegates, survives a lost laptop, restores, re-delegates, then passes to the heirs', async () => {
    const w = await world();

    // Week 1 and week 2: the agent spends under its private cap.
    await asAgent(w).call('agentPay', w.payee, 150n, now(w.sim));
    w.sim.advance(WEEK);
    await asAgent(w).call('agentPay', w.payee, 200n, now(w.sim));
    expect(w.sim.ledger().balance).toBe(650n);

    // The owner backs up their private state, then loses the laptop.
    const state = new TextEncoder().encode(JSON.stringify({ ownerSecret: Buffer.from(w.owner).toString('hex') }));
    const v1 = encryptBackup(state, 1n);
    await asOwner(w).call('anchorBackup', v1.backup.digest, 1n);

    // Guardians 1 and 2 (not the one who will later disclose) move the vault.
    const phone = bytes32();
    const { ledger: r } = await recover(w, phone, [1, 2]);
    expect(r.ownerKey).toEqual(pc.ownerKeyOf(phone, w.vault));
    expect(r.mandateGeneration).toBe(1n);

    // The stolen laptop can do nothing an owner can.
    const thief = () => asOwner(w);
    await expectRejects(() => thief().call('heartbeat', now(w.sim)), 'Only the owner can do this');
    await expectRejects(() => thief().call('withdraw', addr(), 1n), 'Only the owner can do this');
    await expectRejects(() => thief().call('anchorBackup', bytes32(), 9n), 'Only the owner can do this');
    await expectRejects(() => thief().call('revokeMandates'), 'Only the owner can do this');
    await expectRejects(() => thief().call('enroll', Role.GUARDIAN, bytes32()), 'Only the owner can do this');

    // The new phone restores the anchored backup, then anchors v2.
    const anchored = { digest: w.sim.ledger().backupDigest, version: w.sim.ledger().backupVersion };
    expect(decryptBackup(v1.backup, v1.key, anchored)).toEqual(state);
    const v2 = encryptBackup(state, 2n);
    await asOwner(w, phone).call('anchorBackup', v2.backup.digest, 2n);
    expect(() => decryptBackup(v1.backup, v1.key, { digest: v2.backup.digest, version: 2n })).toThrow('Stale backup');

    // The old mandate died with the old key; the new owner issues a fresh one.
    await expectRejects(() => asAgent(w).call('agentPay', w.payee, 10n, now(w.sim)), 'Mandate was revoked');
    const fresh = { ...w.mandate, generation: 1n, salt: bytes32(), expiresAt: now(w.sim) + BigInt(30 * DAY) };
    await asOwner(w, phone).call('enroll', Role.MANDATE, pc.mandateLeafOf(fresh));
    await w.sim.call('enroll', Role.PAYEE, pc.payeeLeafOf(w.payee.bytes, fresh.salt));
    await asAgent(w, fresh).call('agentPay', w.payee, 100n, now(w.sim));
    expect(w.sim.ledger().balance).toBe(550n);

    // Guardians 1 and 2 release their restore shares for this round.
    await asGuardian(w, 1).call('releaseShare', new Uint8Array([1]));
    await asGuardian(w, 2).call('releaseShare', new Uint8Array([2]));

    // Then the new owner goes silent for good.
    w.sim.advance(Number(INACTIVITY));
    const { ledger: t } = await w.sim.call('triggerInheritance', now(w.sim));
    expect(t.estate).toBe(550n);
    await asHeir(w, 0).call('claimInheritance', addr());
    await asHeir(w, 1).call('claimInheritance', addr());
    const end = w.sim.ledger();
    expect(end.estatePaid).toBe(550n); // 330 + 220
    expect(end.balance).toBe(0n);

    // DISCLOSE uses its own round: a guardian that released for RESTORE may release again.
    const released = w.sim.ledger().releasedShares.size();
    await asGuardian(w, 1).call('releaseShare', new Uint8Array([3]));
    expect(w.sim.ledger().releasedShares.size()).toBe(released + 1n);
    expect(w.sim.ledger().phase).toBe(Phase.INHERITED);
  });
});

describe('scenario: hostile takeover by colluding guardians', () => {
  it('is vetoed by a live owner in every round, and nothing moves', async () => {
    const w = await world();
    const before = w.sim.ledger();
    const attacker = bytes32();
    for (let round = 1n; round <= 3n; round++) {
      await asGuardian(w, 0).call('openRecovery', pc.ownerKeyOf(attacker, w.vault), bytes32(), now(w.sim));
      await asGuardian(w, 1).call('approveRecovery');
      expect(w.sim.ledger().recoveryRound).toBe(round);
      w.sim.advance(Number(VETO) - 3600);
      await asOwner(w).call('heartbeat', now(w.sim));
      w.sim.advance(3600);
      await expectRejects(() => w.sim.call('finalizeRecovery', now(w.sim)), 'No recovery is open');
    }
    const after = w.sim.ledger();
    expect(after.ownerKey).toEqual(before.ownerKey);
    expect(after.balance).toBe(before.balance);
    expect(after.ownerRotations).toBe(0n);
    // Two approvals per round, each under a fresh round-scoped nullifier.
    expect(after.approvalNullifiers.size()).toBe(6n);
  });

  it('cannot reach the threshold with one guardian approving under two names', async () => {
    const w = await world();
    await asGuardian(w, 0).call('openRecovery', bytes32(), bytes32(), now(w.sim));
    await expectRejects(() => asGuardian(w, 0).call('approveRecovery'), 'This guardian already approved');
    w.sim.advance(Number(VETO));
    await expectRejects(() => w.sim.call('finalizeRecovery', now(w.sim)), 'Not enough guardian approvals');
  });
});

describe('scenario: the owner dies while a recovery is open', () => {
  it('lets inheritance win, and the pending recovery can no longer finalize', async () => {
    const w = await world();
    w.sim.advance(Number(INACTIVITY) - DAY);
    await asGuardian(w, 0).call('openRecovery', pc.ownerKeyOf(bytes32(), w.vault), bytes32(), now(w.sim));
    await asGuardian(w, 1).call('approveRecovery');
    w.sim.advance(DAY);
    await w.sim.call('triggerInheritance', now(w.sim));
    w.sim.advance(Number(VETO));
    await expectRejects(() => w.sim.call('finalizeRecovery', now(w.sim)), 'No recovery is open');
    await asHeir(w, 0).call('claimInheritance', addr());
    expect(w.sim.ledger().estatePaid).toBe(600n);
  });
});

describe('boundaries: every timer and cap at its exact edge', () => {
  it('finalizes a recovery exactly when the veto window closes, not a second earlier', async () => {
    const w = await world();
    await asGuardian(w, 0).call('openRecovery', pc.ownerKeyOf(bytes32(), w.vault), bytes32(), now(w.sim));
    await asGuardian(w, 1).call('approveRecovery');
    w.sim.advance(Number(VETO) - 1);
    await expectRejects(() => w.sim.call('finalizeRecovery', now(w.sim)), 'Veto window is still open');
    w.sim.advance(1);
    expect((await w.sim.call('finalizeRecovery', now(w.sim))).ledger.ownerRotations).toBe(1n);
  });

  it('triggers inheritance exactly at the end of the inactivity period, not a second earlier', async () => {
    const w = await world();
    w.sim.advance(Number(INACTIVITY) - 1);
    await expectRejects(() => w.sim.call('triggerInheritance', now(w.sim)), 'Owner is still active');
    w.sim.advance(1);
    expect((await w.sim.call('triggerInheritance', now(w.sim))).ledger.phase).toBe(Phase.INHERITED);
  });

  it('honours a mandate until the second before it expires', async () => {
    const w = await world();
    w.sim.time = Number(w.mandate.expiresAt) - 1;
    await asAgent(w).call('agentPay', w.payee, 1n, now(w.sim));
    w.sim.advance(1);
    await expectRejects(() => asAgent(w).call('agentPay', w.payee, 1n, now(w.sim)), 'Mandate has expired');
  });

  it('allows exactly the cap per epoch, and a full cap again one second into the next epoch', async () => {
    const w = await world();
    const nextEpoch = (Math.floor(w.sim.time / WEEK) + 1) * WEEK;
    w.sim.time = nextEpoch - 1;
    await asAgent(w).call('agentPay', w.payee, 200n, now(w.sim));
    await expectRejects(() => w.sim.call('agentPay', w.payee, 1n, now(w.sim)), "exceeds the mandate's cap");
    w.sim.advance(1);
    await w.sim.call('agentPay', w.payee, 200n, now(w.sim));
    expect(w.sim.ledger().epochSpend.size()).toBe(2n);
  });

  it('accepts a timestamp up to 899 seconds old, and refuses 900 or any future second', async () => {
    const w = await world();
    w.sim.advance(DAY);
    asOwner(w);
    await w.sim.call('heartbeat', now(w.sim) - 899n);
    await expectRejects(() => w.sim.call('heartbeat', now(w.sim) - 900n), 'Timestamp is stale');
    await expectRejects(() => w.sim.call('heartbeat', now(w.sim) + 1n), 'Timestamp is in the future');
  });

  it('refuses zero-value payments and deposits', async () => {
    const w = await world();
    await expectRejects(() => asAgent(w).call('agentPay', w.payee, 0n, now(w.sim)), 'Payment must be positive');
    await expectRejects(() => w.sim.call('deposit', 0n), 'Deposit must be positive');
  });

  it('accepts deposits but freezes withdrawals while a recovery is open', async () => {
    const w = await world();
    await asGuardian(w, 0).call('openRecovery', bytes32(), bytes32(), now(w.sim));
    w.sim.privateState = {};
    expect((await w.sim.call('deposit', 5n)).ledger.balance).toBe(1005n);
    await expectRejects(() => asOwner(w).call('withdraw', addr(), 5n), 'Vault is not active');
    await expectRejects(() => w.sim.call('anchorBackup', bytes32(), 1n), 'Vault is not active');
  });
});

describe('estate arithmetic', () => {
  const inherit = async (heirBps: bigint[], deposit: bigint) => {
    const w = await world({ heirBps, deposit });
    w.sim.advance(Number(INACTIVITY));
    await w.sim.call('triggerInheritance', now(w.sim));
    return w;
  };

  it('pays each heir floor(estate × share / 10000) and leaves the rounding dust in the vault', async () => {
    const w = await inherit([3333n, 3333n, 3334n], 1001n);
    const paid: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const before = w.sim.ledger().balance;
      await asHeir(w, i).call('claimInheritance', addr());
      paid.push(before - w.sim.ledger().balance);
    }
    expect(paid).toEqual([333n, 333n, 333n]);
    expect(w.sim.ledger().estatePaid).toBe(999n);
    expect(w.sim.ledger().balance).toBe(2n);
  });

  it('gives a single heir with 100% the whole estate', async () => {
    const w = await inherit([10_000n], 777n);
    await asHeir(w, 0).call('claimInheritance', addr());
    expect(w.sim.ledger().balance).toBe(0n);
  });

  it('never pays out more than the estate, even if the owner over-allocated shares', async () => {
    const w = await inherit([7000n, 7000n], 1000n);
    await asHeir(w, 0).call('claimInheritance', addr());
    await expectRejects(() => asHeir(w, 1).call('claimInheritance', addr()), 'Estate is fully paid out');
    expect(w.sim.ledger().estatePaid).toBe(700n);
  });

  it('pays a dust-sized share as zero without failing the claim', async () => {
    const w = await inherit([1n, 9999n], 100n);
    await asHeir(w, 0).call('claimInheritance', addr());
    expect(w.sim.ledger().estatePaid).toBe(0n);
    expect([...w.sim.ledger().heirClaims]).toHaveLength(1);
  });

  it('refuses a lying witness that inflates the payout', async () => {
    const greedy = new Contract({ ...witnesses, shareOf: ({ privateState }, estate) => [privateState, estate] });
    const owner = bytes32();
    const sim = await deploy(owner, greedy);
    const heir = bytes32();
    sim.privateState = { ownerSecret: owner };
    await sim.call('enroll', Role.HEIR, pc.heirLeafOf(pc.heirKeyOf(heir, vaultOf(sim)), 5000n));
    await sim.call('deposit', 1000n);
    sim.advance(Number(INACTIVITY));
    await sim.call('triggerInheritance', BigInt(sim.time));
    sim.privateState = { heirSecret: heir, heirShareBps: 5000n };
    await expectRejects(() => sim.call('claimInheritance', addr()), 'Wrong share amount');
  });
});

describe('unlinkability across vaults', () => {
  it('gives one guardian secret different leaves and nullifiers in two vaults', async () => {
    const g = bytes32();
    const a = await world({ guardians: [g, bytes32(), bytes32()] });
    const b = await world({ guardians: [g, bytes32(), bytes32()] });
    expect(pc.guardianLeafOf(g, a.vault)).not.toEqual(pc.guardianLeafOf(g, b.vault));
    await asGuardian(a, 0).call('openRecovery', bytes32(), bytes32(), now(a.sim));
    await asGuardian(b, 0).call('openRecovery', bytes32(), bytes32(), now(b.sim));
    expect([...a.sim.ledger().approvalNullifiers]).not.toEqual([...b.sim.ledger().approvalNullifiers]);
  });

  it('gives one heir secret different claim nullifiers in two vaults', () => {
    const h = bytes32();
    expect(pc.claimNullifierOf(h, bytes32())).not.toEqual(pc.claimNullifierOf(h, bytes32()));
  });

  it('hides an heir share: the same key and share under two vaults commit differently', () => {
    const sk = bytes32();
    const leafA = pc.heirLeafOf(pc.heirKeyOf(sk, bytes32()), 5000n);
    const leafB = pc.heirLeafOf(pc.heirKeyOf(sk, bytes32()), 5000n);
    expect(leafA).not.toEqual(leafB);
  });

  it('spends in different epochs under unrelated keys', () => {
    const salt = bytes32();
    const k = [0n, 1n, 2n].map((e) => Buffer.from(pc.spendKeyOf(salt, e)).toString('hex'));
    expect(new Set(k).size).toBe(3);
  });
});
