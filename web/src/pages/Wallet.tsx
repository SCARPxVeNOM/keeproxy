import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Footer, Header, Icon, Panel, REPO } from '../components/ui';
import {
  BrowserVault,
  NETWORK,
  exportHeld,
  forgetHeld,
  importHeld,
  listWallets,
  loadHeld,
  type Held,
  type Outcome,
  type WalletChoice,
} from '../app/vault';
import type { PublicView } from '../../../src/public-view';
import { installDevWallet } from '../app/dev-wallet';

installDevWallet();

const API = ((import.meta.env.VITE_KEEPROXY_API as string | undefined) ?? '').replace(/\/$/, '');
const FAUCET = 'https://faucet.preprod.midnight.network/';
const LACE = 'https://www.lace.io/';

interface Entry {
  at: number;
  ok: boolean | null;
  text: string;
  txId?: string;
}

const short = (s: string, n = 8) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const days = (s: number) => `${+(s / 86_400).toFixed(2)} d`;
const when = (t: number) => (t ? new Date(t * 1000).toLocaleString() : '—');

/** NIGHT has 6 decimals; DUST is counted in Specks (10^15 per DUST). */
function units(v: bigint, decimals: number, shown = 2): string {
  const d = 10n ** BigInt(decimals);
  const whole = (v / d).toLocaleString('en-US');
  const frac = (v % d).toString().padStart(decimals, '0').slice(0, shown).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.children}
      {props.hint && <em>{props.hint}</em>}
    </label>
  );
}

