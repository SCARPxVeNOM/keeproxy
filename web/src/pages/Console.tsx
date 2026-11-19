import { useCallback, useEffect, useRef, useState } from 'react';
import { Footer, Header, Icon, Panel } from '../components/ui';

// The console drives a real vault through keeproxyd (npm run serve). Every
// button runs as exactly one device; refusals come straight from the
// contract's asserts.

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

export function Console() {
  const [st, setSt] = useState<State | null>(null);
  const [offline, setOffline] = useState(false);
  const [events, setEvents] = useState<Ev[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [clock, setClock] = useState(Math.floor(Date.now() / 1000));
  const evRef = useRef<HTMLDivElement>(null);

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
    evRef.current?.scrollTo({ top: evRef.current.scrollHeight });
  }, [events]);

  const act = async (action: string, params: Record<string, unknown> = {}, label = action) => {
    setPending(label);
    try {
      const r = await post<{ ok: boolean; error?: string; txId?: string }>('/api/act', { action, params });
      setToast(r.ok ? { ok: true, text: `${label} ✓ confirmed${r.txId ? ` · ${short(r.txId, 10)}` : ''}` } : { ok: false, text: `${label} refused: ${r.error}` });
    } catch (e) {
      setToast({ ok: false, text: String(e) });
    } finally {
      setPending(null);
      void refresh();
      setTimeout(() => setToast(null), 6000);
    }
  };

  const create = async () => {
    setPending('create-vault');
    const r = await post<{ ok: boolean; error?: string }>('/api/vault', { threshold: 2, inactivity: 600, veto: 180 });
    setPending(null);
    setToast(r.ok ? { ok: true, text: 'Vault ready' } : { ok: false, text: r.error ?? 'failed' });
    void refresh();
  };

  const c = st?.chain ?? null;
  const d = st?.devices ?? null;
  const busy = pending !== null || !!st?.busy;
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

  return (
    <>
      <Header page="console" />
      <main className="console">
        <div className="container-wide">
          <div className="console-top">
            <div>
              <div className="label">console · {st?.network ?? '…'}</div>
              <h1 className="title">
                Your vault, every device<span className="dot">.</span>
              </h1>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {st?.busy && (
                <span className="badge blue">
                  <span className="spinner" /> {st.busy}
                </span>
              )}
              {c && <span className={`badge ${c.phase === 'ACTIVE' ? 'ok' : c.phase === 'RECOVERING' ? 'blue' : 'bad'}`}>{c.phase}</span>}
            </div>
          </div>

          {offline && (
            <Panel title="keeproxyd" center>
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
            <Panel title="no vault yet" center>
              <div className="empty">
                <div className="pixel" style={{ fontSize: 28, color: '#fff' }}>Deploy a vault<span className="dot">.</span></div>
                <p className="muted" style={{ maxWidth: 460, margin: '10px auto 20px' }}>
                  Staged deploy (constructor + 13 verifier keys across 10 transactions), then 3 guardians, 2 heirs, one agent
                  mandate, one payee and a 1000 NIGHT deposit. Demo timers: 10 min inactivity, 3 min veto.
                </p>
                <button className="btn btn-primary" disabled={busy} onClick={create}>
                  {pending === 'create-vault' || st.busy ? <span className="spinner" /> : null} Deploy vault <Icon.arrow />
                </button>
                {events.length > 0 && (
                  <div className="events" ref={evRef} style={{ textAlign: 'left', maxWidth: 560, margin: '26px auto 0' }}>
                    {events.slice(-14).map((e, i) => (
                      <div className="event" key={i}>
                        <span className="dim">{hms(e.at)}</span>
                        <span className={e.kind === 'tx' ? 'lvl-OK' : e.kind === 'progress' ? 'lvl-PROOF' : e.kind === 'refused' ? 'lvl-REFUSED' : 'lvl-INFO'}>
                          {e.kind === 'tx' ? 'OK' : e.kind.toUpperCase()}
                        </span>
                        <span className="muted">
                          {e.circuit && <span className="p">{e.circuit} </span>}
                          {e.message}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Panel>
          )}

          {c && d && (
            <>
              <div className="acts">
                <div className="act"><b>Act 1 · Delegate</b>Agent pays within its cap; over-cap and stranger payments are refused; the kill switch stops it.</div>
                <div className="act"><b>Act 2 · Recover &amp; restore</b>Back up, lose the laptop, two guardians rotate the key, shares restore the backup on the new phone.</div>
                <div className="act"><b>Act 3 · Inherit</b>The owner goes silent past {fmtDur(c.inactivitySeconds)}; heirs claim their private shares once.</div>
              </div>
              <div className="console-grid">
                <div className="devices">
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
                        <B a="releaseShare" p={{ guardian: i }} label="release share" />
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
                  {d.restored && (
                    <Panel title="restored on new device" className="device wide" right={<span className="badge ok">v{d.restored.version} · digest ok</span>}>
                      <div className="code" style={{ fontSize: 10.5, maxHeight: 180, overflow: 'auto' }}>
                        {JSON.stringify(d.restored.payload, null, 2)}
                      </div>
                    </Panel>
                  )}
                </div>

                <div style={{ display: 'grid', gap: 16 }}>
                  <Panel title="what the chain sees" right={<span className="live">INDEXER</span>}>
                    <dl className="kv">
                      <dt>contract</dt><dd className="hl">{short(c.address, 12)}</dd>
                      <dt>phase</dt><dd className="hl">{c.phase}</dd>
                      <dt>balance</dt><dd className="hl">{c.balance} NIGHT</dd>
                      <dt>ownerKey</dt><dd>{short(c.ownerKey)} <span className="dim">rotations {c.ownerRotations}</span></dd>
                      <dt>rules</dt><dd>{c.threshold}-of-{c.guardianCount} · inactivity {fmtDur(c.inactivitySeconds)} · veto {fmtDur(c.vetoSeconds)}</dd>
                      <dt>guardians root</dt><dd>{short(c.guardianRoot)}</dd>
                      <dt>heirs root</dt><dd>{short(c.heirRoot)}</dd>
                      <dt>mandates root</dt><dd>{short(c.mandateRoot)} <span className="dim">gen {c.mandateGeneration}</span></dd>
                      <dt>payees root</dt><dd>{short(c.payeeRoot)}</dd>
                      <dt>epoch spend</dt><dd>{c.epochSpend.length ? c.epochSpend.map((e) => `${short(e.key, 6)}=${e.spent}`).join(' · ') : '—'}</dd>
                      <dt>recovery</dt><dd>round {c.recoveryRound} · approvals {c.approvals}/{c.threshold} · nullifiers {c.approvalNullifiers.length}</dd>
                      <dt>device key</dt><dd>{short(c.pendingDeviceKey)}</dd>
                      <dt>backup</dt><dd>v{c.backupVersion} · {short(c.backupDigest)}</dd>
                      <dt>released shares</dt><dd>{c.releasedShares.length} sealed</dd>
                      <dt>estate</dt><dd>{c.estate} · paid {c.estatePaid} · claims {c.heirClaims.length}</dd>
                    </dl>
                    <div style={{ marginTop: 14 }}>
                      <div className="eyebrow" style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>silence</span>
                        <span>{fmtDur(silence)} / {fmtDur(c.inactivitySeconds)}</span>
                      </div>
                      <div className={`bar ${silence >= c.inactivitySeconds ? 'red' : 'amber'}`} style={{ marginTop: 6 }}>
                        <i style={{ width: `${Math.min(100, (silence / c.inactivitySeconds) * 100)}%` }} />
                      </div>
                      {c.phase === 'RECOVERING' && (
                        <>
                          <div className="eyebrow" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
                            <span>veto window</span>
                            <span>{vetoLeft > 0 ? `${fmtDur(vetoLeft)} left` : 'closed'}</span>
                          </div>
                          <div className="bar" style={{ marginTop: 6 }}>
                            <i style={{ width: `${Math.max(0, Math.min(100, 100 - (vetoLeft / c.vetoSeconds) * 100))}%` }} />
                          </div>
                        </>
                      )}
                      <div className="eyebrow" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
                        <span>agent spend this epoch</span>
                        <span>{spent} / private cap</span>
                      </div>
                    </div>
                    <div className="dim mono" style={{ fontSize: 10.5, marginTop: 14 }}>
                      Nothing here names a guardian, heir, agent, cap or allowlist.
                    </div>
                  </Panel>
                  <Panel title="vault events" center right={<span className="live">LIVE</span>} bodyClass="panel-body">
                    <div className="events" ref={evRef}>
                      {events.length === 0 && <div className="dim">waiting for events…</div>}
                      {events.map((e, i) => (
                        <div className="event" key={i}>
                          <span className="dim">{hms(e.at)}</span>
                          <span className={e.kind === 'tx' ? 'lvl-OK' : e.kind === 'refused' ? 'lvl-REFUSED' : e.kind === 'progress' ? 'lvl-PROOF' : 'lvl-INFO'}>
                            {e.kind === 'tx' ? 'OK' : e.kind.toUpperCase()}
                          </span>
                          <span>
                            {e.device && <span className="who">{e.device} </span>}
                            {e.circuit && <span className="p">{e.circuit} </span>}
                            <span className={e.kind === 'refused' ? '' : 'muted'}>{e.message}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </Panel>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'bad'}`}>{toast.text}</div>}
      <Footer />
    </>
  );
}
