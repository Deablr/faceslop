import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plug } from 'lucide-react';
import type { ReactNode } from 'react';
import { ErrorState } from '@/components/error-state';
import { buttonVariants } from '@/components/ui/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { authStatusQuery } from '@/lib/queries';

/** Renders children only with a Facebook session; otherwise a calm prompt to connect. */
export function RequireFacebook({ children, reason }: { readonly children: ReactNode; readonly reason: string }) {
  const auth = useQuery(authStatusQuery);
  if (auth.isPending) return <Skeleton className="h-24 w-full" />;
  if (auth.isError) {
    return (
      <ErrorState
        error={auth.error}
        onRetry={() => {
          void auth.refetch();
        }}
        retrying={auth.isFetching}
      />
    );
  }
  if (auth.data.state !== 'logged_in') return <ConnectPrompt reason={reason} />;
  return children;
}

/** `stacked` puts the button on its own line (narrow columns). */
export function ConnectPrompt({ reason, stacked = false }: { readonly reason: string; readonly stacked?: boolean }) {
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <Plug aria-hidden="true" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Connect Facebook first</ItemTitle>
        <ItemDescription>{reason}</ItemDescription>
      </ItemContent>
      <ItemActions className={stacked ? 'basis-full' : undefined}>
        <Link to="/login" className={buttonVariants({ size: 'sm' })}>
          Connect Facebook
        </Link>
      </ItemActions>
    </Item>
  );
}
