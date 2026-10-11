import { ButtonLink } from '../components/ui';

export function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-5 pt-24 text-center">
      <p className="font-mono text-sm text-accent-soft">404</p>
      <h1 className="mt-3 text-3xl font-bold">This page doesn’t exist.</h1>
      <ButtonLink to="/" variant="outline" className="mt-8">
        Back home
      </ButtonLink>
    </div>
  );
}
