import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import './index.css';
import { parseWebEnv } from './lib/env';
import { createSupabase } from './lib/supabase';
import { ConfigErrorPage } from './pages/config-error-page';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

const env = parseWebEnv(import.meta.env);

createRoot(root).render(
  <StrictMode>
    {env.ok ? (
      <App supabase={createSupabase(env.env)} />
    ) : (
      <ConfigErrorPage problems={env.problems} />
    )}
  </StrictMode>,
);
