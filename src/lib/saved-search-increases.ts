// Which saved searches found something new since the previous notifier check
// (src/hooks/use-saved-search-notifier.ts). Kept plain so the rules are testable.
import type { SavedSearch } from '@/shared/domain';

/** What the previous check saw: whose saved searches they were (accountOf) and each one's newCount. */
export interface SeenNewCounts {
  readonly owner: string | null;
  readonly counts: ReadonlyMap<number, number>;
}

/**
 * Compare `list` (the saved searches of `owner`) with the previous check. The first check, and the
 * first after this browser logged in to or out of Facebook (another owner: after a login the list
 * also holds the account's searches from other devices, and what they already found isn't news),
 * only record. Otherwise every search whose newCount went up counts, new ones included (from 0).
 */
export function savedSearchIncreases(
  previous: SeenNewCounts | null,
  owner: string | null,
  list: readonly SavedSearch[],
): { readonly seen: SeenNewCounts; readonly increased: readonly SavedSearch[] } {
  const seen: SeenNewCounts = { owner, counts: new Map(list.map((s) => [s.id, s.newCount])) };
  if (previous?.owner !== owner) return { seen, increased: [] };
  return { seen, increased: list.filter((s) => s.newCount > (previous.counts.get(s.id) ?? 0)) };
}
