/** Where the product lives. The site only links to it; it never talks to the API. */
export const APP_URL = ((import.meta.env.VITE_APP_URL as string | undefined) ?? 'http://localhost:5173').replace(/\/$/, '');
export const REPO_URL = 'https://github.com/tejasvasingh2004/Tejasva_BCI_Cognitive-state-aware-multi-agent-system';

export type RouteMeta = { title: string; description: string };

export const META: Record<string, RouteMeta> = {
  '/': {
    title: 'NeuroFlow — the AI workspace that plans, codes, and proves it works',
    description:
      'NeuroFlow is an AI workspace with a Code Agent that reads your repository, plans, shows every change as a diff, and runs your tests in an isolated sandbox before anything is committed.',
  },
  '/download': {
    title: 'Download — NeuroFlow',
    description: 'Use NeuroFlow in the browser today, self-host it with Docker, and get the desktop app when it ships.',
  },
  '/pricing': { title: 'Pricing — NeuroFlow', description: 'NeuroFlow plans and what each one includes: runs, concurrency and daily model tokens.' },
  '/docs': {
    title: 'Docs — NeuroFlow',
    description: 'Get started with NeuroFlow: hosted use, self-hosting, connecting GitHub, approval modes and the OpenAI-compatible API.',
  },
  '/changelog': { title: 'Changelog — NeuroFlow', description: 'What shipped in NeuroFlow, generated from the commit history.' },
  '/login': { title: 'Sign in — NeuroFlow', description: 'Sign in to NeuroFlow.' },
  '/404': { title: 'Not found — NeuroFlow', description: 'This page does not exist.' },
};

export const ROUTES = Object.keys(META).filter((r) => r !== '/404');
