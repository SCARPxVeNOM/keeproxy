import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Footer, Header, Icon, Panel } from '../components/ui';

// The console drives a real vault through keeproxyd (npm run serve). Every
// button runs as exactly one device; refusals come straight from the
// contract's asserts. "Guided" walks the three acts step by step; "All
// devices" exposes every action at once.

interface Chain {
  address: string;
  network: string;
  phase: 'ACTIVE' | 'RECOVERING' | 'INHERITED';
  vaultId: string;
  threshold: number;
  inactivitySeconds: number;
  vetoSeconds: number;
  ownerKey: string;
  ownerRotations: number;
  lastSeen: number;
  balance: string;
  guardianCount: number;
  guardianRoot: string;
  heirRoot: string;
  mandateRoot: string;
  payeeRoot: string;
  mandateGeneration: number;
  epochSpend: { key: string; spent: string }[];
  recoveryRound: number;
  pendingOwner: string;
  pendingDeviceKey: string;
  recoveryOpenedAt: number;
  approvals: number;
  approvalNullifiers: string[];
  restoredRound: number;
  backupDigest: string;
  backupVersion: number;
  releasedShares: { nullifier: string; bytes: number }[];
  estate: string;
  estatePaid: string;
  heirClaims: string[];
}
interface Devices {
  owner: { secret: string };
  agent: { secret: string; mandate: { capPerEpoch: string; epochSeconds: string; expiresAt: number; generation: string } };
  guardians: { secret: string; hasShare: boolean }[];
  heirs: { secret: string; shareBps: number }[];
  newDevice: { secret: string } | null;
  backups: { version: number; digest: string; bytes: number }[];
  restored: { version: string; payload: Record<string, unknown> } | null;
  timers: { threshold: string; inactivity: string; veto: string };
}
interface State {
  network: string;
  busy: string | null;
  chain: Chain | null;
  devices: Devices | null;
  now: number;
}
interface Ev {
  at: number;
  kind: 'tx' | 'refused' | 'info' | 'progress' | 'error';
  device?: string;
  circuit?: string;
  message: string;
  txId?: string;
}
interface Result {
  ok: boolean;
  error?: string;
  txId?: string;
}

