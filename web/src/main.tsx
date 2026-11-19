import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Landing } from './pages/Landing';
import { Console } from './pages/Console';

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
    if (r && r !== 'console') document.getElementById(r)?.scrollIntoView({ behavior: 'smooth' });
    else window.scrollTo({ top: 0 });
  }, [r]);
  return r === 'console' ? <Console /> : <Landing />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
