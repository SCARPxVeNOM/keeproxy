# Keeproxy: Midnight Buildathon, Wave 3 submission

**Tagline:** Who can act for you when you can't. A whole-life vault on Midnight for your AI agent, guardians and heirs, private by default.

**Positioning:** Keeproxy is not an agent-payments product. Agent spending is one of five powers in a vault built to outlive a lost device or its owner, and the other powers can switch the agent off: recovery and inheritance revoke every mandate in the same transaction.

**For judges:** [`JUDGES.md`](../JUDGES.md) has a five-minute test path and the limits we know about.

**Repo:** https://github.com/SCARPxVeNOM/keeproxy (Apache-2.0, topic `midnightntwrk`)

## The problem

A seed phrase is a single point of failure: lose the device and the assets are gone, die and nobody can reach them, and handing an AI agent your keys means handing it everything. The standard fixes (multisig, social recovery, a will) publish who your guardians and heirs are and what you hold, which is a map for coercion.

## What we built this Wave (new project)

- **`contract/proxy.compact`**: 13 circuits in one vault, Compact 0.36.1, ledger 9.
  - **DELEGATE.** `agentPay` proves an enrolled, current, unexpired private mandate, an allowlisted payee and the per-epoch cap, without revealing the agent, the terms or the allowlist. Plus a kill switch.
  - **RECOVER.** Anonymous k-of-n guardians (Merkle proofs and per-round nullifiers), a veto window, and owner key rotation that revokes every agent mandate.
  - **RESTORE.** Encrypted private-state backups whose digest and version are anchored on chain (a rollback is refused); guardians release key shares sealed to the new device's X25519 key.
  - **INHERIT and DISCLOSE.** An inactivity timer, a frozen estate, and heirs with private shares who each claim once; guardians release sealed document keys after inheritance triggers.
- **Tests.** 85 in-memory tests: 38 for every contract guard plus privacy invariants (`assertNotInPublicState` walks the whole public ledger), 20 multi-step scenarios and exact boundary cases, and 27 for the RESTORE crypto and the receipt decoder. A devnet end-to-end suite runs all five powers with real proofs.
- **Staged deploy.** 13 verifier keys exceed Midnight's block write limit. Ledger 9 also refuses blank key slots (custom error 110), so we deploy with 4 entry points and insert the other 9 verifier keys with maintenance transactions.
- **Console.** A web app styled after evlog.dev plus a backend (`keeproxyd`). You act as each device (owner laptop, agent, three guardians, new phone, two heirs) and watch **what the chain sees** live from the indexer.
- **Claude as the agent.** An MCP server whose tools can only act as the agent device. Refusals come back as plain sentences.

## How privacy shapes the design

Every role is a hash of a secret held only on that role's device, bound to a random vault id so it is unlinkable across vaults. Membership is a Merkle proof, and repeat actions are stopped with nullifiers scoped to each round. Mandate terms and heir shares are committed, never published. Deadlines are compared against a caller-supplied `now` that is pinned to the block clock, so private expiries never reach the kernel. The full field-by-field list, including the leaks we accept, is in `docs/SPEC.md`.

## Testing and validation

`npm run test:sim` runs 85 tests in memory. `npm run test:local` runs the devnet suite: it deploys a vault, enrolls the roles, makes an agent payment and is refused over the cap, anchors a backup and is refused a stale one, recovers with two guardians after the veto window and refuses the old key, releases shares once each, triggers inheritance, has both heirs claim once, then checks the privacy invariants against the indexer.

## Business

**Who uses it:**
- Crypto holders who need estate planning and recovery without doxxing their families.
- DAOs and teams that want a treasury agent with a hard budget.
- Wallets that want "lose your laptop, keep your assets" as a feature.

**How it makes money:**
- Hosted guardian and sponsor services (paying the DUST fee for each check-in).
- A wallet SDK licence.

**Roadmap:**
- Shielded payouts.
- An SDK wrapper that restores other Midnight dApps' private state.
- Per-mandate revocation.
- Decoy vaults for coercion resistance.
