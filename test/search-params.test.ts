// /search URL state: lenient validation, canonical form, identity, defaults, summaries, encoding.
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeFormat } from '@/lib/format';
import {
  countActiveFilters,
  defaultSearchName,
  describeSearch,
  humanizeSlug,
  isNearbyBrowse,
  normalizeSearchParams,
  searchIdentity,
  stringifySearchValue,
  toApiParams,
  validateSearchPageSearch,
  withSearchDefaults,
} from '@/lib/search-params';
import { DEFAULT_SETTINGS, SearchParams } from '@/shared/domain';

const us = makeFormat('en-US');
const de = makeFormat('de-DE');
const decodeOnServer = Schema.decodeUnknownSync(SearchParams);

describe('normalizeSearchParams', () => {
  it('coerces URL strings and numbers into typed params', () => {
    expect(
      normalizeSearchParams({
        query: '  road bike ',
        category: 'bicycles',
        location: 'nyc',
        radiusKm: '40',
        minPrice: 50,
        maxPrice: '300.4',
        sortBy: 'price_ascend',
        daysSinceListed: '7',
        conditions: 'used_good,new',
        delivery: 'shipping',
        exact: 'true',
      }),
    ).toEqual({
      query: 'road bike',
      category: 'bicycles',
      location: 'nyc',
      radiusKm: 40,
      minPrice: 50,
      maxPrice: 300,
      sortBy: 'price_ascend',
      daysSinceListed: 7,
      conditions: ['new', 'used_good'],
      delivery: 'shipping',
      exact: true,
    });
  });

  it('drops defaults and empties so equal searches are identical', () => {
    expect(
      normalizeSearchParams({ query: '   ', sortBy: 'best_match', delivery: 'all', exact: 'false', conditions: '' }),
    ).toEqual({});
  });

  it('drops invalid values instead of failing the page', () => {
    expect(
      normalizeSearchParams({
        category: 'bikes & more',
        location: 'a/b',
        radiusKm: 9000,
        minPrice: -5,
        maxPrice: 'lots',
        sortBy: 'random',
        daysSinceListed: 3,
        conditions: ['mint', 'new', 'new'],
        delivery: 'drone',
        unknown: 'x',
      }),
    ).toEqual({ conditions: ['new'] });
  });

  it('keeps numeric-looking queries as text (the router turns "1999" into a number)', () => {
    expect(normalizeSearchParams({ query: 1999 })).toEqual({ query: '1999' });
    expect(normalizeSearchParams({ query: true })).toEqual({ query: 'true' });
  });

  it('accepts repeated keys as a list', () => {
    expect(normalizeSearchParams({ conditions: ['used_fair', 'new,used_like_new'] }).conditions).toEqual([
      'new',
      'used_like_new',
      'used_fair',
    ]);
  });

  it('swaps a min price above the max price', () => {
    expect(normalizeSearchParams({ minPrice: 500, maxPrice: 100 })).toEqual({ minPrice: 100, maxPrice: 500 });
  });

  it('truncates very long queries', () => {
    expect(normalizeSearchParams({ query: 'x'.repeat(500) }).query).toHaveLength(200);
  });

  it('always produces params the server accepts unchanged', () => {
    const samples = [
      {},
      { query: ' lamp ', radiusKm: '1', maxPrice: '0' },
      { category: 'vehicles', minPrice: 1000, maxPrice: 50, conditions: 'new,used_fair' },
      { location: '115590505119035', daysSinceListed: 30, delivery: 'local_pick_up', exact: 1 },
    ];
    for (const raw of samples) {
      const params = normalizeSearchParams(raw);
      expect(decodeOnServer(params)).toEqual(params);
    }
  });
});

describe('validateSearchPageSearch / toApiParams', () => {
  it('keeps the location display name only with a location', () => {
    expect(validateSearchPageSearch({ location: 'nyc', locationName: 'New York, NY' })).toEqual({
      location: 'nyc',
      locationName: 'New York, NY',
    });
    expect(validateSearchPageSearch({ locationName: 'New York, NY' })).toEqual({});
  });

  it('strips UI-only keys for the server', () => {
    expect(toApiParams({ query: 'desk', location: 'nyc', locationName: 'New York, NY' })).toEqual({
      query: 'desk',
      location: 'nyc',
    });
  });
});

describe('searchIdentity', () => {
  it('ignores key order, defaults and condition order', () => {
    expect(searchIdentity({ query: 'desk', conditions: ['used_good', 'new'], radiusKm: 20 })).toBe(
      searchIdentity({ radiusKm: 20, conditions: ['new', 'used_good'], query: 'desk', sortBy: 'best_match', delivery: 'all' }),
    );
  });

  it('distinguishes different searches', () => {
    expect(searchIdentity({ query: 'desk' })).not.toBe(searchIdentity({ query: 'desk', radiusKm: 20 }));
  });
});

