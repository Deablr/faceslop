// Local filtering: hidden listings, blocked sellers, excluded keywords. OWNER: server builder.
// Ported from legacy/src/server/filters.ts; everything but `loadLocalFilters` / `toSearchResult`
// is pure. Filters are per owner (see src/server/session/identity.ts). Used by the browse server functions, saved-search runs and SavedSearchesRepo (newCount).
//
// Search defaults are NOT applied on the server (legacy applySearchDefaults is gone on purpose):
// the UI writes Settings.defaultLocation/defaultRadiusKm into the URL when a new search starts, so
// "Use my Facebook location" (no location) reaches Facebook as is, and saved searches run their
// stored params unchanged.
import '@tanstack/react-start/server-only';
import { Effect, Option } from 'effect';
import { BlockedSellersRepo } from '@/server/db/repositories/BlockedSellersRepo';
import { HiddenListingsRepo } from '@/server/db/repositories/HiddenListingsRepo';
import { SettingsRepo } from '@/server/db/repositories/SettingsRepo';
import type { SearchPage } from '@/server/marketplace/Marketplace';
import type { OwnerKey } from '@/server/session/identity';
import type { ListingSummary, SearchResult } from '@/shared/domain';

export interface LocalFilters {
  readonly hiddenIds: ReadonlySet<string>;
  readonly blockedSellerIds: ReadonlySet<string>;
  /** Lowercased keywords (Settings.excludedKeywords). */
  readonly excludedKeywords: readonly string[];
}

export interface FilterOutcome {
  readonly kept: ListingSummary[];
  readonly filteredCount: number;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Builds a case-insensitive title matcher for excluded keywords.
 *
 * A keyword matches as a whole word or phrase, optionally pluralized:
 * "bike" drops "Bike rack" and "Kids bikes" but not "Motorbike" or "biker jacket".
 * Words in a multi-word keyword may be separated by any whitespace.
 */
export function keywordMatcher(keywords: readonly string[]): (title: string) => boolean {
  const parts = keywords
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => k.split(/\s+/).map(escapeRegExp).join('\\s+'));
  if (parts.length === 0) return () => false;
  // \b is ASCII-only; use Unicode letter/number lookarounds so "café" behaves like "cafe".
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?:e?s)?(?![\\p{L}\\p{N}])`, 'iu');
  return (title) => re.test(title);
}

export function applyLocalFilters(listings: readonly ListingSummary[], filters: LocalFilters): FilterOutcome {
  const matchesKeyword = keywordMatcher(filters.excludedKeywords);
  const kept = listings.filter(
    (l) =>
      !filters.hiddenIds.has(l.id) &&
      // A listing without a seller id is never "blocked" (legacy: a falsy sellerId never matched).
      !(l.sellerId !== null && l.sellerId !== '' && filters.blockedSellerIds.has(l.sellerId)) &&
      !matchesKeyword(l.title),
  );
  return { kept, filteredCount: listings.length - kept.length };
}

/** Nothing filtered (requests without a session have no local data). */
export const NO_LOCAL_FILTERS: LocalFilters = { hiddenIds: new Set(), blockedSellerIds: new Set(), excludedKeywords: [] };

/** Everything applyLocalFilters needs for an owner, read fresh from the repositories. */
export const loadLocalFilters = (owner: OwnerKey) =>
  Effect.gen(function* () {
    const [hiddenIds, blockedSellerIds, settings] = yield* Effect.all(
      [
        HiddenListingsRepo.use((repo) => repo.ids(owner)),
        BlockedSellersRepo.use((repo) => repo.ids(owner)),
        SettingsRepo.use((repo) => repo.get(owner)),
      ],
      { concurrency: 'unbounded' },
    );
    return { hiddenIds, blockedSellerIds, excludedKeywords: settings.excludedKeywords } satisfies LocalFilters;
  });

/** A page of raw Marketplace results as the UI gets it: filtered with the owner's local filters (None: unfiltered). */
export const toSearchResult = (owner: Option.Option<OwnerKey>) => (page: SearchPage) =>
  Effect.map(
    Option.match(owner, { onNone: () => Effect.succeed(NO_LOCAL_FILTERS), onSome: loadLocalFilters }),
    (filters): SearchResult => {
      const { kept, filteredCount } = applyLocalFilters(page.listings, filters);
      return { sessionId: page.sessionId, listings: kept, hasMore: page.hasMore, location: page.location, filteredCount };
    },
  );
