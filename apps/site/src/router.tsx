import { createContext, useContext, useEffect, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

/** '/pricing/' and '/pricing' are the same page (static hosts often add the slash). */
export const normalizePath = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p);

const RouterContext = createContext<{ path: string; navigate(to: string): void }>({ path: '/', navigate: () => {} });

export function Router({ initialPath, children }: { initialPath: string; children: ReactNode }) {
  const [path, setPath] = useState(normalizePath(initialPath));
  useEffect(() => {
    const onPop = () => setPath(normalizePath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = (to: string) => {
    const [pathname, hash] = to.split('#');
    if (pathname && pathname !== window.location.pathname) {
      window.history.pushState(null, '', to);
      setPath(normalizePath(pathname));
      if (!hash) window.scrollTo({ top: 0 });
    }
    if (hash) requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth' }));
  };
  return <RouterContext.Provider value={{ path, navigate }}>{children}</RouterContext.Provider>;
}

export const useRoute = () => useContext(RouterContext);

/** Internal link: a real <a href> (works before hydration and for crawlers), client navigation after. */
export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const { navigate } = useRoute();
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}
