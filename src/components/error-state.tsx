import { Link } from '@tanstack/react-router';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { errorTitle, suggestsReconnect } from '@/lib/error-copy';
import { toClientError } from '@/shared/errors';

interface ErrorStateProps {
  readonly error: unknown;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
  /** Overrides the title derived from the error code. */
  readonly title?: string;
}

/** The server's message plus the most useful next step for its code. */
export function ErrorState({ error, onRetry, retrying = false, title }: ErrorStateProps) {
  const { code, message } = toClientError(error);
  const reconnect = suggestsReconnect(code);
  return (
    <Alert>
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{title ?? errorTitle(code)}</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {code === 'FB_BLOCKED' && <p>Facebook may want you to sign in again. Reconnecting usually fixes it.</p>}
        {(reconnect || onRetry !== undefined) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {reconnect && (
              <Link to="/login" className={buttonVariants({ size: 'sm' })}>
                {code === 'FB_BLOCKED' ? 'Reconnect Facebook' : 'Connect Facebook'}
              </Link>
            )}
            {onRetry !== undefined && (
              <Button size="sm" variant="outline" isPending={retrying} onPress={onRetry}>
                <RefreshCw aria-hidden="true" />
                Try again
              </Button>
            )}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** One line for small spots (forms, menus). Renders nothing without an error. */
export function InlineError({ error }: { readonly error: unknown }) {
  if (error === null || error === undefined) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {toClientError(error).message}
    </p>
  );
}
