import { useState, type ReactElement } from 'react';
import { Code, Footer, Header, Icon, Panel, REPO, useClock } from '../components/ui';
import { HeroStage } from '../components/HeroStage';

const CMD = 'claude mcp add keeproxy -- npm run agent:mcp';

function Hero() {
  const [copied, setCopied] = useState(false);
  return (
    <section className="hero">
      <div className="container">
        <div className="audience">
          <span>For humans</span>
          <i>|</i>
          <b>For agents</b>
        </div>
        <div>
          <span className="cmd">
            <span className="prompt">$</span> {CMD}
            <button
              aria-label="Copy command"
              onClick={() => {
                void navigator.clipboard?.writeText(CMD);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? <Icon.check className="" /> : <Icon.copy className="" />}
            </button>
          </span>
        </div>
        <h1 className="title">
          A seed phrase is not a plan.
          <br />
          It's a single point
          <br />
          of failure<span className="dot">.</span>
        </h1>
        <p className="lede">
          One Midnight vault that lets your AI agent, your guardians and your heirs act for you, within limits the contract
          enforces and without the chain learning who they are.
        </p>
        <div className="cta-row">
          <a className="btn btn-primary" href="#/console">
            Open the console <Icon.arrow />
          </a>
          <a className="btn btn-ghost" href={REPO} target="_blank" rel="noreferrer">
            <Icon.github className="" /> GitHub
          </a>
        </div>
        <HeroStage />
        <div className="questions">
          <span className="q">Who may spend?</span>
          <span className="q">Lost laptop?</span>
          <span className="q">What if I'm gone?</span>
          <span className="q">Who learns about it?</span>
        </div>
      </div>
    </section>
  );
}

function BuiltOn() {
  return (
    <div className="built-on">
      <div className="eyebrow">built on</div>
      <div className="stack">
        <span>Midnight</span>
        <span>Compact 0.36</span>
        <span>Ledger 9</span>
        <span>midnight-js 5</span>
        <span>MCP</span>
      </div>
    </div>
  );
}

const AGENT_PAY = `export circuit agentPay(recipient: UserAddress, amount: Uint<64>, now: Uint<64>): [] {
  const m = activeMandate();                     // private: never on chain
  assert(mandates.checkRoot(root(mandatePath(mandateLeafOf(m)))), "Mandate is not enrolled");
  assert(disclose(m.agentPk == agentKeyOf(agentSecret(), vaultId)), "Caller is not this mandate's agent");
  assert(disclose(m.generation == mandateGeneration), "Mandate was revoked");
  assert(disclose(now < m.expiresAt), "Mandate has expired");
  assert(payees.checkRoot(root(payeePath(payeeLeafOf(to.bytes, m.salt)))), "Recipient is not on the allowlist");
  const key = disclose(spendKeyOf(m.salt, epochIndexOf(now, m.epochSeconds)));
  assert(disclose(prior + amount <= m.capPerEpoch), "Payment exceeds the mandate's cap for this epoch");
  sendUnshielded(nativeToken(), amount, right(to));
}`;

function Delegate() {
  const [tab, setTab] = useState<'ok' | 'bad'>('ok');
  return (
    <section className="section" id="delegate">
      <div className="container">
        <div className="label">delegate</div>
        <h2 className="title left">
          Give your agent a budget.
          <br />
          Not your keys<span className="dot">.</span>
        </h2>
        <p className="prose">
          Issue a private mandate: cap per epoch, payee allowlist, expiry. The agent proves every term in zero knowledge
          on each payment. The chain sees a hash of the mandate, never the terms, the agent or the allowlist.
        </p>
        <div className="chips">
          <span className="chip"><Icon.clock /> Cap per epoch</span>
          <span className="chip"><Icon.shield /> Private allowlist</span>
          <span className="chip"><Icon.ban /> Kill switch</span>
        </div>
        <a className="more" href={`${REPO}/blob/main/contract/proxy.compact`} target="_blank" rel="noreferrer">
          Read the circuit →
        </a>
        <div className="grid2">
          <Panel title="proxy.compact · abridged">
            <Code src={AGENT_PAY} />
          </Panel>
          <Panel
            title="output"
            right={
              <span style={{ display: 'flex', gap: 4 }}>
                <button className={`tab ${tab === 'ok' ? 'on' : ''}`} onClick={() => setTab('ok')}>paid</button>
                <button className={`tab ${tab === 'bad' ? 'on' : ''}`} onClick={() => setTab('bad')}>refused</button>
              </span>
            }
          >
            {tab === 'ok' ? (
              <>
                <div>
                  <span className="lvl-OK">OK</span> <span className="p">agentPay</span> <span className="f">150 NIGHT → payee</span>
                  <span className="dim" style={{ float: 'right' }}>(2.3s proof)</span>
                </div>
                <div style={{ borderLeft: '1px solid var(--border-strong)', paddingLeft: 12, marginTop: 8 }}>
                  <div><span className="p">chain sees</span>: spend key <span className="s">"a41f…0c2e"</span>, 150 to recipient</div>
                  <div><span className="p">chain never sees</span>: agent, cap, expiry, allowlist</div>
                  <div><span className="p">epoch spend</span>: <span className="num">150</span> / <span className="dim">private cap</span></div>
                </div>
                <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }} className="muted">
                  <span className="lvl-OK">✓</span> one proof, every term checked
                </div>
              </>
            ) : (
              <>
                {[
                  ['agentPay 51', "Payment exceeds the mandate's cap for this epoch"],
                  ['agentPay → 0x9f3a…', 'Recipient is not enrolled in this vault'],
                  ['agentPay (after 30d)', 'Mandate has expired'],
                  ['agentPay (after kill switch)', 'Mandate was revoked'],
                  ['agentPay (forged terms)', 'Mandate is not enrolled'],
                ].map(([a, b]) => (
                  <div key={a}>
                    <span className="lvl-REFUSED">REFUSED</span> <span className="p">{a}</span>
                    <div className="muted" style={{ paddingLeft: 12, borderLeft: '1px solid color-mix(in oklab, var(--red) 40%, transparent)' }}>
                      {b}
                    </div>
                  </div>
                ))}
                <div style={{ marginTop: 10 }} className="muted">
                  <span className="lvl-REFUSED">✗</span> no proof can be built, so nothing is submitted
                </div>
              </>
            )}
          </Panel>
        </div>
      </div>
    </section>
  );
}