function CopyCode({ code }: { code: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy-code">
      <code>{code}</code>
      <button
        className="btn btn-outline"
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? <Icon.check /> : <Icon.copy />} {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function Wallet() {
  const [wallets, setWallets] = useState<WalletChoice[]>([]);
  const [vault, setVault] = useState<BrowserVault | null>(null);
  const [bal, setBal] = useState<{ night: bigint; dust: bigint; dustCap: bigint } | null>(null);
  const [held, setHeld] = useState<Held[]>(() => loadHeld());
  const [sel, setSel] = useState<string | null>(() => loadHeld()[0]?.address ?? null);
  const [view, setView] = useState<PublicView | null>(null);
  const [log, setLog] = useState<Entry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<'none' | 'create' | 'join'>('none');

  const say = useCallback((text: string, ok: boolean | null = null, txId?: string) => {
    setLog((l) => [{ at: Date.now(), ok, text, txId }, ...l].slice(0, 80));
  }, []);

  // Wallet extensions inject window.midnight a moment after load.
  useEffect(() => {
    const scan = () => setWallets(listWallets());
    scan();
    const id = setInterval(scan, 1000);
    const stop = setTimeout(() => clearInterval(id), 6000);
    return () => {
      clearInterval(id);
      clearTimeout(stop);
    };
  }, []);

  const current = useMemo(() => held.find((h) => h.address === sel) ?? null, [held, sel]);
  const refreshHeld = () => setHeld(loadHeld());

  const refresh = useCallback(async () => {
    if (!vault) return;
    vault.balances().then(setBal).catch(() => undefined);
    if (sel) {
      try {
        setView(await vault.view(sel));
      } catch (e) {
        setView(null);
        say(e instanceof Error ? e.message : String(e), false);
      }
    }
  }, [vault, sel, say]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function connect(w: WalletChoice) {
    setBusy('connect');
    try {
      const v = await BrowserVault.connect(w);
      setVault(v);
      say(`Connected to ${v.walletName} on ${v.networkId}`, true);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), false);
    } finally {
      setBusy(null);
    }
  }

  /** Runs one wallet transaction and logs the outcome. */
  async function run(label: string, fn: () => Promise<Outcome>) {
    setBusy(label);
    say(`${label}: approve it in your wallet…`);
    try {
      const r = await fn();
      if (r.ok) say(`${label} confirmed`, true, r.txId);
      else say(`${label} refused: ${r.error}`, false);
      return r.ok;
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  const connected = vault !== null;

  return (
    <div className="page">
      <Header page="app" />
      <main className="container app">
        <div className="app-head">
          <div className="label">your vault · {NETWORK}</div>
          <h1 className="title pixel">Keep your own proxy</h1>
          <p className="prose">
            Connect a Midnight wallet and run a Keeproxy vault that is yours alone. Your wallet pays for, proves and
            submits each transaction. The role keys are generated in this browser and never leave it: the chain only
            sees their hashes.
          </p>
        </div>

        <div className="app-grid">
          <div className="app-col">
            <Panel title="1 · wallet" right={connected ? <span className="live">CONNECTED</span> : undefined}>
              {!connected && wallets.length === 0 && (
                <div className="stack-s">
                  <p>No Midnight wallet found in this browser.</p>
                  <ol className="steps">
                    <li>
                      Install{' '}
                      <a className="link" href={LACE} target="_blank" rel="noreferrer">
                        Lace
                      </a>{' '}
                      with Midnight support and create a wallet.
                    </li>
                    <li>Switch it to the {NETWORK} network.</li>
                    <li>
                      Get tNIGHT from the{' '}
                      <a className="link" href={FAUCET} target="_blank" rel="noreferrer">
                        faucet
                      </a>{' '}
                      and let it generate DUST for fees.
                    </li>
                    <li>Reload this page.</li>
                  </ol>
                </div>
              )}
              {!connected &&
                wallets.map((w) => (
                  <div className="wallet-row" key={w.key}>
                    {w.icon && <img src={w.icon} alt="" width={20} height={20} />}
                    <span className="grow">{w.name}</span>
                    <span className="dim">API {w.apiVersion.split('-')[0]}</span>
                    <button className="btn btn-primary" disabled={!w.supported || busy !== null} onClick={() => void connect(w)}>
                      {busy === 'connect' ? 'Connecting…' : w.supported ? 'Connect' : 'Unsupported'}
                    </button>
                  </div>
                ))}
              {connected && (
                <div className="kv">
                  <span>wallet</span>
                  <b>{vault.walletName}</b>
                  <span>address</span>
                  <b title={vault.unshieldedAddress}>{short(vault.unshieldedAddress, 12)}</b>
                  <span>tNIGHT</span>
                  <b>{bal ? units(bal.night, 6) : '…'}</b>
                  <span>DUST (fees)</span>
                  <b>{bal ? units(bal.dust, 15, 4) : '…'}</b>
                </div>
              )}
              {connected && bal && bal.dust === 0n && (
                <p className="notice">
                  This wallet has no DUST yet, so it cannot pay fees. In your wallet, designate your tNIGHT for DUST
                  generation and wait a few minutes. If the wallet is still syncing, let it finish first.
                </p>
              )}
            </Panel>

            <Panel title="2 · vaults in this browser">
              {held.length === 0 && <p className="muted">None yet. Create one, or join someone's as a guardian or heir.</p>}
              {held.map((h) => (
                <button key={h.address} className={`vault-row ${h.address === sel ? 'on' : ''}`} onClick={() => setSel(h.address)}>
                  <span className="grow">
                    <b>{h.label}</b>
                    <span className="dim"> {short(h.address)}</span>
                  </span>
                  {h.owner && <span className="badge blue">owner</span>}
                  {h.guardian && <span className="badge">guardian</span>}
                  {h.heir && <span className="badge">heir</span>}
                  {h.agent && <span className="badge">agent</span>}
                  {h.newDevice && <span className="badge">recovering</span>}
                </button>
              ))}
              <div className="row-btns">
                <button className="btn btn-primary" disabled={!connected} onClick={() => setMode('create')}>
                  Create a vault
                </button>
                <button className="btn btn-outline" disabled={!connected} onClick={() => setMode('join')}>
                  Join a vault
                </button>
                <label className="btn btn-ghost">
                  Import key file
                  <input
                    type="file"
                    accept="application/json"
                    hidden
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      try {
                        const h = importHeld(await f.text());
                        refreshHeld();
                        setSel(h.address);
                        say(`Imported keys for ${short(h.address)}`, true);
                      } catch (err) {
                        say(err instanceof Error ? err.message : String(err), false);
                      }
                    }}
                  />
                </label>
              </div>
              {!connected && <p className="dim small">Connect a wallet to create or join.</p>}
            </Panel>

            {connected && mode === 'create' && (
              <CreateVault
                vault={vault}
                busy={busy}
                setBusy={setBusy}
                say={say}
                onDone={(h) => {
                  refreshHeld();
                  setSel(h.address);
                  setMode('none');
                }}
                onCancel={() => setMode('none')}
              />
            )}
            {connected && mode === 'join' && (
              <JoinVault
                vault={vault}
                say={say}
                onDone={(address) => {
                  refreshHeld();
                  setSel(address);
                  setMode('none');
                }}
                onCancel={() => setMode('none')}
              />
            )}
          </div>

          <div className="app-col">
            {current ? (
              <VaultPanel
                h={current}
                view={view}
                vault={vault}
                busy={busy}
                run={run}
                say={say}
                onChange={() => {
                  refreshHeld();
                  void refresh();
                }}
              />
            ) : (
              <Panel title="how it works">
                <ol className="guide">
                  <li>
                    <b>Connect your wallet.</b>
                    <span>It pays the fees and proves each transaction. This page never sees its keys.</span>
                  </li>
                  <li>
                    <b>Create a vault.</b>
                    <span>Pick how many guardians must agree, and how long you can be silent before heirs may inherit. About ten approvals, four minutes.</span>
                  </li>
                  <li>
                    <b>Invite your people.</b>
                    <span>Guardians and heirs open this page, choose “Join a vault”, and send you the code it makes. You enroll it. The code holds no secret.</span>
                  </li>
                  <li>
                    <b>Give an agent a budget.</b>
                    <span>A cap per period, a payee, an expiry. One button revokes every mandate.</span>
                  </li>
                  <li>
                    <b>Back up your keys.</b>
                    <span>Role keys live in this browser. Download the key file and keep it somewhere safe.</span>
                  </li>
                </ol>
                <p className="dim small">
                  Want to see one first?{' '}
                  <a className="link" href="#/console">
                    Watch a live vault on preprod →
                  </a>
                </p>
              </Panel>
            )}
            <Panel title="activity" right={busy ? <span className="badge blue">{busy}…</span> : undefined}>
              {log.length === 0 && <p className="dim">Transactions you approve appear here.</p>}
              <div className="activity">
                {log.map((e, i) => (
                  <div key={i} className={`act ${e.ok === true ? 'ok' : e.ok === false ? 'bad' : ''}`}>
                    <span className="dim">{new Date(e.at).toLocaleTimeString()}</span>
                    <span className="grow">{e.text}</span>
                    {e.txId && API && (
                      <a className="link" href={`${API}/api/tx/${e.txId}`} target="_blank" rel="noreferrer">
                        receipt↗
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
            <p className="dim small">
              Keys live in this browser's storage: download a key file for every vault you care about. Source and audit
              trail:{' '}
              <a className="link" href={REPO} target="_blank" rel="noreferrer">
                GitHub
              </a>
              .
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

// ------------------------------------------------------------------ create

function CreateVault(props: {
  vault: BrowserVault;
  busy: string | null;
  setBusy: (b: string | null) => void;
  say: (t: string, ok?: boolean | null, txId?: string) => void;
  onDone: (h: Held) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState('My vault');
  const [threshold, setThreshold] = useState(2);
  const [inactivityDays, setInactivityDays] = useState(180);
  const [vetoDays, setVetoDays] = useState(3);
  const [step, setStep] = useState<string | null>(null);
  const valid = threshold >= 1 && inactivityDays > vetoDays && vetoDays >= 0;

  async function go() {
    props.setBusy('create vault');
    props.say('Deploying a vault: your wallet will ask for 10 approvals');
    try {
      const h = await props.vault.createVault(
        {
          label,
          threshold: BigInt(threshold),
          inactivity: BigInt(Math.round(inactivityDays * 86_400)),
          veto: BigInt(Math.round(vetoDays * 86_400)),
        },
        (m) => {
          setStep(m);
          props.say(m);
        },
      );
      props.say(`Vault deployed at ${h.address}`, true);
      props.onDone(h);
    } catch (e) {
      props.say(`Deploy failed: ${e instanceof Error ? e.message : String(e)}`, false);
    } finally {
      props.setBusy(null);
      setStep(null);
    }
  }

  return (
    <Panel title="create a vault">
      <div className="form">
        <Field label="Name" hint="Only shown in this browser.">
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Guardians needed to recover" hint="Enroll at least this many guardians afterwards.">
          <input type="number" min={1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
        </Field>
        <Field label="Inactivity before heirs can claim (days)">
          <input type="number" min={0} step="any" value={inactivityDays} onChange={(e) => setInactivityDays(Number(e.target.value))} />
        </Field>
        <Field label="Veto window on recoveries (days)" hint="Any heartbeat in this window cancels a recovery.">
          <input type="number" min={0} step="any" value={vetoDays} onChange={(e) => setVetoDays(Number(e.target.value))} />
        </Field>
        <p className="dim small">
          The rules are public and fixed at deploy. The deploy is one transaction plus nine that install verifier keys
          which do not fit in a block, so expect ten approvals.
        </p>
        {step && <p className="progress">{step}</p>}
        <div className="row-btns">
          <button className="btn btn-primary" disabled={!valid || props.busy !== null} onClick={() => void go()}>
            Deploy vault
          </button>
          <button className="btn btn-ghost" disabled={props.busy !== null} onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </Panel>
  );
}

// -------------------------------------------------------------------- join

function JoinVault(props: {
  vault: BrowserVault;
  say: (t: string, ok?: boolean | null) => void;
  onDone: (address: string) => void;
  onCancel: () => void;
}) {
  const [address, setAddress] = useState('');
  const [as, setAs] = useState<'guardian' | 'heir' | 'recover'>('guardian');
  const [bps, setBps] = useState(5000);
  const [code, setCode] = useState<string | null>(null);
  const ok = /^[0-9a-f]{64}$/.test(address.trim());

  async function go() {
    try {
      const a = address.trim();
      const c =
        as === 'guardian'
          ? await props.vault.joinAsGuardian(a)
          : as === 'heir'
            ? await props.vault.joinAsHeir(a, bps)
            : await props.vault.requestRecovery(a);
      setCode(c);
      props.say(as === 'recover' ? 'Recovery request ready: send it to a guardian' : `Your ${as} code is ready: send it to the owner`, true);
    } catch (e) {
      props.say(e instanceof Error ? e.message : String(e), false);
    }
  }

  return (
    <Panel title="join a vault">
      <div className="form">
        <Field label="Vault address" hint="64 hex characters, from the vault's owner.">
          <input value={address} onChange={(e) => setAddress(e.target.value.toLowerCase())} placeholder="79b8e465…" />
        </Field>
        <div className="seg">
          {(['guardian', 'heir', 'recover'] as const).map((x) => (
            <button key={x} className={`tab ${as === x ? 'on' : ''}`} onClick={() => setAs(x)}>
              {x === 'recover' ? 'I am the owner on a new device' : `as ${x}`}
            </button>
          ))}
        </div>
        {as === 'heir' && (
          <Field label="Your share (basis points)" hint="5000 = 50%. Agree it with the owner; it is bound into your code.">
            <input type="number" min={1} max={10000} value={bps} onChange={(e) => setBps(Number(e.target.value))} />
          </Field>
        )}
        {code ? (
          <>
            <p className="small">
              {as === 'recover'
                ? 'Send this to one of the vault guardians. It holds your new owner key hash, never the key.'
                : 'Send this to the vault owner. It is a hash of a secret that stays in this browser.'}
            </p>
            <CopyCode code={code} />
            <div className="row-btns">
              <button className="btn btn-primary" onClick={() => props.onDone(address.trim())}>
                Done
              </button>
            </div>
          </>
        ) : (
          <div className="row-btns">
            <button className="btn btn-primary" disabled={!ok} onClick={() => void go()}>
              Generate my code
            </button>
            <button className="btn btn-ghost" onClick={props.onCancel}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------- vault

function VaultPanel(props: {
  h: Held;
  view: PublicView | null;
  vault: BrowserVault | null;
  busy: string | null;
  run: (label: string, fn: () => Promise<Outcome>) => Promise<boolean>;
  say: (t: string, ok?: boolean | null) => void;
  onChange: () => void;
}) {
  const { h, view, vault, busy, run } = props;
  const [amount, setAmount] = useState('100');
  const [code, setCode] = useState('');
  const [recCode, setRecCode] = useState('');
  const [payTo, setPayTo] = useState('');
  const [payAmt, setPayAmt] = useState('10');
  const [cap, setCap] = useState('200');
  const [epochDays, setEpochDays] = useState('7');
  const [expiryDays, setExpiryDays] = useState('30');
  const [payee, setPayee] = useState('');
  const [myCodes, setMyCodes] = useState<string[]>([]);
  const off = !vault || busy !== null;
  const amt = () => BigInt(amount || '0');

  useEffect(() => setMyCodes([]), [h.address]);

  return (
    <Panel
      title={`${h.label} · ${short(h.address)}`}
      right={view ? <span className={`badge ${view.phase === 'ACTIVE' ? 'ok' : 'blue'}`}>{view.phase}</span> : undefined}
    >
      {view ? (
        <div className="kv">
          <span>balance</span>
          <b>{view.balance}</b>
          <span>guardians</span>
          <b>
            {view.guardianCount} enrolled · {view.threshold} needed
          </b>
          <span>last heartbeat</span>
          <b>{when(view.lastSeen)}</b>
          <span>rules</span>
          <b>
            inactivity {days(view.inactivitySeconds)} · veto {days(view.vetoSeconds)}
          </b>
          {view.phase === 'RECOVERING' && (
            <>
              <span>recovery</span>
              <b>
                {view.approvals} of {view.threshold} approvals · opened {when(view.recoveryOpenedAt)}
              </b>
            </>
          )}
          {view.phase === 'INHERITED' && (
            <>
              <span>estate</span>
              <b>
                {view.estatePaid} of {view.estate} paid
              </b>
            </>
          )}
        </div>
      ) : (
        <p className="dim">{vault ? 'Reading the ledger…' : 'Connect a wallet to read this vault.'}</p>
      )}

      {h.owner && (
        <section className="role">
          <h4>
            <Icon.laptop /> owner
          </h4>
          <div className="inline">
            <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} aria-label="amount" />
            <button className="btn btn-outline" disabled={off} onClick={() => void run('Deposit', () => vault!.deposit(h, amt()))}>
              Deposit
            </button>
            <button className="btn btn-outline" disabled={off} onClick={() => void run('Withdraw', () => vault!.withdraw(h, amt()))}>
              Withdraw
            </button>
            <button className="btn btn-outline" disabled={off} onClick={() => void run('Heartbeat', () => vault!.heartbeat(h))}>
              Heartbeat
            </button>
          </div>
          <div className="inline">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="kpg1… or kph1… code from a guardian or heir" />
            <button
              className="btn btn-outline"
              disabled={off || !code}
              onClick={async () => {
                if (await run('Enroll', () => vault!.enrollCode(h, code))) setCode('');
              }}
            >
              Enroll
            </button>
          </div>
          <details>
            <summary>Give an AI agent a mandate</summary>
            <div className="form">
              <div className="inline">
                <Field label="Cap per epoch">
                  <input value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, ''))} />
                </Field>
                <Field label="Epoch (days)">
                  <input value={epochDays} onChange={(e) => setEpochDays(e.target.value)} />
                </Field>
                <Field label="Expires in (days)">
                  <input value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} />
                </Field>
              </div>
              <Field label="Allowed payee" hint="An unshielded address. Leave empty to allow only your own wallet.">
                <input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder={vault?.unshieldedAddress ?? ''} />
              </Field>
              <button
                className="btn btn-outline"
                disabled={off}
                onClick={() =>
                  void run('Issue mandate', () =>
                    vault!.issueMandate(
                      h,
                      { cap: BigInt(cap || '0'), epochDays: Number(epochDays), expiresInDays: Number(expiryDays), payee: payee || vault!.unshieldedAddress },
                      (m) => props.say(m),
                    ),
                  ).then(props.onChange)
                }
              >
                Issue mandate (2 approvals)
              </button>
            </div>
          </details>
          <button className="btn btn-danger" disabled={off} onClick={() => void run('Kill switch', () => vault!.revokeMandates(h))}>
            <Icon.ban /> Revoke every agent mandate
          </button>
        </section>
      )}

      {h.agent && (
        <section className="role">
          <h4>
            <Icon.bot /> agent
          </h4>
          <p className="dim small">
            Cap {h.agent.mandate['capPerEpoch']} per {days(Number(h.agent.mandate['epochSeconds']))}, expires{' '}
            {when(Number(h.agent.mandate['expiresAt']))}. Download the key file to run the agent elsewhere.
          </p>
          <div className="inline">
            <input value={payTo} onChange={(e) => setPayTo(e.target.value)} placeholder="recipient address (empty: your wallet)" />
            <input className="narrow" value={payAmt} onChange={(e) => setPayAmt(e.target.value.replace(/\D/g, ''))} />
            <button
              className="btn btn-outline"
              disabled={off}
              onClick={() => void run('Agent pay', () => vault!.agentPay(h, payTo || vault!.unshieldedAddress, BigInt(payAmt || '0')))}
            >
              Pay as agent
            </button>
          </div>
        </section>
      )}

      {h.guardian && (
        <section className="role">
          <h4>
            <Icon.users /> guardian
          </h4>
          <div className="inline">
            <input value={recCode} onChange={(e) => setRecCode(e.target.value)} placeholder="kpr1… recovery request from the owner's new device" />
            <button className="btn btn-outline" disabled={off || !recCode} onClick={() => void run('Open recovery', () => vault!.openRecovery(h, recCode))}>
              Open
            </button>
          </div>
          <div className="row-btns">
            <button className="btn btn-outline" disabled={off} onClick={() => void run('Approve recovery', () => vault!.approveRecovery(h))}>
              Approve recovery
            </button>
            <button className="btn btn-outline" disabled={off} onClick={() => void run('Finalize recovery', () => vault!.finalizeRecovery(h))}>
              Finalize
            </button>
            <button className="btn btn-outline" disabled={off} onClick={() => void run('Trigger inheritance', () => vault!.triggerInheritance(h))}>
              Trigger inheritance
            </button>
          </div>
        </section>
      )}

      {h.heir && (
        <section className="role">
          <h4>
            <Icon.hourglass /> heir · {Number(h.heir.bps) / 100}%
          </h4>
          <button className="btn btn-outline" disabled={off} onClick={() => void run('Claim inheritance', () => vault!.claimInheritance(h))}>
            Claim my share to this wallet
          </button>
        </section>
      )}

      {h.newDevice && (
        <section className="role">
          <h4>
            <Icon.phone /> new device
          </h4>
          <p className="dim small">Once guardians finalize the recovery to this device, take ownership here.</p>
          <button
            className="btn btn-outline"
            disabled={!vault}
            onClick={async () => {
              const ok = await vault!.adoptRecoveredOwnership(h);
              props.say(ok ? 'This device is now the owner' : 'The vault is not owned by this device yet', ok);
              props.onChange();
            }}
          >
            Check and take ownership
          </button>
        </section>
      )}

      {(h.guardian || h.heir || h.newDevice) && vault && (
        <section className="role">
          <h4>
            <Icon.key /> my codes
          </h4>
          {myCodes.map((c) => (
            <CopyCode key={c} code={c} />
          ))}
          <button
            className="btn btn-ghost"
            onClick={async () => {
              const out: string[] = [];
              if (h.guardian) out.push(await vault.joinAsGuardian(h.address));
              if (h.heir) out.push(await vault.joinAsHeir(h.address, Number(h.heir.bps)));
              if (h.newDevice) out.push(await vault.requestRecovery(h.address));
              setMyCodes(out);
            }}
          >
            Show my codes again
          </button>
        </section>
      )}

      <div className="row-btns sep">
        <button className="btn btn-ghost" onClick={() => download(`keeproxy-${h.address.slice(0, 12)}.json`, exportHeld(h))}>
          <Icon.file /> Download key file
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            if (window.confirm('Forget this vault in this browser? Without a key file its keys are gone for good.')) {
              forgetHeld(h.address);
              props.onChange();
            }
          }}
        >
          Forget
        </button>
      </div>
    </Panel>
  );
}
