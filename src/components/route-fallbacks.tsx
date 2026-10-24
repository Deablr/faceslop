// Router-level fallbacks: an unexpected route error, and unknown URLs.
import { Link, type ErrorComponentProps } from '@tanstack/react-router';
import { ErrorState } from '@/components/error-state';
import { LogoMark } from '@/components/logo';
import { buttonVariants } from '@/components/ui/button';

export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <div className="mx-auto max-w-xl px-4 py-12 sm:px-6">
      <ErrorState error={error} onRetry={reset} />
    </div>
  );
}

export function NotFound() {
  return (
    <div className="flex flex-col items-center px-6 py-24 text-center">
      <LogoMark className="size-10" />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">Nothing here</h1>
      <p className="mt-2 text-muted-foreground">That page doesn’t exist.</p>
      <Link to="/" className={buttonVariants({ variant: 'outline', className: 'mt-8' })}>
        Back to faceslop
      </Link>
    </div>
  );
}
