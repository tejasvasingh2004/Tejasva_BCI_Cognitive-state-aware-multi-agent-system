import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * Minimal path routing (no router dependency):
 *   /                          new conversation        /c/:conversationId   conversation
 *   /code                      code home               /code/:id            code workspace
 *   /code/:id/replay/:runId    code run replay         /lab[/:section]      Model Lab
 */
export type CodeView = 'workspace' | 'tasks' | 'settings';

export type AppRoute =
  | { app: 'chat'; conversationId: string | null }
  | { app: 'code'; workspaceId: string | null; replayRunId: string | null; view: CodeView }
  | { app: 'lab'; section: string | null };

const UUID = '[0-9a-f-]{36}';

export function parseRoute(pathname: string): AppRoute {
  let m = new RegExp(`^/code/(${UUID})/replay/(${UUID})`).exec(pathname);
  if (m) return { app: 'code', workspaceId: m[1]!, replayRunId: m[2]!, view: 'workspace' };
  m = new RegExp(`^/code/(${UUID})/(tasks|settings)\\b`).exec(pathname);
  if (m) return { app: 'code', workspaceId: m[1]!, replayRunId: null, view: m[2] as CodeView };
  m = new RegExp(`^/code/(${UUID})`).exec(pathname);
  if (m) return { app: 'code', workspaceId: m[1]!, replayRunId: null, view: 'workspace' };
  if (/^\/code\/?$/.test(pathname)) return { app: 'code', workspaceId: null, replayRunId: null, view: 'workspace' };
  m = /^\/lab(?:\/([a-z-]+))?/.exec(pathname);
  if (m) return { app: 'lab', section: m[1] ?? null };
  m = new RegExp(`^/c/(${UUID})`).exec(pathname);
  return { app: 'chat', conversationId: m?.[1] ?? null };
}

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  const onPop = () => l();
  window.addEventListener('popstate', onPop);
  return () => {
    listeners.delete(l);
    window.removeEventListener('popstate', onPop);
  };
};
const getPath = () => window.location.pathname + window.location.search;

/** Navigates within the app (pushState) and notifies every route subscriber. */
export function navigateTo(path: string, opts: { replace?: boolean } = {}) {
  if (getPath() === path) return;
  if (opts.replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  for (const l of listeners) l();
}

export function useAppRoute(): AppRoute {
  const path = useSyncExternalStore(subscribe, getPath);
  return parseRoute(path.split('?')[0]!);
}

export function useSearchParam(name: string): string | null {
  const path = useSyncExternalStore(subscribe, getPath);
  return new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?')) : '').get(name);
}

/** Conversation route used by the chat workspace: `/` (new) and `/c/:conversationId`. */
export function useConversationRoute(): [string | null, (id: string | null) => void] {
  const route = useAppRoute();
  const id = route.app === 'chat' ? route.conversationId : null;
  const navigate = useCallback((next: string | null) => navigateTo(next ? `/c/${next}` : '/'), []);
  return [id, navigate];
}

/** Sets the document title while mounted. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
