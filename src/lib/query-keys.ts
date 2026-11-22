// Every query key in the app. Kept apart from src/lib/queries.ts (which imports the server
// functions) so cache helpers like src/lib/account-change.ts stay plain and testable.
import type { SearchParams } from '@/shared/domain';

export const queryKeys = {
  appAuth: ['app-auth'] as const,
  auth: ['auth'] as const,
  settings: ['settings'] as const,
  categories: ['categories'] as const,
  favorites: ['favorites'] as const,
  savedSearches: ['saved-searches'] as const,
  savedSearchRuns: ['saved-search-run'] as const,
  savedSearchRun: (id: number) => ['saved-search-run', id] as const,
  hidden: ['hidden'] as const,
  blockedSellers: ['blocked-sellers'] as const,
  listings: ['listing'] as const,
  listing: (id: string) => ['listing', id] as const,
  locationLookups: ['locations'] as const,
  locations: (q: string) => ['locations', q] as const,
  searches: ['search'] as const,
  search: (params: SearchParams) => ['search', params] as const,
  remoteView: ['remote-view'] as const,
  /** Everything read from Facebook groups (as this browser's account). */
  groups: ['groups'] as const,
  joinedGroups: ['groups', 'joined'] as const,
  groupFeed: (groupId: string) => ['groups', 'feed', groupId] as const,
  groupPost: (groupId: string, postId: string) => ['groups', 'post', groupId, postId] as const,
  groupWatches: ['group-watches'] as const,
  groupWatchMatchLists: ['group-watch-matches'] as const,
  groupWatchMatches: (id: number) => ['group-watch-matches', id] as const,
  webhooks: ['webhooks'] as const,
  webhookDeliveryLists: ['webhook-deliveries'] as const,
  webhookDeliveries: (id: number) => ['webhook-deliveries', id] as const,
};
