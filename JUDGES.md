# Judges’ guide

Keeproxy is a **whole-life vault** on Midnight: one contract in which your AI agent, your guardians and your heirs can act for you, within rules the contract enforces, without the chain learning who they are. Agent payments are one of its five powers. The other four (recover, restore, inherit, disclose) are what let the vault outlive a lost device or its owner, and they switch the agent off when they fire.

This page is the shortest route to checking that claim, followed by everything Keeproxy does not do yet.

## Five minutes, nothing to install

| Time | Do this | What you should see |
|---|---|---|
| 1 min | Open the live vault: [keeproxy.vercel.app/#/console](https://keeproxy.vercel.app/#/console) | The demo vault on preprod: balance, guardians, timers, and its call history from the public indexer. Open **view proof** on `agentPay`. |
| 1 min | Open any receipt in the README’s [Live on preprod](README.md#live-on-preprod) tables | A JSON receipt rebuilt from the indexer: block, status `SUCCESS`, proof size. Nothing in it comes from our database. |
| 1 min | Read the refusals in the same section | Over the cap, a stranger, a revoked mandate, an early inheritance, a second claim: each refused with the contract’s own reason, and no transaction sent. |
| 2 min | Skim [`contract/proxy.compact`](contract/proxy.compact), `agentPay` and `triggerInheritance` | The mandate terms are private witnesses; only their hash and the per-epoch spend are public. Inheritance freezes the estate and bumps the mandate generation. |

## Fifteen minutes, with your own wallet

1. Install [Lace](https://www.lace.io/) with Midnight support and switch it to **preprod**.
2. Get tNIGHT from the [faucet](https://faucet.preprod.midnight.network/) and designate it for DUST generation in Lace. DUST pays the fees; it takes a few minutes to accrue, so do this first.
3. Let Lace finish syncing. A fresh wallet replays preprod’s history, and until it is past the ledger 9 upgrade it reports a protocol mismatch.
4. Open [keeproxy.vercel.app/#/app](https://keeproxy.vercel.app/#/app), **Connect**, and leave **proofs** on **This browser**.
5. **Create a vault**. For a quick test, set the inactivity period to `0.02` days (29 minutes) and the veto window to `0.005` days. Approve ten transactions: one deploy and nine verifier keys.
6. **Deposit**, **Heartbeat**, then **Give an AI agent a mandate**. In a second browser profile, **Join a vault** as a guardian or heir and paste its code into **Enroll**.
7. Pay as the agent under the cap (accepted), over it (refused), revoke every mandate, and pay again (refused).

**No Docker needed for the vault’s proofs.** They run in the page: the ZKIR v3 prover in WebAssembly, in a worker. Keys and public parameters are fetched from the viewer and checked against hashes pinned into the build. Measured on preprod: a deposit (k = 9) proves in about 3 seconds and a heartbeat (k = 13) in about 40.

**Your wallet still proves its own fee input.** If Lace is set to a local proof server that is not running, the page detects it after you connect and shows the command to start one:

```bash
docker run -p 6300:6300 midnightntwrk/proof-server:9.0.2 midnight-proof-server
```

Or point Lace at a remote prover in its settings.

## From the repository

```bash
npm install
npm run compile:fast   # Compact → JS (on Windows, run bash scripts/setup-compactc.sh once first)
npm run test:sim       # 85 tests, about 40 seconds
```

`npm run test:local` runs the devnet suite: real proofs, all five powers, privacy invariants checked against the indexer. It needs `npm run compile` (with keys) and `npm run env:up` (Docker).

## Honest limits

| Limit | Detail |
|---|---|
| **Preprod only, unaudited** | Test tokens only. The contract has not been audited. Do not put real value in it. |
| **Lace end to end** | Lace connects, reads balances and is offered every transaction. Our full browser runs (the 19-transaction vault in the README, and the browser-proving test) used `npm run dev-wallet`, a synced wallet over the same connector API, because a fresh Lace was still syncing. A full Lace run is the next thing we test. |
| **The wallet’s fee proof** | The page proves the vault’s circuit; the wallet proves its DUST spend with whatever prover it is configured for. That part is outside our control. |
| **Proving time** | In the browser, from a few seconds (k = 9) to about 40 seconds (k = 13); `agentPay` (k = 15) takes longer. The tab must stay open. |
| **Unshielded payouts** | Agent payments, withdrawals and inheritance claims move unshielded NIGHT, so each payout’s amount and recipient is public. An heir’s share is revealed when they claim. |
| **Public rules** | The threshold, the timers, the NIGHT balance and which circuit ran are public by design. |
| **Keys in the browser** | Role secrets live in the browser’s storage. Clearing site data loses them unless the key file was downloaded. |
| **All-or-nothing revoke** | The kill switch revokes every mandate at once. Revoking one is on the roadmap. |
| **Recovery in the browser** | Recovery needs at least two guardians, and one browser holds one guardian key per vault, so we have not run recovery through the web app. It is covered by the in-memory tests and the devnet suite. |
| **Ten transactions to create** | Thirteen verifier keys exceed the block limit, so a vault is deployed in ten transactions (about four minutes). |
| **The viewer is one server** | `keeproxy-viewer` on Railway serves the live console, the receipts and the proving artifacts. Every receipt can be checked against the indexer directly. |
| **The MCP agent runs locally** | `npm run agent:mcp` gives Claude the agent role only, on your machine. It is not hosted. |

## Where things are

| | |
|---|---|
| Contract | [`contract/proxy.compact`](contract/proxy.compact) (13 circuits) |
| Spec and accepted leaks | [`docs/SPEC.md`](docs/SPEC.md) |
| Live proofs | [README › Live on preprod](README.md#live-on-preprod) |
| Wallet app | [`web/src/app/vault.ts`](web/src/app/vault.ts), browser prover in [`web/src/app/browser-prover.ts`](web/src/app/browser-prover.ts) |
| Tests | [`src/test/`](src/test/) |
| Pitch deck | [Keeproxy pitch deck](https://claude.ai/artifact/VSVk8M6CVc4GJPEnR9vNtY) |
