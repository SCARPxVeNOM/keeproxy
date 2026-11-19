import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Icon } from './ui';

// A scripted replay of a real devnet run (src/test/keeproxy.test.ts): the
// agent pays, gets refused, guardians recover, the owner goes quiet, heirs
// claim. Each line lights the role node that acted.

type Lvl = 'OK' | 'REFUSED' | 'PROOF' | 'VETO' | 'INFO';
type Who = 'agent' | 'guardians' | 'heirs' | 'device' | 'owner';
const SCRIPT: [Lvl, Who, string, string][] = [
  ['PROOF', 'owner', 'enroll  guardian ×3 · heir ×2 · mandate · payee', '1.9s'],
  ['OK', 'owner', 'deposit 1000 NIGHT → vault', '640ms'],
  ['OK', 'agent', 'agentPay 150 → payee   (cap 200/wk)', '2.3s'],
  ['REFUSED', 'agent', "agentPay 51 → payee   exceeds the mandate's cap", '0ms'],
  ['REFUSED', 'agent', 'agentPay 10 → 0x9f3a…  not on the allowlist', '0ms'],
  ['OK', 'owner', 'anchorBackup v1  sha256 7c1e…a90b', '1.1s'],
  ['PROOF', 'guardians', 'openRecovery  guardian ?/3 → new owner key', '2.0s'],
  ['REFUSED', 'guardians', 'approveRecovery  this guardian already approved', '0ms'],
  ['VETO', 'guardians', 'finalizeRecovery  veto window is still open', '0ms'],
  ['OK', 'guardians', 'finalizeRecovery  2/2 · owner rotated', '1.4s'],
  ['REFUSED', 'owner', 'heartbeat from the stolen laptop  only the owner', '0ms'],
  ['OK', 'device', 'releaseShare ×2  sealed to X25519 device key', '1.6s'],
  ['OK', 'device', 'restore v1  digest matches chain · decrypted', '12ms'],
  ['INFO', 'owner', 'silence  180d without a heartbeat', '—'],
  ['OK', 'heirs', 'triggerInheritance  estate frozen: 850', '1.2s'],
  ['OK', 'heirs', 'claimInheritance  heir ? · 60%  → 510', '1.8s'],
  ['REFUSED', 'heirs', 'claimInheritance  this heir already claimed', '0ms'],
];

const pad = (n: number) => String(n).padStart(2, '0');

export function HeroStage() {
  const [shown, setShown] = useState(0);
  const start = useRef(Date.now());
  useEffect(() => {
    const id = setInterval(() => setShown((s) => (s >= SCRIPT.length + 4 ? 0 : s + 1)), 900);
    return () => clearInterval(id);
  }, []);
  const lines = SCRIPT.slice(0, Math.min(shown, SCRIPT.length)).slice(-14);
  const active = shown > 0 && shown <= SCRIPT.length ? SCRIPT[shown - 1]![1] : null;
  const ts = (i: number) => {
    const d = new Date(start.current + i * 900);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  };
  const node = (who: Who, side: string, icon: ReactElement, name: string, sub: string) => (
    <div className={`node ${side} ${active === who ? 'active' : ''}`}>
      {icon}
      <div>
        <b>{name}</b>
        <span>{sub}</span>
      </div>
    </div>
  );
  return (
    <div className="stage">
      <div className="stage-nodes">
        {node('agent', 'l t', <Icon.bot />, 'AI Agent', 'mandate · 200/wk')}
        {node('guardians', 'l b', <Icon.users />, 'Guardians', '2 of 3 · anonymous')}
        {node('heirs', 'r t', <Icon.hourglass />, 'Heirs', 'shares · sealed')}
        {node('device', 'r b', <Icon.phone />, 'New device', 'restore · X25519')}
      </div>
      <div className="panel">
        <div className="panel-head">
          <span className="lights">
            <i />
            <i />
            <i />
          </span>
          <span className="title-c">vault events</span>
          <span className="live">LIVE</span>
        </div>
        <div className="log">
          {lines.map(([lvl, , msg, ms], i) => {
            const n = Math.max(0, shown - lines.length) + i + 1;
            return (
              <div className="line" key={n}>
                <span className="n">{n}</span>
                <span className="t">{ts(n).slice(0, 12)}</span>
                <span className={`lvl-${lvl}`}>{lvl}</span>
                <span className="msg">{msg}</span>
                <span className="ms">{ms}</span>
              </div>
            );
          })}
          {shown <= SCRIPT.length && (
            <div className="line">
              <span className="n">{shown + 1}</span>
              <span />
              <span />
              <span>
                <span className="cursor" />
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
