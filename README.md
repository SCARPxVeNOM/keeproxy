# keeproxy.

**Who can act for you when you can't.** One Midnight vault that lets your AI agent, your guardians and your heirs act for you, within limits the contract enforces and without the chain learning who they are.

A seed phrase is a single point of failure. The usual fixes (multisig, social recovery, a will) publish your guardians, your heirs and your balances, which is a map for anyone planning to coerce you. Keeproxy publishes only the **rules**. Every person is a hash of a secret that lives on their own device; every action is a zero-knowledge proof against a Merkle root.

| Power | What it does | Contract refuses |
|---|---|---|
| **DELEGATE** | An AI agent pays from the vault under a private mandate: cap per epoch, payee allowlist, expiry, kill switch | over-cap, non-allowlisted recipient, expired, revoked, forged terms, wrong agent |
| **RECOVER** | k-of-n anonymous guardians rotate the owner key after a veto window | non-guardian, double approval, below threshold, inside veto window, vetoed by a heartbeat |
| **RESTORE** | Owner's private state backed up encrypted; digest + version anchored on chain; after recovery, guardians seal key shares to the new device | stale/rolled-back backup, tampered blob, double share release, the stolen laptop |
| **INHERIT** | After a chosen period of silence, heirs claim private shares once | owner still active, non-heir, lied-about share, double claim |
| **DISCLOSE** | Once inherited, guardians release sealed document keys | release before trigger, double release |

## Midnight integration

- `contract/proxy.compact`: **13 circuits**, Compact 0.36.1 / language 0.28, ledger 9. Private state via witnesses, MerkleTree membership, per-round nullifiers, salted `persistentCommit`, `blockTime*` with a pinned `now`, unshielded NIGHT in and out.
- **Dual ledger:** the public ledger holds roots, nullifiers, rules and balances; each device's private state holds its secret and terms (`contract/witnesses.ts`). See [`docs/SPEC.md`](docs/SPEC.md) for every field, guard, privacy invariant and accepted leak.
- **Staged deploy** (`src/staged-deploy.ts`): 13 verifier keys don't fit in one block, and ledger 9 refuses blank key slots, so the vault deploys with 4 entry points and inserts the other 9 keys with maintenance transactions.
- **RESTORE crypto** (`src/restore.ts`): AES-256-GCM (version in AAD), Shamir k-of-n over GF(256), ephemeral X25519 + HKDF sealing to the device key published by `openRecovery`.

## What the chain sees

| | On chain | Never on chain |
|---|---|---|
| Owner | hash of secret, last heartbeat | the secret, the wallet |
| Agent | hash of mandate, spend per epoch | agent identity, cap, expiry, allowlist |
| Guardians | Merkle root, per-round nullifiers | who they are, who approved |
| Heirs | Merkle root, claim nullifiers | who they are, shares (until claimed) |
| Backups | SHA-256 digest, version | contents, key, shares |

Accepted leaks are listed in the spec: vault rules and NIGHT balance, circuit names, unshielded payment amount and recipient.

## Run it

Requirements: Node 22, Docker. If you don't have a native Compact 0.36.1 toolchain (always the case on Windows), build the compiler image once:

```bash
bash scripts/setup-compactc.sh
```

```bash
npm install
npm run compile:fast        # contract → JS, seconds (enough for the sim tests)
npm run test:sim            # 42 in-memory tests: every guard + privacy invariants + restore crypto
npm run compile             # full compile with proving/verifier keys (needed for devnet)
npm run env:up              # local node + indexer + proof server (compose.yml)
npm run test:local          # devnet e2e: real proofs, all five powers
```

### Console (web app + backend)

```bash
npm run build:web
npm run serve               # http://127.0.0.1:8787 — landing page and #/console
```

The console deploys a vault, then lets you act as each device (owner laptop, agent, three guardians, new phone, two heirs) and shows **what the chain sees** next to it, live from the indexer.

### Proving each transaction

Every confirmed step has a **view proof** button. The receipt is rebuilt from the indexer, not from keeproxyd's memory (`src/tx-receipt.ts`, `GET /api/tx/<hash>`):
- the block that included the transaction, and its status
- the circuit it called on this vault
- the zero-knowledge proof inside the raw transaction, which the node verified against the contract's on-chain key before accepting it
- any NIGHT paid out

A copyable `curl` command lets anyone ask the indexer directly. From the terminal: `npm run receipt -- <tx hash>`.

A refused step has no transaction. The contract's check fails while the proof is being built, so nothing reaches the chain.

### Claude as the agent (MCP)

```bash
npm run serve               # keep running
claude mcp add keeproxy -- npm run agent:mcp --prefix <path-to-keeproxy>
```

Tools: `vault_status`, `pay`, `request_limit_raise`. The agent can only pay under its mandate. It cannot heartbeat, withdraw, recover or raise its own cap, because it holds no secret that proves any of that.

### Preprod

Copy `.env.preprod.example` to `.env.preprod`, fund the wallet from the faucet, then `MIDNIGHT_NETWORK=preprod npm run deploy`. The address lands in `deployments/preprod.json`.

## Repository

```
contract/        proxy.compact, witnesses.ts, index.ts
src/             staged-deploy, restore crypto, vault-service, providers/wallet/config
src/test/        *.sim.test.ts (in memory) and keeproxy.test.ts (devnet)
server/          keeproxyd: JSON API + SSE + static web
agent/           MCP server (Claude as the vault's agent)
web/             landing page + console (React, Vite)
docs/SPEC.md     contract spec, privacy invariants, accepted leaks
```

## Credits

Wallet/provider harness and the in-memory sim are adapted from [midnightntwrk/midnight-examples](https://github.com/midnightntwrk/midnight-examples) (Apache-2.0). Staged deployment follows the approach documented by Stock & Foil. Fonts: Geist, Geist Mono, Geist Pixel (SIL OFL).

## License

Apache-2.0.
