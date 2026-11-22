import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Newspaper, RefreshCw, Sparkles } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { GroupPostCard } from '@/components/groups/group-post-card';
import { describeInterval, describeWatch, WatchDialog } from '@/components/groups/watch-dialog';
import { RequireFacebook } from '@/components/require-facebook';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { groupFeedQuery, groupWatchMatchesQuery, groupWatchesQuery, joinedGroupsQuery, queryKeys, settled } from '@/lib/queries';
import type { GroupFeedPage, GroupWatch } from '@/shared/domain';
import { appErrorOf } from '@/shared/errors';

type GroupTab = 'posts' | 'matches';

export interface GroupPageSearch {
  readonly tab?: GroupTab;
}

export function validateGroupSearch(raw: Readonly<Record<string, unknown>>): GroupPageSearch {
  return raw.tab === 'matches' ? { tab: 'matches' } : {};
}

export const Route = createFileRoute('/_app/groups/$groupId/')({
  validateSearch: validateGroupSearch,
  loader: ({ context: { queryClient } }) => settled(queryClient.query({ ...groupWatchesQuery, staleTime: 'static' })),
  head: () => ({ meta: [{ title: 'Group · faceslop' }] }),
  component: GroupPage,
});

function GroupPage() {
  const { groupId } = Route.useParams();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <Link to="/groups" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Groups
      </Link>
      <RequireFacebook reason="Groups are read as your Facebook account.">
        <GroupView key={groupId} groupId={groupId} />
      </RequireFacebook>
    </div>
  );
}

function GroupView({ groupId }: { readonly groupId: string }) {
  const { tab = 'posts' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const feed = useInfiniteQuery(groupFeedQuery(groupId));
  const { data: watches } = useQuery(groupWatchesQuery);
  const { data: joined } = useQuery({ ...joinedGroupsQuery, enabled: false });
  const watch = watches?.find((w) => w.groupId === groupId);
  const name = feed.data?.pages[0]?.group.name ?? watch?.groupName ?? joined?.find((g) => g.id === groupId)?.name ?? 'Group';

  const onTab = (next: GroupTab) => {
    void navigate({ search: next === 'matches' ? { tab: 'matches' } : {}, replace: true });
  };

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {watch === undefined
              ? 'Not watched. Watch it to hear about new posts that match your keywords.'
              : `${watch.enabled ? 'Watching' : 'Watch paused'}: ${describeWatch(watch)}, ${describeInterval(watch.intervalMinutes)}.`}
          </p>
        </div>
        <WatchDialog group={{ id: groupId, name }} watch={watch} variant={watch === undefined ? 'default' : 'outline'}>
          {watch === undefined ? 'Watch this group' : 'Edit watch'}
        </WatchDialog>
      </header>
      <Tabs
        selectedKey={tab}
        onSelectionChange={(key) => {
          onTab(key === 'matches' ? 'matches' : 'posts');
        }}
      >
        <TabsList aria-label="Group">
          <TabsTrigger id="posts">Newest posts</TabsTrigger>
          <TabsTrigger id="matches">
            Matches{watch !== undefined && watch.newMatchCount > 0 ? ` (${String(watch.newMatchCount)} new)` : ''}
          </TabsTrigger>
        </TabsList>
        <TabsContent id="posts" className="mt-4">
          <PostsTab groupId={groupId} feed={feed} />
        </TabsContent>
        <TabsContent id="matches" className="mt-4">
          <MatchesTab watch={watch} />
        </TabsContent>
      </Tabs>
    </>
  );
}

type GroupFeed = UseInfiniteQueryResult<InfiniteData<GroupFeedPage>>;

function PostsTab({ groupId, feed }: { readonly groupId: string; readonly feed: GroupFeed }) {
  const queryClient = useQueryClient();
  const posts = feed.data?.pages.flatMap((p) => p.posts) ?? [];

  if (feed.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading posts">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (feed.isError && posts.length === 0) {
    return (
      <ErrorState
        error={feed.error}
        onRetry={() => {
          void feed.refetch();
        }}
        retrying={feed.isFetching}
      />
    );
  }
  if (posts.length === 0) {
    return (
      <EmptyState icon={Newspaper} title="No posts">
        Facebook didn’t show any posts in this group.
      </EmptyState>
    );
  }

  const refresh = () => {
    void queryClient.resetQueries({ queryKey: queryKeys.groupFeed(groupId) });
  };
  const expired = feed.isFetchNextPageError && appErrorOf(feed.error)?.code === 'SESSION_EXPIRED';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onPress={refresh}>
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
      </div>
      <ul className="flex flex-col gap-4">
        {posts.map((post) => (
          <li key={post.id}>
            <GroupPostCard post={post} />
          </li>
        ))}
      </ul>
      {expired ? (
        <div className="mt-6 flex flex-col items-center gap-3 text-center">
          <p className="text-sm text-muted-foreground">This page has expired, so there’s nothing more to fetch from it.</p>
          <Button onPress={refresh}>
            <RefreshCw aria-hidden="true" />
            Start from the newest
          </Button>
        </div>
      ) : feed.isFetchNextPageError ? (
        <ErrorState
          error={feed.error}
          onRetry={() => {
            void feed.fetchNextPage();
          }}
          retrying={feed.isFetchingNextPage}
        />
      ) : feed.hasNextPage ? (
        <div className="mt-6 flex justify-center">
          <Button
            size="lg"
            variant="outline"
            isPending={feed.isFetchingNextPage}
            onPress={() => {
              void feed.fetchNextPage();
            }}
          >
            {feed.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : (
        <p className="mt-6 text-center text-sm text-muted-foreground">That’s as far back as Facebook goes here.</p>
      )}
    </div>
  );
}

function MatchesTab({ watch }: { readonly watch: GroupWatch | undefined }) {
  if (watch === undefined) {
    return (
      <EmptyState icon={Sparkles} title="Not watching this group">
        Watch it to collect new posts that match your keywords here (and send them to your webhooks).
      </EmptyState>
    );
  }
  return <MatchesList watch={watch} />;
}

function MatchesList({ watch }: { readonly watch: GroupWatch }) {
  const queryClient = useQueryClient();
  // Showing the matches marks them seen (see groupWatchMatchesQuery).
  const matches = useQuery(groupWatchMatchesQuery(watch.id, queryClient));
  if (matches.isPending) return <Skeleton className="h-48 w-full" />;
  if (matches.isError) {
    return (
      <ErrorState
        error={matches.error}
        onRetry={() => {
          void matches.refetch();
        }}
        retrying={matches.isFetching}
      />
    );
  }
  if (matches.data.length === 0) {
    return (
      <EmptyState icon={Sparkles} title="No matches yet">
        {watch.seeded
          ? 'New posts that match will show up here once a check finds them.'
          : 'faceslop is recording what’s already posted; new posts after that count.'}
      </EmptyState>
    );
  }
  return (
    <ul className="flex flex-col gap-4">
      {matches.data.map((m) => (
        <li key={m.post.id}>
          <GroupPostCard post={m.post} matched={m.matchedKeywords} />
        </li>
      ))}
    </ul>
  );
}
