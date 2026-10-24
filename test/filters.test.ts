// Local filtering (port of legacy/test/filters.test.ts). Legacy's applySearchDefaults tests are
// gone on purpose: the server no longer fills in a default location/radius (the UI writes it into
// the URL when a new search starts), so `toSearchResult` must pass params through untouched.
// Filters are per owner: one owner's hidden listings, blocked sellers and keywords never filter
// another's results, and a request without a session gets everything.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { RepositoriesLayerMemory } from '@/server/db/layers';
import { BlockedSellersRepo } from '@/server/db/repositories/BlockedSellersRepo';
import { HiddenListingsRepo } from '@/server/db/repositories/HiddenListingsRepo';
import { SettingsRepo } from '@/server/db/repositories/SettingsRepo';
import {
  NO_LOCAL_FILTERS,
  applyLocalFilters,
  keywordMatcher,
  loadLocalFilters,
  toSearchResult,
  type LocalFilters,
} from '@/server/filters';
import { type ClientSessionId, type FbUserId, accountOwner, sessionOwner } from '@/server/session/identity';
import type { ListingSummary } from '@/shared/domain';

const A = accountOwner('1001' as FbUserId);
const B = sessionOwner('browser-b' as ClientSessionId);

const listing = (id: string, title: string, sellerId: string | null = null): ListingSummary => ({
  id,
  title,
  price: { amount: 10, formatted: '$10', currency: 'USD' },
  previousPrice: null,
  imageUrl: null,
  location: null,
  createdAt: null,
  status: 'available',
  sellerId,
  sellerName: null,
  deliveryTypes: [],
  categoryId: null,
  url: `https://www.facebook.com/marketplace/item/${id}/`,
});

const none: LocalFilters = { hiddenIds: new Set(), blockedSellerIds: new Set(), excludedKeywords: [] };

describe('keywordMatcher', () => {
  const matches = (keywords: string[], title: string) => keywordMatcher(keywords)(title);

  it('matches whole words case-insensitively', () => {
    expect(matches(['bike'], 'Kids BIKE, barely used')).toBe(true);
    expect(matches(['bike'], 'bike')).toBe(true);
    expect(matches(['bike'], 'Trek mountain bike!')).toBe(true);
  });

  it('matches simple plurals', () => {
    expect(matches(['bike'], 'Two bikes for sale')).toBe(true);
    expect(matches(['box'], 'Moving boxes')).toBe(true);
  });

  it('does not match inside other words', () => {
    expect(matches(['bike'], 'Motorbike helmet')).toBe(false);
    expect(matches(['bike'], 'Biker jacket')).toBe(false);
    expect(matches(['car'], 'Carseat and cart')).toBe(false);
  });

  it('matches multi-word phrases across any whitespace', () => {
    expect(matches(['free kittens'], 'FREE   Kittens to good home')).toBe(true);
    expect(matches(['free kittens'], 'Kittens, free')).toBe(false);
  });

  it('treats regex characters literally', () => {
    expect(matches(['c++'], 'Learn C++ book')).toBe(true);
    expect(matches(['a.b'], 'axb')).toBe(false);
  });

  it('uses Unicode word boundaries', () => {
    expect(matches(['café'], 'Café table')).toBe(true);
    expect(matches(['caf'], 'Café table')).toBe(false);
  });

  it('matches nothing with no keywords', () => {
    expect(matches([], 'anything')).toBe(false);
    expect(matches(['  '], 'anything')).toBe(false);
  });
});

describe('applyLocalFilters', () => {
  const listings = [
    listing('1', 'Road bike', 's1'),
    listing('2', 'Motorbike', 's2'),
    listing('3', 'Couch', 's3'),
    listing('4', 'Lamp', null),
  ];

  it('keeps everything with no filters', () => {
    expect(applyLocalFilters(listings, none)).toEqual({ kept: listings, filteredCount: 0 });
  });

  it('drops hidden listings, blocked sellers, and excluded keywords and counts them', () => {
    const { kept, filteredCount } = applyLocalFilters(listings, {
      hiddenIds: new Set(['3']),
      blockedSellerIds: new Set(['s2']),
      excludedKeywords: ['bike'],
    });
    expect(kept.map((l) => l.id)).toEqual(['4']);
    expect(filteredCount).toBe(3);
  });

  it('never treats a missing seller as blocked', () => {
    const blockedEmpty = { ...none, blockedSellerIds: new Set(['']) };
    expect(applyLocalFilters([listing('9', 'Thing', null)], blockedEmpty).kept).toHaveLength(1);
    expect(applyLocalFilters([listing('9', 'Thing', '')], blockedEmpty).kept).toHaveLength(1);
  });
});

describe('loadLocalFilters / toSearchResult', () => {
  const location = { name: 'Brooklyn, New York', latitude: 40.6, longitude: -73.9, radiusKm: 16 };
  const searchPage = {
    sessionId: 'sess-1',
    hasMore: true,
    location,
    listings: [
      listing('1', 'Desk'),
      listing('2', 'Desk'),
      listing('3', 'Desk', 'seller3'),
      listing('4', 'Baby crib'),
      listing('5', 'Desk lamp'),
    ],
  };

  it.effect("reads the owner's filters fresh and applies them to a search page", () =>
    Effect.gen(function* () {
      yield* SettingsRepo.use((repo) => repo.update(A, { excludedKeywords: [' Crib '] }));
      yield* HiddenListingsRepo.use((repo) => repo.hide(A, { id: '2', title: 'Listing 2' }, 1));
      yield* BlockedSellersRepo.use((repo) => repo.block(A, { id: 'seller3', name: 'Spam' }, 1));
      expect(yield* loadLocalFilters(A)).toEqual({
        hiddenIds: new Set(['2']),
        blockedSellerIds: new Set(['seller3']),
        excludedKeywords: ['crib'],
      });

      const result = yield* toSearchResult(Option.some(A))(searchPage);
      expect(result).toEqual({
        sessionId: 'sess-1',
        hasMore: true,
        location,
        listings: [listing('1', 'Desk'), listing('5', 'Desk lamp')],
        filteredCount: 3,
      });
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect("never applies another owner's filters, and filters nothing without a session", () =>
    Effect.gen(function* () {
      yield* SettingsRepo.use((repo) => repo.update(A, { excludedKeywords: ['desk'] }));
      yield* HiddenListingsRepo.use((repo) => repo.hide(A, { id: '4', title: 'Listing 4' }, 1));
      yield* BlockedSellersRepo.use((repo) => repo.block(B, { id: 'seller3', name: 'Spam' }, 1));

      expect(yield* loadLocalFilters(B)).toEqual({
        hiddenIds: new Set(),
        blockedSellerIds: new Set(['seller3']),
        excludedKeywords: [],
      });
      const forB = yield* toSearchResult(Option.some(B))(searchPage);
      expect(forB.listings.map((l) => l.id)).toEqual(['1', '2', '4', '5']);
      expect(forB.filteredCount).toBe(1);

      const anonymous = yield* toSearchResult(Option.none())(searchPage);
      expect(anonymous).toMatchObject({ listings: searchPage.listings, filteredCount: 0 });
      expect(applyLocalFilters(searchPage.listings, NO_LOCAL_FILTERS).kept).toHaveLength(5);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );
});
