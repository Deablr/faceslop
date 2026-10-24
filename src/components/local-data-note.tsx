import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { accountOf } from '@/lib/account-change';
import { authStatusQuery } from '@/lib/queries';

/**
 * One quiet line for a page of personal lists while this browser isn't logged in to Facebook:
 * until then they belong to this browser alone, and logging in moves them to the account. Shown
 * once per page (not per list), and nothing once logged in.
 */
export function LocalDataNote({ what }: { readonly what: string }) {
  const { data } = useQuery(authStatusQuery);
  if (data === undefined || accountOf(data) !== null) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {what} are kept in this browser only.{' '}
      <Link to="/login" className="rounded-sm text-primary hover:underline">
        Connect Facebook
      </Link>{' '}
      to keep them with your account on every device.
    </p>
  );
}
