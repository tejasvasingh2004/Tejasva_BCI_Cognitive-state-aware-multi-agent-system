import { useCallback, useEffect, useState } from 'react';

/** Minimal path routing: `/` (new conversation) and `/c/:conversationId`. */
export function useConversationRoute(): [string | null, (id: string | null) => void] {
  const parse = () => /^\/c\/([0-9a-f-]{36})/.exec(window.location.pathname)?.[1] ?? null;
  const [id, setId] = useState<string | null>(parse);

  useEffect(() => {
    const onPop = () => setId(parse());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: string | null) => {
    const path = next ? `/c/${next}` : '/';
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setId(next);
  }, []);

  return [id, navigate];
}
