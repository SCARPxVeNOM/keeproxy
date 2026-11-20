import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Landing } from './pages/Landing';
import { Console } from './pages/Console';

// The wallet app carries the Midnight runtime (WASM); only #/app loads it.
const Wallet = lazy(() => import('./pages/Wallet').then((m) => ({ default: m.Wallet })));

const route = () => window.location.hash.replace(/^#\/?/, '');

function App() {
  const [r, setR] = useState(route());
  useEffect(() => {
    const on = () => setR(route());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    // #/delegate etc. are sections of the landing page.
    if (r && r !== 'console' && r !== 'app') document.getElementById(r)?.scrollIntoView({ behavior: 'smooth' });
    else window.scrollTo({ top: 0 });
  }, [r]);
  if (r === 'app')
    return (
      <Suspense fallback={<div className="boot mono">loading the Midnight runtime…</div>}>
        <Wallet />
      </Suspense>
    );
  return r === 'console' ? <Console /> : <Landing />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
