import { renderToString } from 'react-dom/server';
import { App } from './App';
import { META, ROUTES } from './site';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export { ROUTES };

/** Renders one route to HTML plus its <head> tags (used by scripts/prerender.mjs). */
export function render(path: string): { html: string; head: string } {
  const meta = META[path] ?? META['/404']!;
  const head = [
    `<title>${escape(meta.title)}</title>`,
    `<meta name="description" content="${escape(meta.description)}" />`,
    `<meta property="og:title" content="${escape(meta.title)}" />`,
    `<meta property="og:description" content="${escape(meta.description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:image" content="/screens/review.png" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ].join('\n    ');
  return { html: renderToString(<App path={path} />), head };
}