const short = (h: string, n = 8) => (h && /[^0]/.test(h) ? `${h.slice(0, n)}…${h.slice(-4)}` : '—');
const fmtDur = (s: number) => {
  if (s <= 0) return '0s';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${x}s` : `${x}s`;
};
const hms = (t: number) => new Date(t).toTimeString().slice(0, 8);

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await r.json()) as T;
}

const store = {
  get<T>(k: string, fallback: T): T {
    try {
      const v = localStorage.getItem(k);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode: the checklist just won't persist */
    }
  },
};

// ------------------------------------------------------------- guided acts

type Who = 'owner' | 'agent' | 'g0' | 'g1' | 'g2' | 'phone' | 'lost' | 'heir0' | 'heir1';
const WHO: Record<Who, { name: string; icon: (p: { className?: string }) => ReactNode }> = {
  owner: { name: 'owner laptop', icon: Icon.laptop },
  agent: { name: 'AI agent', icon: Icon.bot },
  g0: { name: 'guardian 0', icon: Icon.users },
  g1: { name: 'guardian 1', icon: Icon.users },
  g2: { name: 'guardian 2', icon: Icon.users },
  phone: { name: 'new phone', icon: Icon.phone },
  lost: { name: 'stolen laptop', icon: Icon.laptop },
  heir0: { name: 'heir 0', icon: Icon.hourglass },
  heir1: { name: 'heir 1', icon: Icon.hourglass },
};

interface Step {
  id: string;
  who: Who;
  title: string;
  why: string;
  a: string;
  p?: Record<string, unknown>;
  expect: 'ok' | 'refused';
  /** Seconds until the contract will accept this step, if it is time-gated. */
  wait?: (c: Chain, now: number) => number;
}
interface Act {
  key: string;
  n: string;
  name: string;
  blurb: string;
  steps: Step[];
}

const ACTS: Act[] = [
  {
    key: 'delegate',
    n: '01',
    name: 'Delegate',
    blurb: 'Your AI agent spends from the vault under a private mandate. The chain checks the rules without learning them.',
    steps: [
      { id: 'd1', who: 'agent', title: 'Pay 50 to an allowlisted payee', why: 'Within the cap, to someone on the private allowlist.', a: 'agentPay', p: { amount: 50, recipient: 'payee' }, expect: 'ok' },
      { id: 'd2', who: 'agent', title: 'Try to pay 180', why: 'That is over the per-epoch cap the chain never sees.', a: 'agentPay', p: { amount: 180, recipient: 'payee' }, expect: 'refused' },
      { id: 'd3', who: 'agent', title: 'Try to pay 10 to a stranger', why: 'The recipient is not on the allowlist.', a: 'agentPay', p: { amount: 10, recipient: 'stranger' }, expect: 'refused' },
      { id: 'd4', who: 'owner', title: 'Deposit 100 NIGHT', why: 'Top up the vault from the owner laptop.', a: 'deposit', p: { amount: 100 }, expect: 'ok' },
      { id: 'd5', who: 'owner', title: 'Hit the kill switch', why: 'Revokes every agent mandate in one transaction.', a: 'revokeMandates', expect: 'ok' },
      { id: 'd6', who: 'agent', title: 'Try to pay 50 again', why: 'Its mandate belongs to a revoked generation now.', a: 'agentPay', p: { amount: 50, recipient: 'payee' }, expect: 'refused' },
    ],
  },
  {
    key: 'recover',
    n: '02',
    name: 'Recover & restore',
    blurb: 'You lose your laptop. Two of three anonymous guardians move the vault to your new phone, and your encrypted backup comes back with it.',
    steps: [
      { id: 'r1', who: 'owner', title: 'Back up private state', why: 'Encrypted locally; only the digest and version go on chain. The key is split 2-of-3 to guardians.', a: 'backup', expect: 'ok' },
      { id: 'r2', who: 'g0', title: 'Open recovery to the new phone', why: 'The laptop is gone. A guardian proposes the new phone as owner.', a: 'openRecovery', p: { guardian: 0 }, expect: 'ok' },
      { id: 'r3', who: 'g0', title: 'Approve', why: 'Proves guardian membership without saying which guardian.', a: 'approveRecovery', p: { guardian: 0 }, expect: 'ok' },
      { id: 'r4', who: 'g0', title: 'Try to approve twice', why: 'The nullifier for this round is already spent.', a: 'approveRecovery', p: { guardian: 0 }, expect: 'refused' },
      { id: 'r5', who: 'g1', title: 'Approve', why: 'Second approval reaches the 2-of-3 threshold.', a: 'approveRecovery', p: { guardian: 1 }, expect: 'ok' },
      {
        id: 'r6', who: 'g2', title: 'Finalize after the veto window', why: 'The real owner had a window to cancel with a heartbeat. Now the key rotates.', a: 'finalizeRecovery', expect: 'ok',
        wait: (c, now) => (c.phase === 'RECOVERING' ? c.recoveryOpenedAt + c.vetoSeconds - now : 0),
      },
      { id: 'r7', who: 'lost', title: 'Thief tries a heartbeat', why: 'The old key was rotated away. The stolen laptop is useless.', a: 'stolenDeviceHeartbeat', expect: 'refused' },
      { id: 'r8', who: 'phone', title: 'Try to restore too early', why: 'No guardian has released a key share yet.', a: 'restore', expect: 'refused' },
      { id: 'r9', who: 'g0', title: 'Release backup share', why: 'Sealed to the new phone’s X25519 key; only it can open it.', a: 'releaseShare', p: { guardian: 0 }, expect: 'ok' },
      { id: 'r10', who: 'g0', title: 'Try to release twice', why: 'One release per guardian per round.', a: 'releaseShare', p: { guardian: 0 }, expect: 'refused' },
      { id: 'r11', who: 'g1', title: 'Release backup share', why: 'Two shares rebuild the backup key.', a: 'releaseShare', p: { guardian: 1 }, expect: 'ok' },
      { id: 'r12', who: 'phone', title: 'Restore the backup', why: 'Decrypts it and checks it against the digest anchored on chain.', a: 'restore', expect: 'ok' },
      { id: 'r13', who: 'phone', title: 'Check in as the new owner', why: 'The phone now holds the owner key.', a: 'heartbeat', expect: 'ok' },
    ],
  },
  {
    key: 'inherit',
    n: '03',
    name: 'Inherit',
    blurb: 'The owner goes silent. After the inactivity period, heirs claim private shares once each, and guardians release sealed documents.',
    steps: [
      { id: 'i1', who: 'g0', title: 'Try to trigger inheritance early', why: 'The owner checked in too recently.', a: 'triggerInheritance', expect: 'refused' },
      { id: 'i2', who: 'heir0', title: 'Try to claim early', why: 'Inheritance has not been triggered.', a: 'claimInheritance', p: { heir: 0 }, expect: 'refused' },
      {
        id: 'i3', who: 'g0', title: 'Trigger inheritance', why: 'The owner has been silent past the inactivity period. The estate is frozen.', a: 'triggerInheritance', expect: 'ok',
        wait: (c, now) => (c.phase === 'ACTIVE' ? c.lastSeen + c.inactivitySeconds - now : 0),
      },
      { id: 'i4', who: 'heir0', title: 'Claim my share', why: 'Proves a private share without revealing it in advance.', a: 'claimInheritance', p: { heir: 0 }, expect: 'ok' },
      { id: 'i5', who: 'heir0', title: 'Try to claim twice', why: 'The claim nullifier is already spent.', a: 'claimInheritance', p: { heir: 0 }, expect: 'refused' },
      { id: 'i6', who: 'heir1', title: 'Claim my share', why: 'The second heir takes the rest of the estate.', a: 'claimInheritance', p: { heir: 1 }, expect: 'ok' },
      { id: 'i7', who: 'g2', title: 'Release sealed documents', why: 'Disclose: after inheritance, guardians release document keys.', a: 'releaseShare', p: { guardian: 2 }, expect: 'ok' },
    ],
  },
];

// -------------------------------------------------------------- animations

/** Eases a number towards its new value. */
function useCountUp(target: number, ms = 700) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      setV(Math.round(a + (target - a) * e));
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      from.current = target;
    };
  }, [target, ms]);
  return v;
}

/** Re-mounts on change so the flash animation plays. */
const Flash = ({ v, children }: { v: unknown; children: ReactNode }) => (
  <span key={String(v)} className="flash">
    {children}
  </span>
);

const PHASES = ['ACTIVE', 'RECOVERING', 'INHERITED'] as const;
function PhaseRail({ phase }: { phase: Chain['phase'] }) {
  const at = PHASES.indexOf(phase);
  return (
    <div className="phase-rail">
      {PHASES.map((p, i) => (
        <div key={p} className={`phase-step ${i === at ? 'on' : i < at ? 'past' : ''} ${p.toLowerCase()}`}>
          <i />
          <span>{p.toLowerCase()}</span>
          {i < PHASES.length - 1 && <em />}
        </div>
      ))}
    </div>
  );
}

function Tile(props: { label: string; value: ReactNode; sub?: ReactNode; bar?: number; tone?: string }) {
  return (
    <div className="tile">
      <div className="eyebrow">{props.label}</div>
      <div className="tile-v">{props.value}</div>
      {props.bar !== undefined && (
        <div className={`bar ${props.tone ?? ''}`}>
          <i style={{ width: `${Math.max(0, Math.min(100, props.bar))}%` }} />
        </div>
      )}
      {props.sub && <div className="tile-sub">{props.sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- console

export function Console() {
  const [st, setSt] = useState<State | null>(null);
  const [offline, setOffline] = useState(false);
  const [events, setEvents] = useState<Ev[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [toast, setToast] = useState<{ ok: boolean; text: string; n: number } | null>(null);
  const [clock, setClock] = useState(Math.floor(Date.now() / 1000));
  const [view, setView] = useState<'guided' | 'devices'>(() => store.get('kp.view', 'guided'));
  const [actKey, setActKey] = useState<string>(() => store.get('kp.act', 'delegate'));
  const [results, setResults] = useState<Record<string, Result>>({});
  const [allFields, setAllFields] = useState(false);
  const [armNew, setArmNew] = useState(false);
  const [proofOpen, setProofOpen] = useState<string | null>(null);
  const [evProof, setEvProof] = useState<string | null>(null);
  const evRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/state');
      setSt((await r.json()) as State);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 5000);
    const tick = setInterval(() => setClock(Math.floor(Date.now() / 1000)), 1000);
    const es = new EventSource('/api/events');
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as Ev;
      setEvents((xs) => [...xs.slice(-200), e]);
      if (e.kind === 'tx' || e.kind === 'info') void refresh();
    };
    return () => {
      clearInterval(id);
      clearInterval(tick);
      es.close();
    };
  }, [refresh]);

  useEffect(() => {
    evRef.current?.scrollTo({ top: evRef.current.scrollHeight, behavior: 'smooth' });
  }, [events]);

  const c = st?.chain ?? null;
  const d = st?.devices ?? null;
  const resultsKey = c ? `kp.results.${c.address}` : null;

  // The checklist belongs to one deployed vault.
  useEffect(() => {
    if (resultsKey) setResults(store.get(resultsKey, {}));
  }, [resultsKey]);
  useEffect(() => store.set('kp.view', view), [view]);
  useEffect(() => store.set('kp.act', actKey), [actKey]);

  const notify = (ok: boolean, text: string) => {
    clearTimeout(toastTimer.current);
    setToast({ ok, text, n: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  };

  const act = async (action: string, params: Record<string, unknown> = {}, label = action, stepId?: string) => {
    setPending(stepId ?? label);
    setStartedAt(Date.now());
    try {
      const r = await post<Result>('/api/act', { action, params });
      notify(r.ok, r.ok ? `${label} ✓ confirmed${r.txId ? ` · ${short(r.txId, 10)}` : ''}` : `${label} refused: ${r.error}`);
      if (stepId && resultsKey) {
        setResults((xs) => {
          const next = { ...xs, [stepId]: { ok: r.ok, error: r.error, txId: r.txId } };
          store.set(resultsKey, next);
          return next;
        });
      }
    } catch (e) {
      notify(false, String(e));
    } finally {
      setPending(null);
      void refresh();
    }
  };

  const create = async () => {
    setPending('create-vault');
    setStartedAt(Date.now());
    const r = await post<{ ok: boolean; error?: string }>('/api/vault', { threshold: 2, inactivity: 600, veto: 180 });
    setPending(null);
    notify(r.ok, r.ok ? 'Vault ready' : r.error ?? 'failed');
    void refresh();
  };

  const resetChecklist = () => {
    if (!resultsKey) return;
    setResults({});
    store.set(resultsKey, {});
  };

  const busy = pending !== null || !!st?.busy;
  const elapsed = pending ? Math.max(0, clock - Math.floor(startedAt / 1000)) : 0;
  const B = (props: { a: string; p?: Record<string, unknown>; label: string; danger?: boolean; disabled?: boolean }) => (
    <button
      className={`btn ${props.danger ? 'btn-danger' : 'btn-outline'}`}
      disabled={busy || props.disabled}
      onClick={() => act(props.a, props.p, props.label)}
    >
      {pending === props.label ? <span className="spinner" /> : null}
      {props.label}
    </button>
  );

  const silence = c ? clock - c.lastSeen : 0;
  const vetoLeft = c && c.phase === 'RECOVERING' ? c.recoveryOpenedAt + c.vetoSeconds - clock : 0;
  const spent = c?.epochSpend.reduce((a, e) => a + Number(e.spent), 0) ?? 0;
  const balance = useCountUp(c ? Number(c.balance) : 0);
  const spentAnim = useCountUp(spent);
  const actIdx = Math.max(0, ACTS.findIndex((x) => x.key === actKey));
  const curAct = ACTS[actIdx]!;
  const nextId = curAct.steps.find((s) => !results[s.id])?.id;
  const progressEv = [...events].reverse().find((e) => e.kind === 'progress');

  return (
    <>
      <Header page="console" />
      <main className="console">
        <div className="console-glow" aria-hidden />
        <div className="container-wide">
          <div className="console-top">
            <div className="reveal">
              <div className="label">console · {st?.network ?? '…'}</div>
              <h1 className="title">
                Your vault, every device<span className="dot">.</span>
              </h1>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              {st?.busy && !pending && (
                <span className="badge blue">
                  <span className="spinner" /> {st.busy}
                </span>
              )}
              {c && <PhaseRail phase={c.phase} />}
            </div>
          </div>

          {offline && (
            <Panel title="keeproxyd" center className="reveal">
              <div className="empty">
                <div className="pixel" style={{ fontSize: 26, color: '#fff' }}>Console offline<span className="dot">.</span></div>
                <p className="muted mono" style={{ fontSize: 12 }}>
                  Start the local network and the backend:<br />
                  <span className="inline-code">npm run env:up && npm run serve</span>
                </p>
              </div>
            </Panel>
          )}

          {!offline && st && !c && (
            <Panel title="no vault yet" center className="reveal">
              <div className="empty">
                <div className="orbit" aria-hidden>
                  <i /><i /><i />
                  <Icon.shield />
                </div>
                <div className="pixel" style={{ fontSize: 28, color: '#fff' }}>Deploy a vault<span className="dot">.</span></div>
                <p className="muted" style={{ maxWidth: 460, margin: '10px auto 20px' }}>
                  One click sets up everything: the contract (13 circuits across 10 transactions), 3 guardians, 2 heirs, an AI agent
                  with a spending mandate, and 1000 NIGHT. Demo timers: 10 min inactivity, 3 min veto.
                </p>
                <button className="btn btn-primary btn-lg" disabled={busy} onClick={create}>
                  {pending === 'create-vault' || st.busy ? <span className="spinner light" /> : null} Deploy vault <Icon.arrow />
                </button>
                {(pending === 'create-vault' || st.busy) && (
                  <div className="deploying">
                    <div className="shimmer" />
                    <div className="mono dim" style={{ fontSize: 11, marginTop: 8 }}>
                      {progressEv?.message ?? 'starting…'} · {fmtDur(elapsed)}
                    </div>
                  </div>
                )}
                {events.length > 0 && (
                  <div className="events" ref={evRef} style={{ textAlign: 'left', maxWidth: 560, margin: '26px auto 0' }}>
                    {events.slice(-14).map((e, i) => (
                      <EventRow e={e} key={`${e.at}-${i}`} />
                    ))}
                  </div>
                )}
              </div>
            </Panel>
          )}

          {c && d && (
            <>
              <div className="tiles reveal">
                <Tile label="vault balance" value={<>{balance}<small> NIGHT</small></>} sub={<>estate paid {c.estatePaid} / {c.estate}</>} />
                <Tile
                  label="owner silence"
                  value={fmtDur(silence)}
                  bar={(silence / c.inactivitySeconds) * 100}
                  tone={silence >= c.inactivitySeconds ? 'red' : 'amber'}
                  sub={silence >= c.inactivitySeconds ? 'heirs can be triggered' : `inheritance after ${fmtDur(c.inactivitySeconds)}`}
                />
                <Tile
                  label={c.phase === 'RECOVERING' ? 'recovery · veto window' : 'guardian approvals'}
                  value={<>{c.approvals}<small> / {c.threshold}</small></>}
                  bar={c.phase === 'RECOVERING' ? 100 - (Math.max(0, vetoLeft) / c.vetoSeconds) * 100 : (c.approvals / c.threshold) * 100}
                  tone={c.phase === 'RECOVERING' && vetoLeft <= 0 ? 'green' : ''}
                  sub={c.phase === 'RECOVERING' ? (vetoLeft > 0 ? `${fmtDur(vetoLeft)} until it can finalize` : 'ready to finalize') : `round ${c.recoveryRound} · key rotations ${c.ownerRotations}`}
                />
                <Tile
                  label="agent spend this epoch"
                  value={spentAnim}
                  sub={Number(d.agent.mandate.generation) === c.mandateGeneration ? 'mandate active · cap is private' : <span style={{ color: 'var(--red)' }}>mandate revoked</span>}
                />
              </div>

              <div className="viewbar reveal">
                <div className="seg">
                  <button className={view === 'guided' ? 'on' : ''} onClick={() => setView('guided')}>
                    <Icon.zap /> Guided
                  </button>
                  <button className={view === 'devices' ? 'on' : ''} onClick={() => setView('devices')}>
                    <Icon.layers /> All devices
                  </button>
                  <i className={`seg-pill ${view}`} />
                </div>
                <span className="mono dim" style={{ fontSize: 11 }}>
                  {view === 'guided' ? 'Follow the steps. Each one runs as a single device with a real proof (~20s).' : 'Every action, grouped by the device that holds the secret.'}
                </span>
                <button
                  className={`btn ${armNew ? 'btn-danger' : 'btn-outline'} new-vault`}
                  disabled={busy}
                  onClick={() => (armNew ? (setArmNew(false), void create()) : setArmNew(true))}
                  onBlur={() => setArmNew(false)}
                >
                  {pending === 'create-vault' ? <span className="spinner" /> : <Icon.shield />}
                  {pending === 'create-vault' ? 'deploying…' : armNew ? 'click again to redeploy' : 'new vault'}
                </button>
              </div>
              {pending === 'create-vault' && (
                <div className="deploying wide reveal">
                  <div className="shimmer" />
                  <div className="mono dim" style={{ fontSize: 11, marginTop: 8 }}>
                    deploying a fresh vault · {progressEv?.message ?? 'starting…'} · {fmtDur(elapsed)}
                  </div>
                </div>
              )}

              <div className="console-grid">
                <div>
                  {view === 'guided' ? (
                    <>
                      <div className="act-tabs">
                        {ACTS.map((x) => {
                          const done = x.steps.filter((s) => results[s.id]).length;
                          return (
                            <button key={x.key} className={`act-tab ${x.key === curAct.key ? 'on' : ''}`} onClick={() => setActKey(x.key)}>
                              <span className="act-n">{x.n}</span>
                              <span className="act-name">{x.name}</span>
                              <span className="act-count">{done === x.steps.length ? <Icon.check /> : `${done}/${x.steps.length}`}</span>
                              <span className="act-prog"><i style={{ width: `${(done / x.steps.length) * 100}%` }} /></span>
                            </button>
                          );
                        })}
                      </div>
                      <div className="act-body" key={curAct.key}>
                        <p className="act-blurb">{curAct.blurb}</p>
                        <ol className="steps">
                          {curAct.steps.map((s, i) => {
                            const r = results[s.id];
                            const running = pending === s.id;
                            const wait = s.wait ? s.wait(c, clock) : 0;
                            const asExpected = r && (r.ok ? s.expect === 'ok' : s.expect === 'refused');
                            const W = WHO[s.who];
                            const state = running ? 'running' : r ? (asExpected ? 'pass' : 'fail') : s.id === nextId ? 'next' : '';
                            return (
                              <li key={s.id} className={`step ${state}`} style={{ animationDelay: `${i * 45}ms` }}>
                                <div className="step-n">{r && !running ? (asExpected ? <Icon.check /> : '!') : i + 1}</div>
                                <div className="step-main">
                                  <div className="step-head">
                                    <span className="who-chip"><W.icon /> {W.name}</span>
                                    <span className={`expect ${s.expect}`}>{s.expect === 'ok' ? 'should go through' : 'should be refused'}</span>
                                  </div>
                                  <div className="step-title">{s.title}</div>
                                  <div className="step-why">{s.why}</div>
                                  {running && (
                                    <div className="proving">
                                      <div className="shimmer" />
                                      <span>generating zero-knowledge proof · {fmtDur(elapsed)}</span>
                                    </div>
                                  )}
                                  {r && !running && (
                                    <div className={`step-res ${asExpected ? 'good' : 'bad'}`}>
                                      {r.ok
                                        ? <>confirmed on chain{r.txId ? ` · tx ${short(r.txId, 10)}` : ''}{s.expect === 'refused' && ' (expected a refusal)'}</>
                                        : <>{s.expect === 'refused' ? 'refused, as designed: ' : 'refused: '}{r.error}</>}
                                      {r.ok && r.txId && (
                                        <button className="proof-btn" onClick={() => setProofOpen(proofOpen === s.id ? null : s.id)}>
                                          <Icon.shield /> {proofOpen === s.id ? 'hide proof' : 'view proof'}
                                        </button>
                                      )}
                                      {!r.ok && (
                                        <div className="res-note">
                                          No transaction exists: the contract's check failed while building the proof, so nothing could be submitted.
                                        </div>
                                      )}
                                    </div>
                                  )}
                                  {r?.ok && r.txId && proofOpen === s.id && !running && (
                                    <Receipt hash={r.txId} contract={c.address} onClose={() => setProofOpen(null)} />
                                  )}
                                </div>
                                <div className="step-go">
                                  {wait > 0 && !r && <span className="wait"><Icon.clock /> ready in {fmtDur(wait)}</span>}
                                  <button
                                    className={`btn ${s.id === nextId && !r ? 'btn-primary' : 'btn-outline'}`}
                                    disabled={busy}
                                    onClick={() => act(s.a, s.p, s.title, s.id)}
                                  >
                                    {running ? <span className={`spinner ${s.id === nextId ? 'light' : ''}`} /> : null}
                                    {r ? 'run again' : 'run'}
                                  </button>
                                </div>
                              </li>
                            );
                          })}
                        </ol>
                        <div className="act-foot">
                          {actIdx > 0 ? <button className="more" onClick={() => setActKey(ACTS[actIdx - 1]!.key)}>← {ACTS[actIdx - 1]!.name}</button> : <span />}
                          <button className="more dim" onClick={resetChecklist}>reset checklist</button>
                          {actIdx < ACTS.length - 1 ? <button className="more" onClick={() => setActKey(ACTS[actIdx + 1]!.key)}>{ACTS[actIdx + 1]!.name} →</button> : <span />}
                        </div>
                        {curAct.key === 'recover' && d.restored && <RestoredPanel d={d} />}
                      </div>
                    </>
                  ) : (
                    <div className="devices act-body">
                      <Panel title={<><Icon.laptop className="" /> owner laptop</>} className="device">
                        <div className="holds">holds <b>owner secret {d.owner.secret}</b>{d.backups.length > 0 && <> · backup v{d.backups.at(-1)!.version}</>}</div>
                        <div className="actions">
                          <B a="heartbeat" label="heartbeat" />
                          <B a="deposit" p={{ amount: 100 }} label="deposit 100" />
                          <B a="backup" label="backup" />
                          <B a="revokeMandates" label="kill switch" danger />
                          {c.ownerRotations > 0 && <B a="stolenDeviceHeartbeat" label="old laptop: heartbeat" danger />}
                        </div>
                      </Panel>
                      <Panel title={<><Icon.bot className="" /> agent runtime</>} className="device">
                        <div className="holds">
                          holds <b>agent key + mandate</b> · cap {d.agent.mandate.capPerEpoch}/{Number(d.agent.mandate.epochSeconds) / 86400}d ·{' '}
                          {Number(d.agent.mandate.generation) === c.mandateGeneration ? 'current' : <span style={{ color: 'var(--red)' }}>revoked</span>}
                        </div>
                        <div className="actions">
                          <B a="agentPay" p={{ amount: 50, recipient: 'payee' }} label="pay 50 → payee" />
                          <B a="agentPay" p={{ amount: 180, recipient: 'payee' }} label="pay 180 → payee" />
                          <B a="agentPay" p={{ amount: 10, recipient: 'stranger' }} label="pay 10 → stranger" danger />
                        </div>
                      </Panel>
                      {d.guardians.map((g, i) => (
                        <Panel key={i} title={<><Icon.users className="" /> guardian {i}</>} className="device">
                          <div className="holds">holds <b>guardian secret {g.secret}</b>{g.hasShare && <> · <b>backup share</b></>}</div>
                          <div className="actions">
                            {i === 0 && <B a="openRecovery" p={{ guardian: 0 }} label="open recovery" />}
                            <B a="approveRecovery" p={{ guardian: i }} label={`approve (g${i})`} />
                            {i === 2 && <B a="finalizeRecovery" label="finalize" />}
                            <B a="releaseShare" p={{ guardian: i }} label={`release share (g${i})`} />
                            {i === 0 && <B a="triggerInheritance" label="trigger inheritance" />}
                          </div>
                        </Panel>
                      ))}
                      <Panel title={<><Icon.phone className="" /> new device</>} className="device">
                        <div className="holds">
                          {d.newDevice ? <>holds <b>new owner secret {d.newDevice.secret}</b> + X25519 key</> : 'not set up: a guardian opens a recovery for it'}
                        </div>
                        <div className="actions">
                          <B a="restore" label="restore backup" disabled={!d.newDevice} />
                        </div>
                      </Panel>
                      {d.heirs.map((h, i) => (
                        <Panel key={`h${i}`} title={<><Icon.hourglass className="" /> heir {i}</>} className="device">
                          <div className="holds">holds <b>heir secret {h.secret}</b> · share <b>{h.shareBps / 100}%</b></div>
                          <div className="actions">
                            <B a="claimInheritance" p={{ heir: i }} label={`claim (heir ${i})`} />
                          </div>
                        </Panel>
                      ))}
                      {d.restored && <RestoredPanel d={d} wide />}
                    </div>
                  )}
                </div>

                <div className="side">
                  <Panel title="what the chain sees" right={<span className="live">INDEXER</span>}>
                    <dl className="kv">
                      <dt>contract</dt><dd className="hl">{short(c.address, 12)}</dd>
                      <dt>phase</dt><dd className="hl"><Flash v={c.phase}>{c.phase}</Flash></dd>
                      <dt>balance</dt><dd className="hl"><Flash v={c.balance}>{c.balance} NIGHT</Flash></dd>
                      <dt>ownerKey</dt><dd><Flash v={c.ownerKey}>{short(c.ownerKey)}</Flash> <span className="dim">rotations {c.ownerRotations}</span></dd>
                      <dt>rules</dt><dd>{c.threshold}-of-{c.guardianCount} · inactivity {fmtDur(c.inactivitySeconds)} · veto {fmtDur(c.vetoSeconds)}</dd>
                      <dt>recovery</dt><dd><Flash v={`${c.recoveryRound}${c.approvals}`}>round {c.recoveryRound} · approvals {c.approvals}/{c.threshold} · nullifiers {c.approvalNullifiers.length}</Flash></dd>
                      <dt>backup</dt><dd><Flash v={c.backupVersion}>v{c.backupVersion} · {short(c.backupDigest)}</Flash></dd>
                      <dt>estate</dt><dd><Flash v={`${c.estatePaid}${c.heirClaims.length}`}>{c.estate} · paid {c.estatePaid} · claims {c.heirClaims.length}</Flash></dd>
                      {allFields && (
                        <>
                          <dt>guardians root</dt><dd>{short(c.guardianRoot)}</dd>
                          <dt>heirs root</dt><dd>{short(c.heirRoot)}</dd>
                          <dt>mandates root</dt><dd>{short(c.mandateRoot)} <span className="dim">gen <Flash v={c.mandateGeneration}>{c.mandateGeneration}</Flash></span></dd>
                          <dt>payees root</dt><dd>{short(c.payeeRoot)}</dd>
                          <dt>epoch spend</dt><dd>{c.epochSpend.length ? c.epochSpend.map((e) => `${short(e.key, 6)}=${e.spent}`).join(' · ') : '—'}</dd>
                          <dt>device key</dt><dd><Flash v={c.pendingDeviceKey}>{short(c.pendingDeviceKey)}</Flash></dd>
                          <dt>released shares</dt><dd><Flash v={c.releasedShares.length}>{c.releasedShares.length} sealed</Flash></dd>
                        </>
                      )}
                    </dl>
                    <button className="more" style={{ marginTop: 10 }} onClick={() => setAllFields((x) => !x)}>
                      {allFields ? '− fewer fields' : '+ all fields (roots, spend, keys)'}
                    </button>
                    <div className="privacy-note">
                      <Icon.eyeOff /> Nothing here names a guardian, heir, agent, cap or allowlist.
                    </div>
                  </Panel>
                  <Panel title="vault events" center right={<span className="live">LIVE</span>} bodyClass="panel-body">
                    <div className="events" ref={evRef}>
                      {events.length === 0 && <div className="dim">waiting for events…</div>}
                      {events.map((e, i) => (
                        <EventRow e={e} key={`${e.at}-${i}`} onProof={(h) => setEvProof(evProof === h ? null : h)} />
                      ))}
                    </div>
                    {evProof && <Receipt key={evProof} hash={evProof} contract={c.address} onClose={() => setEvProof(null)} />}
                  </Panel>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
      {toast && (
        <div key={toast.n} className={`toast ${toast.ok ? 'ok' : 'bad'}`}>
          {toast.ok ? <Icon.check /> : <Icon.ban />}
          <span>{toast.text}</span>
        </div>
      )}
      <Footer />
    </>
  );
}

function EventRow({ e, onProof }: { e: Ev; onProof?: (hash: string) => void }) {
  return (
    <div className={`event ev-${e.kind}`}>
      <span className="dim">{hms(e.at)}</span>
      <span className={e.kind === 'tx' ? 'lvl-OK' : e.kind === 'refused' ? 'lvl-REFUSED' : e.kind === 'progress' ? 'lvl-PROOF' : 'lvl-INFO'}>
        {e.kind === 'tx' ? 'OK' : e.kind.toUpperCase()}
      </span>
      <span>
        {e.device && <span className="who">{e.device} </span>}
        {e.circuit && <span className="p">{e.circuit} </span>}
        <span className={e.kind === 'refused' ? '' : 'muted'}>{e.message}</span>
        {e.txId && onProof && (
          <button className="ev-proof" onClick={() => onProof(e.txId!)}>proof</button>
        )}
      </span>
    </div>
  );
}

interface TxReceipt {
  hash: string;
  status: string;
  block: { height: number; hash: string; timestamp: number };
  fee: string;
  protocolVersion: number;
  rawBytes: number;
  calls: { kind: 'call' | 'deploy' | 'maintenance'; address: string; entryPoint?: string; proofBytes?: number; proofHead?: string }[];
  outputs: { value: string; owner: string }[];
  indexer: string;
}

const receipts = new Map<string, Promise<TxReceipt>>();
function fetchReceipt(hash: string) {
  let p = receipts.get(hash);
  if (!p) {
    p = fetch(`/api/tx/${hash}`).then(async (r) => {
      const b = (await r.json()) as TxReceipt & { error?: string };
      if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
      return b;
    });
    p.catch(() => receipts.delete(hash));
    receipts.set(hash, p);
  }
  return p;
}

const asciiOf = (h: string) => h.match(/../g)!.map((x) => String.fromCharCode(parseInt(x, 16))).join('');

/** Everything here comes from the indexer, not from keeproxyd's memory. */
function Receipt({ hash, contract, onClose }: { hash: string; contract: string; onClose?: () => void }) {
  const [r, setR] = useState<TxReceipt | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    fetchReceipt(hash).then(setR, (e: unknown) => setErr(String(e instanceof Error ? e.message : e)));
  }, [hash]);

  const curl = r
    ? `curl -s ${r.indexer} -H 'content-type: application/json' -d '{"query":"{ transactions(offset:{hash:\\"${hash}\\"}){ hash ... on RegularTransaction { transactionResult{status} block{height} contractActions{ address ... on ContractCall{entryPoint} } } } }"}'`
    : '';
  const copy = () => {
    void navigator.clipboard?.writeText(curl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="receipt">
      <div className="receipt-head">
        <span><Icon.shield /> on-chain receipt</span>
        {onClose && <button className="more" onClick={onClose}>close</button>}
      </div>
      {!r && !err && (
        <div className="receipt-loading"><div className="shimmer" /><span>asking the indexer…</span></div>
      )}
      {err && <div className="step-res bad">{err}</div>}
      {r && (
        <>
          <ul className="checks">
            <li className={r.status === 'SUCCESS' ? 'ok' : 'bad'}>
              <Icon.check /> included in block <b>#{r.block.height}</b> · status <b>{r.status}</b>
              <span className="dim"> · {new Date(r.block.timestamp).toLocaleTimeString()}</span>
            </li>
            {r.calls.map((k, i) => (
              <li key={i} className={k.address === contract ? 'ok' : ''}>
                <Icon.check /> {k.kind === 'call' ? <>called <b>{k.entryPoint}</b> on {k.address === contract ? 'this vault' : short(k.address, 10)}</> : <>{k.kind} on {short(k.address, 10)}</>}
              </li>
            ))}
            {r.calls.filter((k) => k.proofBytes).map((k, i) => (
              <li key={`p${i}`} className="ok">
                <Icon.check /> carries a <b>{(k.proofBytes! / 1024).toFixed(1)} KB</b> zero-knowledge proof
                <span className="dim"> (“{asciiOf(k.proofHead!)}…”)</span>, verified by the node against the contract’s on-chain key
              </li>
            ))}
            {r.outputs.map((o, i) => (
              <li key={`o${i}`}>
                <Icon.arrow /> paid out <b>{o.value} NIGHT</b> to {short(o.owner.replace(/^mn_addr_\w+?1/, ''), 10)}
              </li>
            ))}
          </ul>
          <dl className="kv receipt-kv">
            <dt>tx hash</dt><dd title={r.hash}>{r.hash}</dd>
            <dt>block hash</dt><dd title={r.block.hash}>{r.block.hash}</dd>
            <dt>size</dt><dd>{(r.rawBytes / 1024).toFixed(1)} KB · protocol {r.protocolVersion}</dd>
            <dt>fee</dt><dd>{r.fee} specks DUST</dd>
          </dl>
          <div className="verify">
            <div className="eyebrow">verify it yourself</div>
            <div className="verify-cmd">
              <code>{curl}</code>
              <button className="btn btn-outline" onClick={copy}>{copied ? <Icon.check /> : <Icon.copy />}{copied ? 'copied' : 'copy'}</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function RestoredPanel({ d, wide }: { d: Devices; wide?: boolean }) {
  return (
    <Panel title="restored on new device" className={`device restored ${wide ? 'wide' : ''}`} right={<span className="badge ok">v{d.restored!.version} · digest ok</span>}>
      <div className="code" style={{ fontSize: 10.5, maxHeight: 180, overflow: 'auto' }}>
        {JSON.stringify(d.restored!.payload, null, 2)}
      </div>
    </Panel>
  );
}
