// Query options: every server read goes through these, so caching rules live in one place (keys:
// src/lib/query-keys.ts; what changes when this browser logs in to or out of Facebook:
// src/lib/account-change.ts). Local data (settings, saved searches, favorites, auth, categories)
// is cheap and SSR'd by route loaders; Facebook-backed data (search, listing, locations,
// saved-search runs) is fetched on the client only and never refetched behind the user's back.
import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { reactToAuthStatus } from '@/lib/account-change';
import { queryKeys } from '@/lib/query-keys';
import { getAppAuthStatus } from '@/server/functions/app-auth';
import { getAuthStatus } from '@/server/functions/auth';
import { listBlockedSellers } from '@/server/functions/blocked-sellers';
import { getCategories, getListing, getLocations, loadMore, search } from '@/server/functions/browse';
import { listFavorites } from '@/server/functions/favorites';
import {
  getGroupPost,
  groupFeed,
  listGroupWatchMatches,
  listGroupWatches,
  listJoinedGroups,
  loadMoreGroupPosts,
  viewGroupWatchMatches,
} from '@/server/functions/groups';
import { listHidden } from '@/server/functions/hidden';
import { getRemoteViewState } from '@/server/functions/remote-view';
import { listSavedSearches, runSavedSearch } from '@/server/functions/saved-searches';
import { getSettings } from '@/server/functions/settings';
import { listWebhookDeliveries, listWebhooks } from '@/server/functions/webhooks';
import type {
  AppAuthStatus,
  AuthStatus,
  Favorite,
  GroupFeedPage,
  GroupPost,
  GroupWatch,
  GroupWatchMatch,
  ListingSummary,
  SavedSearch,
  SavedSearchRunResult,
  SearchParams,
  SearchResult,
} from '@/shared/domain';
import type { RemoteViewState } from '@/shared/remote-view';

export { queryKeys } from '@/lib/query-keys';

export const LOCKED_APP_AUTH: AppAuthStatus = { required: true, authenticated: false };

export const appAuthQuery = queryOptions({
  queryKey: queryKeys.appAuth,
  queryFn: () => getAppAuthStatus(),
  staleTime: Infinity,
});

export const authStatusQuery = queryOptions({
  queryKey: queryKeys.auth,
  queryFn: async ({ client, signal }): Promise<AuthStatus> => {
    const status = await getAuthStatus({ data: {}, signal });
    // It may have changed under us: a remote-view login finished (this browser's data is now the
    // account's), it was logged out in another tab, or the session expired. Not when this fetch
    // was cancelled: a login or logout stored a newer status meanwhile (storeAuthStatus).
    if (!signal.aborted) reactToAuthStatus(client, status);
    return status;
  },
  staleTime: 30_000,
});

export const settingsQuery = queryOptions({
  queryKey: queryKeys.settings,
  queryFn: () => getSettings(),
  staleTime: 5 * 60_000,
});

export const categoriesQuery = queryOptions({
  queryKey: queryKeys.categories,
  queryFn: () => getCategories(),
  staleTime: Infinity,
});

export const favoritesQuery = queryOptions({
  queryKey: queryKeys.favorites,
  queryFn: () => listFavorites(),
});

export const savedSearchesQuery = queryOptions({
  queryKey: queryKeys.savedSearches,
  queryFn: () => listSavedSearches(),
});

export const hiddenQuery = queryOptions({
  queryKey: queryKeys.hidden,
  queryFn: () => listHidden(),
});

export const blockedSellersQuery = queryOptions({
  queryKey: queryKeys.blockedSellers,
  queryFn: () => listBlockedSellers(),
});

export const remoteViewStateQuery = queryOptions({
  queryKey: queryKeys.remoteView,
  queryFn: (): Promise<RemoteViewState> => getRemoteViewState(),
  staleTime: Infinity,
});

/** A listing page (Facebook: 2-6 s). Cached a while; the server caches too. */
export const listingQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.listing(id),
    queryFn: () => getListing({ data: { id } }),
    staleTime: 5 * 60_000,
  });

/** Location typeahead; queries under 2 characters are not sent. */
export const locationsQuery = (q: string) =>
  queryOptions({
    queryKey: queryKeys.locations(q),
    queryFn: () => getLocations({ data: { q } }),
    enabled: q.length >= 2,
    staleTime: 60 * 60_000,
  });

/**
 * Search results, one explicit page at a time: page 1 is `search`, each next page is `loadMore`
 * with the previous page's sessionId. Never refetched automatically: a refetch would replay
 * stale sessions (the server expires idle ones). "Refresh results" resets the query instead.
 */