const RECOVER = `export circuit approveRecovery(): [] {
  assert(phase == Phase.RECOVERING, "No recovery is open");
  const sk = requireGuardian();            // Merkle proof: some guardian, not which
  const n = disclose(approvalNullifierOf(sk, recoveryRound.read(), vaultId));
  assert(!approvalNullifiers.member(n), "This guardian already approved");
  approvalNullifiers.insert(n);
  approvals = (approvals + 1) as Uint<8>;
}

export circuit heartbeat(now: Uint<64>): [] {
  requireOwner();                          // any sign of life
  if (phase == Phase.RECOVERING) { phase = Phase.ACTIVE; approvals = 0; }  // = veto
}`;

function Recover() {
  return (
    <section className="section" id="recover">
      <div className="container">
        <div className="label">recover</div>
        <h2 className="title left">
          Lose a laptop.
          <br />
          Not your life<span className="dot">.</span>
        </h2>
        <p className="prose">
          k-of-n guardians rotate the owner key. Each approval is a Merkle proof plus a one-time nullifier, so guardians stay
          anonymous and can't vote twice. A veto window means a takeover only succeeds against an owner who is really gone:
          one heartbeat cancels it.
        </p>
        <div className="chips">
          <span className="chip"><Icon.users /> Anonymous quorum</span>
          <span className="chip"><Icon.clock /> Veto window</span>
          <span className="chip"><Icon.key /> Key rotation</span>
        </div>
        <div className="grid2">
          <Panel title="proxy.compact · abridged">
            <Code src={RECOVER} />
          </Panel>
          <Panel title="recovery round 1" right={<span className="badge blue">2 of 3</span>}>
            {[
              ['g?', 'openRecovery', 'approvals 1/2', 'OK'],
              ['g?', 'approveRecovery', 'already approved', 'REFUSED'],
              ['g?', 'approveRecovery', 'approvals 2/2', 'OK'],
              ['—', 'finalizeRecovery', 'veto window open · 41s', 'VETO'],
              ['—', 'finalizeRecovery', 'owner rotated · mandates revoked', 'OK'],
              ['old', 'heartbeat', 'only the owner can do this', 'REFUSED'],
            ].map(([who, c, m, l], i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '34px 130px 1fr auto', gap: 8 }}>
                <span className="dim">{who}</span>
                <span className="p">{c}</span>
                <span className="muted">{m}</span>
                <span className={`lvl-${l}`}>{l}</span>
              </div>
            ))}
            <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }} className="muted">
              public: <span className="s">approvals</span>, <span className="s">nullifiers</span> · never: <span className="lvl-REFUSED">which guardian</span>
            </div>
          </Panel>
        </div>
      </div>
    </section>
  );
}

