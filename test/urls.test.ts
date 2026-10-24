import { describe, expect, it } from 'vitest';
import { isNearbyBrowse, listingUrl, marketplaceUrl } from '@/server/marketplace/urls';

const FB = 'https://www.facebook.com';
const parse = (url: string) => {
  const u = new URL(url);
  return { path: u.pathname, params: Object.fromEntries(u.searchParams) };
};

describe('marketplaceUrl', () => {
  it('builds a search URL for a vanity location', () => {
    expect(marketplaceUrl({ location: 'nyc', query: 'bike' })).toBe(`${FB}/marketplace/nyc/search/?query=bike`);
  });

  it('accepts numeric city page ids and encodes the query', () => {
    expect(marketplaceUrl({ location: '115590505119035', query: 'road bike & helmet' })).toBe(
      `${FB}/marketplace/115590505119035/search/?query=road+bike+%26+helmet`,
    );
  });

  it('maps every filter to the URL params Facebook understands', () => {
    const url = marketplaceUrl({
      location: 'nyc',
      query: 'bike',
      radiusKm: 16,
      minPrice: 20,
      maxPrice: 200,
      sortBy: 'creation_time_descend',
      daysSinceListed: 7,
      conditions: ['new', 'used_like_new'],
      delivery: 'local_pick_up',
      exact: true,
    });
    expect(parse(url)).toEqual({
      path: '/marketplace/nyc/search/',
      params: {
        query: 'bike',
        minPrice: '20',
        maxPrice: '200',
        sortBy: 'creation_time_descend',
        daysSinceListed: '7',
        itemCondition: 'new,used_like_new',
        deliveryMethod: 'local_pick_up',
        radius: '16',
        exact: 'true',
      },
    });
  });

  it('omits defaults and empty values', () => {
    const url = marketplaceUrl({
      location: 'nyc',
      query: '  bike  ',
      sortBy: 'best_match',
      delivery: 'all',
      conditions: [],
      minPrice: 0,
      maxPrice: Number.NaN,
      radiusKm: 0,
      exact: false,
    });
    expect(url).toBe(`${FB}/marketplace/nyc/search/?query=bike`);
  });

  it('rounds prices and radius to whole numbers', () => {
    const { params } = parse(marketplaceUrl({ location: 'nyc', query: 'x', minPrice: 19.5, maxPrice: 99.2, radiusKm: 64.37 }));
    expect(params).toMatchObject({ minPrice: '19', maxPrice: '100', radius: '64' });
  });

  it('de-duplicates conditions', () => {
    const { params } = parse(marketplaceUrl({ query: 'x', conditions: ['used_good', 'used_good', 'used_fair'] }));
    expect(params.itemCondition).toBe('used_good,used_fair');
  });

  it('builds category browse URLs, with or without a query', () => {
    expect(marketplaceUrl({ location: 'nyc', category: 'bicycles' })).toBe(`${FB}/marketplace/nyc/bicycles/`);
    expect(marketplaceUrl({ location: 'nyc', category: 'bicycles', query: 'trek', maxPrice: 500 })).toBe(
      `${FB}/marketplace/nyc/bicycles/?query=trek&maxPrice=500`,
    );
  });

  it('uses the account/IP location when none is given', () => {
    expect(marketplaceUrl({ query: 'bike' })).toBe(`${FB}/marketplace/search/?query=bike`);
    expect(marketplaceUrl({ category: 'vehicles', sortBy: 'price_ascend' })).toBe(`${FB}/marketplace/category/vehicles/?sortBy=price_ascend`);
    expect(marketplaceUrl({})).toBe(`${FB}/marketplace/`);
  });

  it('browses the nearby feed with no query and no category (filters do not apply there)', () => {
    expect(marketplaceUrl({ location: 'austin', minPrice: 10, sortBy: 'creation_time_descend' })).toBe(`${FB}/marketplace/austin/`);
    expect(marketplaceUrl({ location: 'austin', query: '   ' })).toBe(`${FB}/marketplace/austin/`);
    expect(isNearbyBrowse({ location: 'austin', query: ' ' })).toBe(true);
    expect(isNearbyBrowse({ category: 'free' })).toBe(false);
    expect(isNearbyBrowse({ query: 'desk' })).toBe(false);
  });

  it('only sends exact=true with a query', () => {
    expect(marketplaceUrl({ location: 'nyc', category: 'free', exact: true })).toBe(`${FB}/marketplace/nyc/free/`);
  });

  it('keeps hostile input inside its path segment', () => {
    const url = marketplaceUrl({ location: '../../login', category: 'a/b?c', query: 'x' });
    expect(new URL(url).pathname).toBe('/marketplace/..%2F..%2Flogin/a%2Fb%3Fc/');
    expect(new URL(url).hostname).toBe('www.facebook.com');
  });
});

describe('listingUrl', () => {
  it('builds the canonical item URL', () => {
    expect(listingUrl('1631327708471334')).toBe(`${FB}/marketplace/item/1631327708471334/`);
  });
});
