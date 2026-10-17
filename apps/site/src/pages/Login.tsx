import { useEffect } from 'react';
import { ArrowRight } from 'lucide-react';
import { ButtonLink, Logo } from '../components/ui';
import { APP_URL } from '../site';

/** Sign-in lives in the app; this route forwards there (and works without JavaScript via the link). */
export function Login() {
  useEffect(() => {
    const t = setTimeout(() => window.location.assign(`${APP_URL}/`), 600);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-5 pt-24">
      <div className="w-full max-w-sm glass rounded-[28px] p-8 text-center">
        <Logo className="mx-auto size-10" />
        <h1 className="mt-5 text-xl font-bold">Taking you to NeuroFlow…</h1>
        <p className="mt-2 text-sm text-muted">Sign in happens in the app.</p>
        <ButtonLink href={`${APP_URL}/`} className="mt-6 w-full">
          Continue to sign in <ArrowRight className="size-4" />
        </ButtonLink>
      </div>
    </div>
  );
}
