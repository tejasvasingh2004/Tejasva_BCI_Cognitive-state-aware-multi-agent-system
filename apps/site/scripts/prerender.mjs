/* global console */
// Static pre-rendering: renders every route with the SSR bundle into dist/<route>/index.html so
// search engines and first paint get full HTML; the client bundle then hydrates it.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = readFileSync(resolve(root, 'dist/index.html'), 'utf8');
const { render, ROUTES } = await import(pathToFileURL(resolve(root, 'dist-server/entry-server.js')).href);

for (const route of [...ROUTES, '/404']) {
  const { html, head } = render(route);
  // data-route lets the client hydrate only when this HTML belongs to the current URL (some hosts
  // fall back to the home page for unknown paths).
  const page = template
    .replace('<!--app-head-->', head)
    .replace('<div id="root"><!--app-html--></div>', `<div id="root" data-route="${route}">${html}</div>`);
  const file = route === '/' ? 'dist/index.html' : route === '/404' ? 'dist/404.html' : `dist${route}/index.html`;
  mkdirSync(dirname(resolve(root, file)), { recursive: true });
  writeFileSync(resolve(root, file), page);
  // Hosts with "clean URLs" serve /pricing from pricing.html.
  if (route !== '/' && route !== '/404') writeFileSync(resolve(root, `dist${route}.html`), page);
  console.log(`prerendered ${route} → ${file}`);
}
rmSync(resolve(root, 'dist-server'), { recursive: true, force: true });
