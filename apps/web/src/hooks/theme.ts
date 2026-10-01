import { useEffect } from 'react';
import { useUi } from '@/stores/ui';

/** Applies the light / dark / system theme preference to <html> and follows OS changes. */
export function useApplyTheme() {
  const theme = useUi((s) => s.theme);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0f0d1a' : '#f6f3fc');
    };
    apply();
    if (theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}
