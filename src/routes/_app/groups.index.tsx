import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Eye, Users } from 'lucide-react';
import { useId, useState, type SubmitEvent } from 'react';
import { EmptyState } from '@/components/empty-state';
import { ErrorState, InlineError } from '@/components/error-state';
import { WatchDialog } from '@/components/groups/watch-dialog';
import { WatchRow } from '@/components/groups/watch-row';
import { RelativeTime } from '@/components/listing-bits';
import { ListingImage } from '@/components/listing-image';
import { PageHeader } from '@/components/page-header';
import { RequireFacebook } from '@/components/require-facebook';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useResolveGroup } from '@/hooks/mutations';
import { groupWatchesQuery, joinedGroupsQuery, settled, webhooksQuery } from '@/lib/queries';
import type { GroupWatch } from '@/shared/domain';

export const Route = createFileRoute('/_app/groups/')({
  // Watches and webhooks are local; the groups list comes from Facebook (client only).
  loader: ({ context: { queryClient } }) =>
    settled(queryClient.query({ ...groupWatchesQuery, staleTime: 'static' }), queryClient.query({ ...webhooksQuery, staleTime: 'static' })),
  head: () => ({ meta: [{ title: 'Groups · faceslop' }] }),
  component: GroupsPage,
});

function GroupsPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-12 px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader title="Groups">
        Your Facebook groups without the feed around them: newest posts first, an explicit “Load more”, and watches that
        quietly check a group and send the posts you care about to your webhooks.
      </PageHeader>
      <RequireFacebook reason="Groups are read as your Facebook account, so private groups you’re in work too.">
        <WatchesSection />
        <YourGroupsSection />
      </RequireFacebook>
    </div>
  );
}

function WatchesSection() {
  const watches = useQuery(groupWatchesQuery);
  const { data: webhooks } = useQuery(webhooksQuery);
  const noWebhooks = webhooks !== undefined && !webhooks.some((w) => w.enabled);

  return (
    <section aria-labelledby="watches-heading" className="flex flex-col gap-3">
      <h2 id="watches-heading" className="text-base font-semibold tracking-tight">
        Watched groups
      </h2>
      {watches.data !== undefined && watches.data.length > 0 && noWebhooks && (
        <p className="text-sm text-muted-foreground">
          Matches are kept here, but nothing is sent anywhere yet.{' '}
          <Link to="/settings" hash="webhooks" className="font-medium text-primary hover:underline">
            Add a webhook
          </Link>{' '}
          to get them on your phone or in your own tools.
        </p>
      )}
      {watches.isPending ? (
        <Skeleton className="h-28 w-full" />
      ) : watches.isError ? (
        <ErrorState
          error={watches.error}
          onRetry={() => {
            void watches.refetch();
          }}
          retrying={watches.isFetching}
        />
      ) : watches.data.length === 0 ? (
        <EmptyState icon={Eye} title="No watched groups yet">
          Choose “Watch” on one of your groups below. faceslop checks it in the background and tells your webhooks about
          new posts that match your keywords.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {watches.data.map((w) => (
            <WatchRow key={w.id} watch={w} />
          ))}
        </ul>
      )}
    </section>
  );
}

function YourGroupsSection() {
  const groups = useQuery(joinedGroupsQuery);
  const { data: watches = [] } = useQuery(groupWatchesQuery);

  return (
    <section aria-labelledby="your-groups-heading" className="flex flex-col gap-3">
      <h2 id="your-groups-heading" className="text-base font-semibold tracking-tight">
        Your groups
      </h2>
      {groups.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : groups.isError ? (
        <ErrorState
          error={groups.error}
          onRetry={() => {
            void groups.refetch();
          }}
          retrying={groups.isFetching}
        />
      ) : groups.data.length === 0 ? (
        <EmptyState icon={Users} title="No groups found">
          Facebook didn’t list any groups for your account. You can still open one by its link below.
        </EmptyState>
      ) : (
        <ItemGroup>
          {groups.data.map((g) => (
            <GroupItem key={g.id} group={g} watches={watches} imageUrl={g.imageUrl} lastPostAt={g.lastPostAt} />
          ))}
        </ItemGroup>
      )}
      <AddByLink watches={watches} />
    </section>
  );
}

interface GroupItemProps {
  readonly group: { readonly id: string; readonly name: string };
  readonly watches: readonly GroupWatch[];
  readonly imageUrl?: string | null;
  readonly lastPostAt?: number | null;
}

function GroupItem({ group, watches, imageUrl = null, lastPostAt = null }: GroupItemProps) {
  const watched = watches.some((w) => w.groupId === group.id);
  return (
    <Item variant="outline" size="sm">
      <ItemMedia variant="image">
        <ListingImage src={imageUrl} alt="" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{group.name}</ItemTitle>
        {lastPostAt !== null && (
          <ItemDescription>
            Last post <RelativeTime ms={lastPostAt} />
          </ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        <Link to="/groups/$groupId" params={{ groupId: group.id }} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          Open
        </Link>
        {watched ? (
          <span className="px-2 text-sm text-muted-foreground">Watching</span>
        ) : (
          <WatchDialog group={group}>Watch</WatchDialog>
        )}
      </ItemActions>
    </Item>
  );
}

/** A group that isn't in the list (Facebook lists only some): paste its link. */
function AddByLink({ watches }: { readonly watches: readonly GroupWatch[] }) {
  const id = useId();
  const [ref, setRef] = useState('');
  const resolve = useResolveGroup();

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (ref.trim() !== '') resolve.mutate(ref.trim());
  };

  return (
    <div className="mt-3 flex flex-col gap-3">
      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor={`${id}-ref`}>Open a group by its link</Label>
          <Input
            id={`${id}-ref`}
            value={ref}
            onChange={(e) => {
              setRef(e.target.value);
            }}
            placeholder="https://www.facebook.com/groups/…"
            inputMode="url"
            autoComplete="off"
          />
        </div>
        <Button type="submit" variant="outline" isPending={resolve.isPending} isDisabled={ref.trim() === ''}>
          Find group
        </Button>
      </form>
      <InlineError error={resolve.error} />
      {resolve.data !== undefined && (
        <GroupItem group={{ id: resolve.data.id, name: resolve.data.name ?? 'This group' }} watches={watches} />
      )}
    </div>
  );
}