const RESTORE = `// owner device: encrypt private state, anchor the digest
const { backup, key } = encryptBackup(state, version);       // AES-256-GCM
const shares = splitSecret(key, 2, 3);                        // Shamir, GF(256)
await call('anchorBackup', backup.digest, version);          // version must increase

// guardian i, after a recovery: seal its share to the new device
await call('releaseShare', sealTo(ledger.pendingDeviceKey, shares[i]));  // X25519

// new device: refuse anything the chain doesn't vouch for
decryptBackup(backup, combineShares(opened), { digest, version });`;

function Restore() {
  return (
    <section className="section" id="restore">
      <div className="container">
        <div className="split">
          <div>
            <div className="label">restore</div>
            <h2 className="title left">
              Backups the chain
              <br />
              can vouch for<span className="dot">.</span>
            </h2>
            <p className="prose">
              Midnight keeps your secrets on your device, so a lost device means lost proofs. Keeproxy encrypts the private
              state, splits the key among your guardians and anchors the backup's digest on chain. After a recovery the
              guardians seal their shares to the new device. A stale or tampered backup is refused before decryption.
            </p>
            <div className="chips">
              <span className="chip"><Icon.lock /> AES-256-GCM</span>
              <span className="chip"><Icon.layers /> Shamir 2-of-3</span>
              <span className="chip"><Icon.ban /> No rollback</span>
            </div>
            <div className="features">
              {[
                [Icon.file, 'Digest + version on chain', 'anchorBackup only accepts a higher version than the last.'],
                [Icon.key, 'Sealed share release', 'One releaseShare per guardian per round, sealed to the new device key.'],
                [Icon.shield, 'Verify before decrypt', 'The new device checks the digest against the ledger first.'],
              ].map(([Ic, b, s]) => {
                const C = Ic as (p: { className?: string }) => ReactElement;
                return (
                  <div className="feature" key={b as string}>
                    <C />
                    <div>
                      <b>{b as string}</b>
                      <span>{s as string}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">
              <span className="lights"><i /><i /><i /></span>
              <span style={{ flex: 1 }}>restore.ts</span>
            </div>
            <div className="panel-body">
              <Code src={RESTORE} />
            </div>
            <div style={{ borderTop: '1px solid var(--border)' }}>
              <div className="flow">
                <div className="flow-node"><div className="box"><Icon.laptop /></div><b>Owner</b>encrypt</div>
                <div className="flow-edge"><span>DIGEST · v2</span></div>
                <div className="flow-node"><div className="box"><Icon.database /></div><b>Midnight</b>anchor</div>
                <div className="flow-edge"><span>SEALED SHARES</span></div>
                <div className="flow-node"><div className="box"><Icon.phone /></div><b>New device</b>verify · open</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Inherit() {
  return (
    <section className="section" id="inherit">
      <div className="container">
        <div className="label">inherit · disclose</div>
        <h2 className="title left">
          Silence is
          <br />a signal<span className="dot">.</span>
        </h2>
        <p className="prose">
          If you stop checking in for the period you chose, anyone can trigger inheritance: the balance freezes as the
          estate, every agent mandate dies, and each heir claims a private share once. Guardians then release sealed
          document keys to the people you named.
        </p>
        <div className="chips">
          <span className="chip"><Icon.hourglass /> Inactivity timer</span>
          <span className="chip"><Icon.eyeOff /> Hidden shares</span>
          <span className="chip"><Icon.file /> Sealed documents</span>
        </div>
        <div className="grid2">
          <Panel title="estate" right={<span className="dim" style={{ fontSize: 10 }}>inactivity 180d</span>}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>silence</div>
            <div className="score">
              172<small>/180 d</small>
            </div>
            <div style={{ color: 'var(--amber)', fontSize: 10.5, margin: '4px 0 12px' }}>8 days to trigger</div>
            <div className="bar amber"><i style={{ width: '95.5%' }} /></div>
            <div style={{ marginTop: 18 }} className="eyebrow">heirs (private until they claim)</div>
            {[
              ['heir ?', 60, 'unclaimed'],
              ['heir ?', 40, 'unclaimed'],
            ].map(([h, p, s], i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 70px', gap: 10, alignItems: 'center', marginTop: 8 }}>
                <span className="muted">{h}</span>
                <div className="bar"><i style={{ width: `${p}%` }} /></div>
                <span className="dim" style={{ fontSize: 10.5 }}>{s}</span>
              </div>
            ))}
            <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 10 }} className="dim">
              one heartbeat resets the clock · nothing runs, nothing is published
            </div>
          </Panel>
          <Panel title="claimInheritance" right={<span className="badge ok">once each</span>}>
            <Code
              src={`const leaf = heirLeafOf(heirKeyOf(sk, vaultId), bps);  // share stays committed
assert(heirs.checkRoot(root(heirPath(leaf))), "Not an heir of this vault");
assert(!heirClaims.member(n), "This heir already claimed");
const q = disclose(shareOf(estate, bps));       // floor(estate * bps / 10000)
assert(q * 10000 <= estate * bps && estate * bps < (q + 1) * 10000);`}
            />
          </Panel>
        </div>
      </div>
    </section>
  );
}

function Privacy() {
  const rows: [string, string, string][] = [
    ['Owner', 'hash of secret · last heartbeat', 'the secret, the wallet'],
    ['Agent', 'hash of mandate · spend per epoch', 'agent identity, cap, expiry, allowlist'],
    ['Guardians', 'Merkle root · per-round nullifiers', 'who they are, who approved'],
    ['Heirs', 'Merkle root · claim nullifiers', 'who they are, their shares (until claim)'],
    ['Backups', 'SHA-256 digest · version', 'contents, key, guardian shares'],
    ['Payments', 'amount · recipient (unshielded NIGHT)', 'which mandate paid'],
  ];
  return (
    <section className="section" id="privacy">
      <div className="container">
        <div className="label">what the chain sees</div>
        <h2 className="title left">
          Publish the rules.
          <br />
          Hide the people<span className="dot">.</span>
        </h2>
        <p className="prose">
          Every role is a hash of a secret that lives only on someone's device. The tests walk the full public ledger and
          fail if any secret, mandate term or heir key appears anywhere in it.
        </p>
        <div className="grid2" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
          <div className="panel">
            <table className="ptable">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>On chain</th>
                  <th>Never on chain</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([r, a, b]) => (
                  <tr key={r}>
                    <td style={{ color: '#fff' }}>{r}</td>
                    <td className="pub">{a}</td>
                    <td className="priv">{b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Panel title="assertNotInPublicState" right={<span className="badge ok">pass</span>}>
            <div className="eyebrow">secrets found in public ledger</div>
            <div className="score" style={{ margin: '8px 0 14px' }}>
              0<small>/14</small>
            </div>
            {['ownerSecret', 'newOwnerSecret', 'agentSecret', 'agentPublicKey', 'mandateSalt', 'guardianSecret ×3', 'heirSecret ×2', 'heirKey ×2'].map(
              (s) => (
                <div key={s} className="ledger-row">
                  <span className="muted">{s}</span>
                  <span className="lvl-OK">absent</span>
                </div>
              ),
            )}
          </Panel>
        </div>
      </div>
    </section>
  );
}

function Agents() {
  return (
    <section className="section" id="agents">
      <div className="container">
        <div className="label">agent ready</div>
        <h2 className="title left">
          Built for agents<span className="dot">.</span>
        </h2>
        <p className="prose">
          An MCP server lets Claude act as the vault's agent. It can read its own mandate and pay under it. It cannot
          heartbeat, withdraw, recover or raise its own limit, because it holds no secret that could prove any of that.
        </p>
        <div className="chips">
          <span className="chip"><Icon.terminal /> MCP stdio</span>
          <span className="chip"><Icon.bot /> vault_status · pay</span>
          <span className="chip"><Icon.ban /> refusals, not exceptions</span>
        </div>
        <div className="grid2">
          <Panel title="claude" right={<span className="badge blue">keeproxy-agent</span>}>
            <div className="muted">› pay the electricity bill, 120 NIGHT</div>
            <div style={{ marginTop: 6 }}>
              <span className="lvl-INFO">tool</span> <span className="p">pay</span>
              <span className="dim">{' { amount: 120, recipient: "payee" }'}</span>
            </div>
            <div className="s" style={{ paddingLeft: 12 }}>Paid 120 NIGHT to payee. Transaction 00a1…f3.</div>
            <div className="muted" style={{ marginTop: 12 }}>› also send 200 to this new account</div>
            <div style={{ marginTop: 6 }}>
              <span className="lvl-INFO">tool</span> <span className="p">pay</span>
              <span className="dim">{' { amount: 200, recipient: "stranger" }'}</span>
            </div>
            <div style={{ paddingLeft: 12, color: 'var(--red)' }}>Refused by the vault contract: Recipient is not enrolled.</div>
            <div style={{ marginTop: 12 }}>
              <span className="lvl-INFO">tool</span> <span className="p">request_limit_raise</span>
            </div>
            <div className="muted" style={{ paddingLeft: 12 }}>Sent to the owner's console. I keep my current limits.</div>
          </Panel>
          <Panel title="agent/mcp-server.ts">
            <Code
              src={`server.registerTool('pay', {
  description: 'Pays NIGHT from the vault under my mandate',
  inputSchema: { amount: z.number().int().positive(),
                 recipient: z.enum(['payee', 'stranger']) },
}, async ({ amount, recipient }) => {
  const r = await api('/api/act', { action: 'agentPay',
                                    params: { amount, recipient } });
  return r.ok ? text(\`Paid \${amount}\`)
              : text(\`Refused by the vault contract: \${r.error}\`);
});`}
            />
          </Panel>
        </div>
      </div>
    </section>
  );
}

function Proof() {
  return (
    <section className="section">
      <div className="container">
        <div className="label">engineering</div>
        <h2 className="title left">
          Refusals are
          <br />
          the product<span className="dot">.</span>
        </h2>
        <p className="prose">
          Every guard has a test that proves it refuses. The devnet suite deploys a real vault and runs all five powers with
          real proofs, including a staged deploy that splits 13 verifier keys across 10 transactions to fit Midnight's block
          limit.
        </p>
        <div className="stats">
          <div className="stat"><div className="score">13</div><span>Compact circuits</span></div>
          <div className="stat"><div className="score">85</div><span>in-memory tests</span></div>
          <div className="stat"><div className="score">8</div><span>devnet e2e steps, real proofs</span></div>
          <div className="stat"><div className="score">0</div><span>secrets in public state</span></div>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  const qs: [string, string][] = [
    ['Is this a wallet?', 'No. It is a vault contract your wallet funds. Your wallet keeps doing what it does; Keeproxy adds who else may act, and under what rules.'],
    ['What stops guardians colluding?', 'The veto window. A recovery needs k approvals and then waits; any heartbeat from the real owner cancels it, and a new round starts from zero.'],
    ['Can the agent drain the vault?', 'Only up to its cap per epoch, only to its allowlist, only until expiry. The owner can kill every mandate with one transaction, and a recovery or inheritance kills them automatically.'],
    ['What is public?', 'The vault rules (threshold, timers), its NIGHT balance, commitments and nullifiers, and the amount and recipient of each unshielded payment. Roles, terms and shares are not.'],
    ['Why NIGHT and not shielded tokens?', 'Unshielded NIGHT keeps the first version simple and auditable. Moving payouts to shielded coins hides amounts and recipients too; it is next on the roadmap.'],
  ];
  return (
    <section className="section">
      <div className="container" style={{ textAlign: 'center' }}>
        <div className="label">faq</div>
        <h2 className="title">Questions<span className="dot">.</span></h2>
        <div className="faq" style={{ textAlign: 'left' }}>
          {qs.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Band() {
  const t = useClock();
  const later = new Date(t.getTime() + 10 * 60_000);
  const hhmm = `${String(later.getHours()).padStart(2, '0')}:${String(later.getMinutes()).padStart(2, '0')}`;
  return (
    <section className="band">
      <div className="container">
        <h2 className="title">
          Hand over control
          <br />
          by {hhmm}
          <span>.</span>
        </h2>
        <p>Deploy a vault, enroll your people, give your agent a budget. Ten minutes.</p>
        <div className="cta-row">
          <a className="btn btn-white" href="#/console">
            Open the console <Icon.arrow />
          </a>
          <a className="btn btn-glass" href={REPO} target="_blank" rel="noreferrer">
            <Icon.github className="" /> View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}

export function Landing() {
  return (
    <>
      <Header page="home" />
      <main>
        <Hero />
        <BuiltOn />
        <Delegate />
        <Recover />
        <Restore />
        <Inherit />
        <Privacy />
        <Agents />
        <Proof />
        <Faq />
        <Band />
      </main>
      <Footer />
    </>
  );
}