describe('isNearbyBrowse', () => {
  it('is nearby browse without a query or category', () => {
    expect(isNearbyBrowse({})).toBe(true);
    expect(isNearbyBrowse({ location: 'nyc', radiusKm: 10 })).toBe(true);
    expect(isNearbyBrowse({ query: 'desk' })).toBe(false);
    expect(isNearbyBrowse({ category: 'bicycles' })).toBe(false);
  });
});

describe('withSearchDefaults', () => {
  const settings = { ...DEFAULT_SETTINGS, defaultLocation: { id: 'nyc', name: 'New York, NY' }, defaultRadiusKm: 40 };

  it('fills in the default location and radius for a new search', () => {
    expect(withSearchDefaults({ query: 'desk' }, settings)).toEqual({
      query: 'desk',
      location: 'nyc',
      locationName: 'New York, NY',
      radiusKm: 40,
    });
  });

  it('never overrides what the search already has', () => {
    expect(withSearchDefaults({ location: 'austin', locationName: 'Austin', radiusKm: 5 }, settings)).toEqual({
      location: 'austin',
      locationName: 'Austin',
      radiusKm: 5,
    });
  });

  it('leaves the search alone without settings or defaults', () => {
    expect(withSearchDefaults({ query: 'desk' }, undefined)).toEqual({ query: 'desk' });
    expect(withSearchDefaults({ query: 'desk' }, DEFAULT_SETTINGS)).toEqual({ query: 'desk' });
  });
});

describe('countActiveFilters', () => {
  it('counts filters beyond query, category and location; a price range counts once', () => {
    expect(countActiveFilters({ query: 'x', category: 'y', location: 'z' })).toBe(0);
    expect(countActiveFilters({ minPrice: 1, maxPrice: 2, radiusKm: 5, conditions: ['new'], exact: true })).toBe(4);
  });
});

describe('describeSearch', () => {
  it('summarizes in the user’s units and currency format', () => {
    expect(
      describeSearch(
        { category: 'bicycles', minPrice: 50, maxPrice: 300, conditions: ['used_good'], radiusKm: 64, sortBy: 'creation_time_descend' },
        us,
        'Bicycles',
      ),
    ).toBe('Bicycles · $50–$300 · Used – good · within 40 mi · Newest first');
    // Intl separates the amount and the unit with a no-break space.
    expect(describeSearch({ maxPrice: 100, radiusKm: 40 }, de).replace(/\s/g, ' ')).toBe('under 100 $ · within 40 km');
    expect(describeSearch({ minPrice: 20, daysSinceListed: 1, delivery: 'shipping' }, us)).toBe(
      'over $20 · Last 24 hours · Shipping',
    );
  });

  it('humanizes unknown category slugs', () => {
    expect(describeSearch({ category: 'home-improvement' }, us)).toBe('Home improvement');
    expect(humanizeSlug('free_stuff')).toBe('Free stuff');
  });
});

describe('defaultSearchName', () => {
  it('prefers the query, then the category, then "Nearby"', () => {
    expect(defaultSearchName({ query: 'desk', category: 'furniture' })).toBe('desk');
    expect(defaultSearchName({ category: 'furniture' }, 'Furniture')).toBe('Furniture');
    expect(defaultSearchName({ category: 'home-goods' })).toBe('Home goods');
    expect(defaultSearchName({})).toBe('Nearby');
  });
});

describe('URL encoding', () => {
  it('writes lists comma-separated and everything else as plain text', () => {
    expect(stringifySearchValue(['new', 'used_good'])).toBe('new,used_good');
    expect(stringifySearchValue(40)).toBe('40');
    expect(stringifySearchValue(true)).toBe('true');
    expect(stringifySearchValue('road bike')).toBe('road bike');
  });

  it('round-trips through the router’s value parsing', () => {
    const search = { query: 'road bike', conditions: ['new', 'used_good'] as const, radiusKm: 40, exact: true as const };
    const url = new URLSearchParams(
      Object.entries(search).map(([k, v]) => [k, stringifySearchValue(v)] as [string, string]),
    );
    // The router's decoder hands numbers/booleans over as such; validateSearch accepts both.
    const raw = Object.fromEntries([...url.entries()].map(([k, v]) => [k, /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v]));
    expect(validateSearchPageSearch(raw)).toEqual(search);
  });
});
