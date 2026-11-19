# Keeproxy — contract spec

Who can act for you when you can't. One Compact contract (`contract/proxy.compact`), one vault per deployment, five powers.

## Roles

| Role | Holds (private state, never on chain) | Proves |
|---|---|---|
| Owner | `ownerSecret` | `ownerKeyOf(ownerSecret, vaultId) == ownerKey` |
| Agent | `agentSecret`, its `Mandate` | mandate enrolled, current, unexpired, payee allowlisted, under cap |
| Guardian ×n | `guardianSecret` | leaf `guardianLeafOf(secret, vaultId)` is in the guardian tree |
| Heir ×m | `heirSecret`, `shareBps` | leaf `heirLeafOf(heirKeyOf(secret, vaultId), bps)` is in the heir tree |
| New device | new `ownerSecret`, X25519 device key | (receives sealed shares; becomes owner after recovery) |

Every key, leaf and nullifier is domain-separated and bound to `vaultId` (random, sealed at deploy), so one secret reused in two vaults is unlinkable. (`kernel.self()` is not used: a constructor can't know its own address.)

## Public ledger

| Field | Meaning |
|---|---|
| `vaultId`, `threshold`, `inactivitySeconds`, `vetoSeconds` | sealed rules |
| `ownerKey`, `ownerRotations`, `phase`, `lastSeen`, `balance` | owner status |
| `guardians`, `heirs`, `mandates`, `payees` (MerkleTree<5>) | commitments only |
| `guardianCount`, `mandateGeneration` | counts / kill-switch generation |
| `epochSpend: Map<spendKey, Uint<64>>` | per (mandate, epoch), key = hash(salt, epoch) |
| `recoveryRound`, `pendingOwner`, `pendingDeviceKey`, `recoveryOpenedAt`, `approvals`, `approvalNullifiers`, `restoredRound` | recovery |
| `backupDigest`, `backupVersion`, `releasedShares` | restore |
| `estate`, `estatePaid`, `heirClaims` | inheritance |

## Circuits and their guards

| Circuit | Who | Refuses when |
|---|---|---|
| `deposit(amount)` | anyone | estate closed; amount 0 |
| `withdraw(to, amount)` | owner | not owner; not ACTIVE; balance short |
| `enroll(role, leaf)` | owner | not owner; not ACTIVE |
| `heartbeat(now)` | owner | not owner; estate closed; `now` in the future or >15 min old. **Cancels an open recovery (veto).** |
| `revokeMandates()` | owner | not owner |
| `agentPay(to, amount, now)` | agent | not ACTIVE; stale `now`; mandate not enrolled; wrong agent key; revoked generation; expired; payee not on this mandate's allowlist; wrong epoch witness; over cap this epoch; balance short |
| `openRecovery(newOwner, deviceKey, now)` | guardian | not ACTIVE; fewer guardians than threshold; not a guardian |
| `approveRecovery()` | guardian | no recovery open; not a guardian; already approved this round |
| `finalizeRecovery(now)` | anyone | no recovery open; approvals < threshold; veto window open. Rotates owner, revokes all mandates. |
| `anchorBackup(digest, version)` | owner | not owner; not ACTIVE; version not strictly greater |
| `releaseShare(sealed)` | guardian | no finalized recovery this round and not inherited; not a guardian; already released this round |
| `triggerInheritance(now)` | anyone | already inherited; owner seen within `inactivitySeconds`. Freezes estate, revokes mandates. |
| `claimInheritance(payout)` | heir | not inherited; share out of range; not an heir (wrong secret or wrong share); already claimed; wrong share witness; estate overpaid |

Time: callers pass `now`; `requireNow` pins it to the block clock (`blockTimeGte(now) && blockTimeLt(now + 900)`). Private deadlines (mandate expiry) are compared against `now`, so they never reach the kernel.

Division (`epoch = now / epochSeconds`, `share = estate * bps / 10000`) is done by a witness and checked in circuit by multiplication.

## Privacy invariants ("never on chain")

Checked by `assertNotInPublicState` in `src/test/keeproxy.sim.test.ts` and against the indexer in `src/test/keeproxy.test.ts`:

- owner secret (old and new)
- agent secret, agent public key, mandate salt and terms
- every guardian secret; which guardian approved (only per-round nullifiers are stored)
- every heir secret and heir key; heir shares (committed inside the leaf)
- payee addresses inside the allowlist tree

## Accepted leaks

- The vault's existence, rules, NIGHT balance and last heartbeat time.
- Circuit names (the indexer shows which entry point ran).
- Unshielded NIGHT payments show amount and recipient. Within one epoch, one mandate's payments share a spend key (linkable to each other, not across epochs or to the agent).
- An heir's share becomes visible through the payout amount when they claim.

## RESTORE off chain (`src/restore.ts`)

1. Owner encrypts its private state with AES-256-GCM (AAD binds the version), anchors `SHA-256(blob)` and the version.
2. The backup key is split k-of-n (Shamir over GF(256)); each guardian holds one share.
3. After a recovery, each guardian seals its share to `pendingDeviceKey` (ephemeral X25519 + HKDF + AES-GCM) and posts it with `releaseShare`.
4. The new device opens k shares, rebuilds the key, and refuses any backup whose digest or version differs from the ledger before decrypting.

## Deployment

13 verifier keys exceed a block's write limit in one transaction. `src/staged-deploy.ts` deploys the constructor with 4 entry points and inserts the other 9 verifier keys with maintenance transactions (ledger 9 refuses blank slots, so deferred entry points are left out of the initial state rather than left blank).

## Out of scope (roadmap)

- Shielded payouts (hide amounts and recipients).
- Restoring other Midnight dApps' private state through the same backup path (the SDK wrapper).
- Per-mandate revocation without revoking all; decoy vaults against coercion.
