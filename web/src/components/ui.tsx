import { useEffect, useState, type ReactNode } from 'react';

export const REPO = 'https://github.com/SCARPxVeNOM/keeproxy';

// ------------------------------------------------------------------ icons
const I = (d: ReactNode) =>
  function Icon(props: { className?: string }) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" {...props}>
        {d}
      </svg>
    );
  };
export const Icon = {
  arrow: I(<path d="M5 12h14M13 6l6 6-6 6" />),
  github: function Github(props: { className?: string }) {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
        <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
      </svg>
    );
  },
  copy: I(<><rect x="8" y="8" width="12" height="12" /><path d="M16 8V4H4v12h4" /></>),
  bot: I(<><rect x="4" y="8" width="16" height="11" /><path d="M12 4v4M9 13h.01M15 13h.01M9 16h6" /></>),
  shield: I(<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z" />),
  users: I(<><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 11a3 3 0 1 0 0-6M21 20c0-2.6-1.6-4.8-4-5.6" /></>),
  phone: I(<><rect x="7" y="3" width="10" height="18" /><path d="M11 18h2" /></>),
  hourglass: I(<path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9" />),
  lock: I(<><rect x="5" y="11" width="14" height="10" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>),
  key: I(<><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M14 9l2 2" /></>),
  eye: I(<><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>),
  eyeOff: I(<><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6" /></>),
  zap: I(<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />),
  ban: I(<><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></>),
  clock: I(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  layers: I(<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" />),
  file: I(<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>),
  check: I(<path d="m5 12 4 4 10-10" />),
  terminal: I(<><rect x="3" y="4" width="18" height="16" /><path d="m7 9 3 3-3 3M12 15h5" /></>),
  database: I(<><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>),
  laptop: I(<><rect x="5" y="5" width="14" height="10" /><path d="M2 19h20" /></>),
};

// ------------------------------------------------------------------ panel
export function Panel(props: {
  title?: ReactNode;
  center?: boolean;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <div className={`panel ${props.className ?? ''}`}>
      <div className="panel-head">
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
        {props.center ? <span className="title-c">{props.title}</span> : <span style={{ flex: 1 }}>{props.title}</span>}
        {props.right}
      </div>
      <div className={props.bodyClass ?? 'panel-body'}>{props.children}</div>
    </div>
  );
}

// ------------------------------------------------------- tiny highlighter
const KW = new Set(
  'export circuit pure witness ledger sealed assert const if else return import from async await function for of new struct enum constructor disclose let type'.split(' '),
);
const TOKEN = /(\/\/[^\n]*)|('[^']*'|"[^"]*"|`[^`]*`)|(\b\d[\d_]*n?\b)|([A-Za-z_$][\w$]*)(\s*\()?|(\s+|[^\sA-Za-z_$\d'"`/]+|\/)/g;

export function Code({ src }: { src: string }) {
  const out: ReactNode[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(src))) {
    const [all, com, str, num, word, call] = m;
    const k = i++;
    if (com) out.push(<span key={k} className="c">{com}</span>);
    else if (str) out.push(<span key={k} className="s">{str}</span>);
    else if (num) out.push(<span key={k} className="num">{num}</span>);
    else if (word) {
      const cls = KW.has(word) ? 'k' : call ? 'f' : /^[A-Z]/.test(word) ? 'ty' : /^(m|now|amount|to|path|leaf|key|vault)$/.test(word) ? 'p' : '';
      out.push(
        <span key={k} className={cls}>
          {word}
        </span>,
      );
      if (call) out.push(call);
    } else out.push(all);
  }
  return <div className="code">{out}</div>;
}

// ----------------------------------------------------------------- header
const SECTIONS: [string, string][] = [
  ['#/delegate', 'Delegate'],
  ['#/recover', 'Recover'],
  ['#/restore', 'Restore'],
  ['#/inherit', 'Inherit'],
  ['#/privacy', 'Privacy'],
  ['#/agents', 'Agents'],
];

export function Header({ page }: { page: 'home' | 'console' | 'app' }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener('hashchange', close);
    return () => window.removeEventListener('hashchange', close);
  }, []);
  return (
    <>
      <header className={`header ${open ? 'open' : ''}`}>
        <div className="container-wide header-inner">
          <a href="#/" className="logo" aria-label="keeproxy home">
            keeproxy<span className="dot">.</span>
          </a>
          <nav className="nav" aria-label="Sections">
            {SECTIONS.map(([href, name]) => (
              <a key={href} href={href}>
                {name}
              </a>
            ))}
          </nav>
          <div className="header-actions">
            <a className={`btn btn-ghost hide-sm ${page === 'console' ? 'is-current' : ''}`} href="#/console">
              <span className="live-dot" /> Live vault
            </a>
            {page !== 'app' ? (
              <a className="btn btn-primary" href="#/app">
                Create a vault <Icon.arrow />
              </a>
            ) : (
              <a className="btn btn-outline" href="#/">
                Overview
              </a>
            )}
            <a className="icon-btn hide-sm" href={REPO} target="_blank" rel="noreferrer" aria-label="GitHub">
              <Icon.github className="" />
            </a>
            <button className="menu-btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <i />
              <i />
            </button>
          </div>
        </div>
        {open && (
          <div className="mobile-menu">
            <a href="#/app">Create a vault</a>
            <a href="#/console">Live vault</a>
            {SECTIONS.map(([href, name]) => (
              <a key={href} href={href}>
                {name}
              </a>
            ))}
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub ↗
            </a>
          </div>
        )}
      </header>
      <div className="netbar">
        <span className="netbar-dot" /> Running on Midnight <b>preprod</b>, a test network: tokens have no value.{' '}
        <a href="https://faucet.preprod.midnight.network/" target="_blank" rel="noreferrer">
          Get test tokens ↗
        </a>
      </div>
    </>
  );
}

// ----------------------------------------------------------------- footer
export function useClock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return t;
}
const hms = (d: Date) => d.toTimeString().slice(0, 8);

export function Footer() {
  const t = useClock();
  return (
    <footer className="footer">
      <div className="container">
        <div className="row">
          <span className="dim">{hms(t)}</span>
          <span style={{ color: 'var(--primary)' }}>INFO</span>
          <span>
            <b style={{ color: '#fff', fontWeight: 500 }}>GET /footer 200</b> <span className="dim">in 0.4ms</span>
          </span>
        </div>
        <div className="tree">
          <span>powers</span>
          <div>
            <a href="#/delegate">Delegate</a>
            <a href="#/recover">Recover</a>
            <a href="#/restore">Restore</a>
            <a href="#/inherit">Inherit</a>
            <a href="#/privacy">Disclose</a>
          </div>
          <span>use</span>
          <div>
            <a href="#/app">Create a vault</a>
            <a href="#/console">Live vault</a>
            <a href={`${REPO}#live-on-preprod`} target="_blank" rel="noreferrer">On-chain proofs↗</a>
          </div>
          <span>build</span>
          <div>
            <a href={`${REPO}/blob/main/contract/proxy.compact`} target="_blank" rel="noreferrer">proxy.compact↗</a>
            <a href={`${REPO}/blob/main/docs/SPEC.md`} target="_blank" rel="noreferrer">SPEC.md↗</a>
            <a href={`${REPO}/tree/main/src/test`} target="_blank" rel="noreferrer">tests↗</a>
          </div>
          <span>midnight</span>
          <div>
            <a href="https://docs.midnight.network/" target="_blank" rel="noreferrer">Docs↗</a>
            <a href="https://github.com/midnightntwrk" target="_blank" rel="noreferrer">midnightntwrk↗</a>
            <a href="https://github.com/midnightntwrk/midnight-examples" target="_blank" rel="noreferrer">midnight-examples↗</a>
          </div>
        </div>
        <div className="row">
          <span className="dim">{hms(t)}</span>
          <span className="dim">DEBUG</span>
          <span className="dim">
            © 2026 keeproxy · Apache-2.0 · built on Midnight <span className="cursor" />
          </span>
        </div>
      </div>
    </footer>
  );
}
