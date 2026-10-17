import { useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError } from '@/lib/api';
import { keys } from '@/hooks/queries';
import { Button } from '@/components/ui/button';
import { Sparkle } from '@/components/ui/sparkle';

/** Email + password sign-in, shown when the API runs with AUTH_MODE=production. */
export function LoginScreen() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(email.trim(), password);
      setPassword('');
      await qc.invalidateQueries({ queryKey: keys.me });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach NeuroFlow.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <motion.form
        onSubmit={(e) => void submit(e)}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass flex w-full max-w-sm flex-col rounded-[28px] px-8 py-9"
        data-testid="login-form"
      >
        <Sparkle className="mx-auto size-9" />
        <h1 className="mt-4 text-center text-xl font-semibold text-ink">Sign in to NeuroFlow</h1>
        <p className="mt-1 text-center text-sm text-muted">Use the account your administrator created for you.</p>
        <label className="mt-7 text-xs font-medium text-muted" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1.5 h-11 rounded-full border border-line bg-surface/80 px-4 text-sm text-ink outline-none focus:border-accent/50"
        />
        <label className="mt-4 text-xs font-medium text-muted" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1.5 h-11 rounded-full border border-line bg-surface/80 px-4 text-sm text-ink outline-none focus:border-accent/50"
        />
        {error && (
          <p role="alert" className="mt-4 rounded-2xl bg-rose-soft px-4 py-2 text-center text-xs text-rose-600 dark:text-rose-300">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" className="mt-6" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </motion.form>
    </div>
  );
}
