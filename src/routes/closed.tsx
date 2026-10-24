import { Link, createFileRoute } from '@tanstack/react-router';
import { LogoMark } from '@/components/logo';

/** Where "I'm done for now" lands: deliberately outside the app shell, nothing to click but the way back. */
export const Route = createFileRoute('/closed')({
  head: () => ({ meta: [{ title: 'Closed for now · faceslop' }] }),
  component: ClosedPage,
});

function ClosedPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <LogoMark className="size-10 opacity-80" />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">Closed for now</h1>
      <p className="mt-2 max-w-sm text-muted-foreground">
        Nice. Whatever you were looking for will still be there later. You can close this tab.
      </p>
      <Link to="/" className="mt-8 rounded-sm text-sm text-primary hover:underline">
        Back to faceslop
      </Link>
    </main>
  );
}