export const searchQuery = (params: SearchParams) =>
  infiniteQueryOptions({
    queryKey: queryKeys.search(params),
    queryFn: ({ pageParam }): Promise<SearchResult> =>
      pageParam === null ? search({ data: params }) : loadMore({ data: { sessionId: pageParam } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore && last.sessionId !== null ? last.sessionId : undefined),
    staleTime: Infinity,
    gcTime: 15 * 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    retry: false,
  });

/**
 * "View new": runs the saved search now (marks it viewed) and keeps the saved-search list in sync.
 * Reset before showing so it always re-runs (see ViewNewLink).
 */
export const savedSearchRunQuery = (id: number, queryClient: QueryClient) =>
  queryOptions({
    queryKey: queryKeys.savedSearchRun(id),
    queryFn: async (): Promise<SavedSearchRunResult> => {
      const result = await runSavedSearch({ data: { id } });
      queryClient.setQueryData<readonly SavedSearch[]>(queryKeys.savedSearches, (list) =>
        list?.map((s) => (s.id === result.savedSearch.id ? result.savedSearch : s)),
      );
      return result;
    },
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    retry: false,
  });

// ---------- groups ----------
// Read from Facebook as this browser's account (seconds each): client-only, never refetched
// behind the user's back. Watches and webhooks are local data.

/** The account's groups (the server caches them for 10 minutes too). */
export const joinedGroupsQuery = queryOptions({
  queryKey: queryKeys.joinedGroups,
  queryFn: () => listJoinedGroups(),
  staleTime: 10 * 60_000,
  retry: false,
});

/** A group's newest posts, one explicit "Load more" at a time (like searchQuery). */
export const groupFeedQuery = (groupId: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.groupFeed(groupId),
    queryFn: ({ pageParam }): Promise<GroupFeedPage> =>
      pageParam === null ? groupFeed({ data: { groupId } }) : loadMoreGroupPosts({ data: { sessionId: pageParam } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore && last.sessionId !== null ? last.sessionId : undefined),
    staleTime: Infinity,
    gcTime: 15 * 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    retry: false,
  });

/** One post with its first comments. */
export const groupPostQuery = (groupId: string, postId: string) =>
  queryOptions({
    queryKey: queryKeys.groupPost(groupId, postId),
    queryFn: () => getGroupPost({ data: { groupId, postId } }),
    staleTime: 2 * 60_000,
    retry: false,
  });

export const groupWatchesQuery = queryOptions({
  queryKey: queryKeys.groupWatches,
  queryFn: () => listGroupWatches(),
});

/**
 * A watch's matches, newest first. Showing them marks them seen: when the cached watch has new
 * ones, they are marked viewed on the server up to the newest one fetched (a match recorded
 * meanwhile stays new) and its count goes to 0. A failed "mark seen" doesn't fail the list.
 */
export const groupWatchMatchesQuery = (id: number, queryClient: QueryClient) =>
  queryOptions({
    queryKey: queryKeys.groupWatchMatches(id),
    queryFn: async (): Promise<readonly GroupWatchMatch[]> => {
      const matches = await listGroupWatchMatches({ data: { id } });
      const watch = queryClient.getQueryData<readonly GroupWatch[]>(queryKeys.groupWatches)?.find((w) => w.id === id);
      const newest = matches[0]?.matchedAt;
      if (watch !== undefined && watch.newMatchCount > 0 && newest !== undefined) {
        try {
          await viewGroupWatchMatches({ data: { id, upTo: newest } });
          queryClient.setQueryData<readonly GroupWatch[]>(queryKeys.groupWatches, (list) =>
            list?.map((w) => (w.id === id ? { ...w, newMatchCount: 0 } : w)),
          );
        } catch {
          // They stay marked new; the next look tries again.
        }
      }
      return matches;
    },
  });

export const webhooksQuery = queryOptions({
  queryKey: queryKeys.webhooks,
  queryFn: () => listWebhooks(),
});

export const webhookDeliveriesQuery = (id: number) =>
  queryOptions({
    queryKey: queryKeys.webhookDeliveries(id),
    queryFn: () => listWebhookDeliveries({ data: { id } }),
  });

/** A post already in a cached feed, so its page can show something while Facebook loads. */
export function findCachedGroupPost(queryClient: QueryClient, groupId: string, postId: string): GroupPost | undefined {
  const feed = queryClient.getQueryData<InfiniteData<GroupFeedPage, string | null>>(queryKeys.groupFeed(groupId));
  for (const page of feed?.pages ?? []) {
    const hit = page.posts.find((p) => p.id === postId);
    if (hit !== undefined) return hit;
  }
  for (const [, matches] of queryClient.getQueriesData<readonly GroupWatchMatch[]>({ queryKey: queryKeys.groupWatchMatchLists })) {
    const hit = matches?.find((m) => m.post.id === postId && m.post.groupId === groupId);
    if (hit !== undefined) return hit.post;
  }
  return undefined;
}

// ---------- cache helpers ----------

type SearchPages = InfiniteData<SearchResult, string | null>;

/** Drop listings (just hidden, or from a just-blocked seller) from every cached result list, without refetching. */
export function removeCachedListings(queryClient: QueryClient, shouldRemove: (l: ListingSummary) => boolean): void {
  queryClient.setQueriesData<SearchPages>({ queryKey: queryKeys.searches }, (data) =>
    data === undefined
      ? data
      : { ...data, pages: data.pages.map((page) => ({ ...page, listings: page.listings.filter((l) => !shouldRemove(l)) })) },
  );
  queryClient.setQueriesData<SavedSearchRunResult>({ queryKey: queryKeys.savedSearchRuns }, (data) =>
    data === undefined ? data : { ...data, newListings: data.newListings.filter((l) => !shouldRemove(l)) },
  );
}

/** A listing summary already in the cache, so the item page can show something while Facebook loads. */
export function findCachedListing(queryClient: QueryClient, id: string): ListingSummary | undefined {
  for (const [, data] of queryClient.getQueriesData<SearchPages>({ queryKey: queryKeys.searches })) {
    for (const page of data?.pages ?? []) {
      const hit = page.listings.find((l) => l.id === id);
      if (hit !== undefined) return hit;
    }
  }
  for (const [, data] of queryClient.getQueriesData<SavedSearchRunResult>({ queryKey: queryKeys.savedSearchRuns })) {
    const hit = data?.newListings.find((l) => l.id === id);
    if (hit !== undefined) return hit;
  }
  return queryClient.getQueryData<readonly Favorite[]>(queryKeys.favorites)?.find((f) => f.listing.id === id)?.listing;
}

/**
 * For route loaders warming the cache: wait for the fetches, but let failures stay in the query
 * cache (each page renders its own error state) instead of becoming a route error.
 */
export async function settled(...fetches: readonly Promise<unknown>[]): Promise<void> {
  await Promise.allSettled(fetches);
}
