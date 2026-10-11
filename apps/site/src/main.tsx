import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { normalizePath } from './router';

const root = document.getElementById('root')!;
const app = (
  <StrictMode>
    <App path={window.location.pathname} />
  </StrictMode>
);
// Pre-rendered HTML for this URL is hydrated; anything else (dev server, a host's fallback page)
// is rendered from scratch.
const prerendered = root.dataset.route;
if (root.firstElementChild && prerendered && normalizePath(prerendered) === normalizePath(window.location.pathname)) hydrateRoot(root, app);
else createRoot(root).render(app);
