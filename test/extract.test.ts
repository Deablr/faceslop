// Pure extractors against trimmed, anonymized Facebook payloads (test/fixtures), ported from
// legacy/test/extract.test.ts, plus the guarantee that everything they emit satisfies the domain
// schemas in src/shared/domain.ts.
import fs from 'node:fs';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  detectFeedKind,
  extractErrorRoute,
  extractJsonBlobs,
  extractListingDetail,
  extractLocationOptions,
  extractPageInfo,
  extractPageTokens,
  extractPreloadedQueries,
  extractRoutePath,
  extractSearchLocation,
  findFeedQuery,
  findListings,
  graphqlErrors,
  hasProductDetailsPage,
  jazoest,
  normalizeListing,
  parseGraphqlBody,
} from '@/server/marketplace/extract';
import { clip, conformDetail, conformLocation, conformSummary } from '@/server/marketplace/conform';
import { ListingDetail, ListingSummary, LocationId, LocationOption, SearchLocationInfo } from '@/shared/domain';

/** `expect.stringContaining`, typed (vitest types asymmetric matchers as `any`). */
const containing = (text: string): string => expect.stringContaining(text) as string;

const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const searchHtml = fixture('search-nyc-bike.html');
const searchBlobs = extractJsonBlobs(searchHtml);
const homeHtml = fixture('home-nyc.html');
const homeBlobs = extractJsonBlobs(homeHtml);
const itemBlobs = extractJsonBlobs(fixture('item.html'));
const missingBlobs = extractJsonBlobs(fixture('item-missing.html'));

describe('extractJsonBlobs', () => {
  it('parses every application/json script tag and skips broken ones', () => {
    const html = [
      '<script type="application/json" data-sjs>{"a":1}</script>',
      '<script>var notJson = 1;</script>',
      '<script type="application/json">{broken</script>',
      '<script nonce="x" type="application/json" data-content-len="7">[1,2]</script>',
    ].join('');
    expect(extractJsonBlobs(html)).toEqual([{ a: 1 }, [1, 2]]);
  });

  it('finds the search page blobs', () => {
    expect(searchBlobs.length).toBeGreaterThan(1);
  });
});

describe('parseGraphqlBody', () => {
  it('splits newline-separated documents and ignores junk lines', () => {
    expect(parseGraphqlBody('{"data":1}\n\n{"label":"x","data":2}\n{oops')).toEqual([{ data: 1 }, { label: 'x', data: 2 }]);
  });

  it('strips the for(;;); guard', () => {
    expect(parseGraphqlBody('for (;;);{"error":1357001,"errorSummary":"Not logged in"}')).toEqual([
      { error: 1357001, errorSummary: 'Not logged in' },
    ]);
  });

  it('parses a streamed home-feed page (several documents)', () => {
    const docs = parseGraphqlBody(fixture('home-page2.graphql.txt'));
    expect(docs).toHaveLength(7);
  });
});

describe('graphqlErrors', () => {
  it('collects GraphQL and legacy error messages', () => {
    expect(graphqlErrors([{ errors: [{ message: 'bad doc' }] }, { error: 1, errorSummary: 'Rate limited' }, { data: {} }])).toEqual([
      'bad doc',
      'Rate limited',
    ]);
  });
});

describe('findListings (search page)', () => {
  const listings = findListings(searchBlobs);

  it('finds every listing in the results feed, de-duplicated', () => {
    expect(listings).toHaveLength(14);
    expect(new Set(listings.map((l) => l.id)).size).toBe(14);
  });

  it('normalizes a listing', () => {
    expect(listings[0]).toEqual({
      id: '1631327708471334',
      title: 'Free bike lease',
      price: { amount: 0, formatted: 'Free', currency: null },
      previousPrice: null,
      imageUrl: containing('fbcdn.net'),
      location: 'Brooklyn, NY',
      createdAt: 1791444981000,
      status: 'available',
      sellerId: 'pfbid0FAKESELLER0001',
      sellerName: 'Seller One',
      deliveryTypes: ['IN_PERSON'],
      categoryId: '1658310421102081',
      url: 'https://www.facebook.com/marketplace/item/1631327708471334/',
    });
  });

  it('reads markdowns from strikethrough_price', () => {
    const marked = listings.find((l) => l.id === '1858669721763004');
    expect(marked?.price).toEqual({ amount: 40, formatted: '$40', currency: null });
    expect(marked?.previousPrice).toBe('$50');
  });

  it('labels zero prices "Free"', () => {
    const free = listings.filter((l) => l.price.amount === 0);
    expect(free).toHaveLength(3);
    for (const l of free) expect(l.price.formatted).toBe('Free');
  });
});

describe('findListings (pagination + home feed)', () => {
  it('reads a search pagination response', () => {
    const docs = parseGraphqlBody(fixture('search-page2.graphql.txt'));
    const listings = findListings(docs);
    expect(listings).toHaveLength(28);
    expect(listings.every((l) => l.title && l.url.endsWith(`/item/${l.id}/`))).toBe(true);
    expect(detectFeedKind(docs)).toBe('search');
  });

  it('reads the home feed: top picks plus general feed units', () => {
    const listings = findListings(homeBlobs);
    expect(listings).toHaveLength(26);
    // top-picks shape: price under listing_price.amount + formatted_price.text
    expect(listings[0]).toMatchObject({ id: '1597229651779586', price: { amount: 1, formatted: '$1' }, location: 'Hempstead, NY' });
    expect(listings.find((l) => l.id === '1090454277133657')?.price).toEqual({ amount: 0, formatted: 'Free', currency: null });
    // general-unit shape: price in cents under data.price.amount_with_offset
    expect(listings.find((l) => l.id === '1756680795624353')).toMatchObject({
      title: '2012 Nissan  Maxima ',
      price: { amount: 100, formatted: '$100', currency: 'USD' },
      location: 'Brooklyn, NY',
      createdAt: 1792535280000,
    });
  });

  it('reads a streamed home-feed page', () => {
    const docs = parseGraphqlBody(fixture('home-page2.graphql.txt'));
    const listings = findListings(docs);
    expect(listings).toHaveLength(6);
    expect(listings[0]).toMatchObject({
      id: '1145596791359797',
      title: 'FX20 E-bike',
      price: { amount: 1, formatted: '$1', currency: 'USD' },
      location: 'Lodi, NJ',
      imageUrl: containing('fbcdn.net'),
    });
    expect(detectFeedKind(docs)).toBe('home');
  });

  it('fills gaps from duplicate copies of the same listing', () => {
    const listings = findListings([
      { marketplace_listing_title: 'Desk', id: '1', listing_price: { amount: '20.00' } },
      { marketplace_listing_title: 'Desk', id: '1', primary_listing_photo: { image: { uri: 'https://x.fbcdn.net/a.jpg' } } },
    ]);
    expect(listings).toHaveLength(1);
    expect(listings[0]?.imageUrl).toBe('https://x.fbcdn.net/a.jpg');
    expect(listings[0]?.price.formatted).toBe('$20');
  });
});

describe('normalizeListing', () => {
  const base = { id: '42', marketplace_listing_title: 'Chair' };

  it('derives status from is_sold / is_pending / is_live', () => {
    expect(normalizeListing({ ...base, is_sold: true, is_live: true })?.status).toBe('sold');
    expect(normalizeListing({ ...base, is_pending: true })?.status).toBe('pending');
    expect(normalizeListing({ ...base, is_live: true })?.status).toBe('available');
    expect(normalizeListing({ ...base, is_live: false })?.status).toBe('unknown');
    expect(normalizeListing({ ...base, renderable_listing_status: 'SOLD' })?.status).toBe('sold');
  });

  it('is defensive about missing and odd fields', () => {
    expect(normalizeListing({ marketplace_listing_title: 'no id' })).toBeNull();
    expect(
      normalizeListing({
        ...base,
        listing_price: 'weird',
        creation_time: 'yesterday',
        location: { reverse_geocode: null },
        delivery_types: ['IN_PERSON', 7],
        marketplace_listing_seller: null,
      }),
    ).toEqual({
      id: '42',
      title: 'Chair',
      price: { amount: null, formatted: '', currency: null },
      previousPrice: null,
      imageUrl: null,
      location: null,
      createdAt: null,
      status: 'unknown',
      sellerId: null,
      sellerName: null,
      deliveryTypes: ['IN_PERSON'],
      categoryId: null,
      url: 'https://www.facebook.com/marketplace/item/42/',
    });
  });

  it('formats prices when Facebook omits the display string', () => {
    expect(normalizeListing({ ...base, listing_price: { amount: '1200.00', currency: 'USD' } })?.price).toEqual({
      amount: 1200,
      formatted: '$1,200',
      currency: 'USD',
    });
    expect(normalizeListing({ ...base, listing_price: { amount_with_offset_in_currency: '1999' } })?.price.amount).toBe(19.99);
  });

  it('never throws on garbage input', () => {
    for (const junk of [null, 1, 'x', [], [[{ marketplace_listing_title: 5 }]], { marketplace_listing_title: 'x', id: {} }]) {
      expect(() => findListings(junk)).not.toThrow();
    }
  });
});

describe('extractPageInfo', () => {
  it('reads the search feed cursor', () => {
    const info = extractPageInfo(searchBlobs);
    expect(info?.hasNextPage).toBe(true);
    expect(info?.endCursor).toMatch(/^\{"pg":0/);
  });

  it('reads the home feed cursor (page_info beside the feed)', () => {
    expect(extractPageInfo(homeBlobs)).toMatchObject({ hasNextPage: true, endCursor: containing('"basic"') });
    const docs = parseGraphqlBody(fixture('home-page2.graphql.txt'));
    expect(extractPageInfo(docs)).toMatchObject({ hasNextPage: true, endCursor: containing('"item_index":6') });
  });

  it('treats a missing cursor as the last page', () => {
    expect(extractPageInfo({ feed_units: { page_info: { end_cursor: null, has_next_page: true } } })).toEqual({
      endCursor: null,
      hasNextPage: false,
    });
    expect(extractPageInfo({})).toBeNull();
  });
});

describe('search page metadata', () => {
  it('extracts the search location', () => {
    expect(extractSearchLocation(searchBlobs)).toEqual({ name: 'New York, New York', latitude: 40.7142, longitude: -74.0064, radiusKm: 65 });
    expect(extractSearchLocation(homeBlobs)).toEqual({ name: 'New York, New York', latitude: 40.7142, longitude: -74.0064, radiusKm: 65 });
    expect(extractSearchLocation({})).toBeNull();
  });

  it('identifies the feed kind and route', () => {
    expect(detectFeedKind(searchBlobs)).toBe('search');
    expect(detectFeedKind(homeBlobs)).toBe('home');
    expect(detectFeedKind(itemBlobs)).toBeNull();
    expect(extractRoutePath(searchBlobs)).toBe('/marketplace/{location_id}/search/');
  });

  it('finds the preloaded feed query', () => {
    const search = findFeedQuery(extractPreloadedQueries(searchBlobs));
    expect(search).toMatchObject({ queryName: 'CometMarketplaceSearchContentContainerQuery', queryID: '28792298773764420' });
    expect(search?.variables).toMatchObject({ count: 24, cursor: null, params: { bqf: { query: 'bike' } } });
    expect(findFeedQuery(extractPreloadedQueries(homeBlobs))?.queryName).toBe('MarketplaceCometBrowseFeedLightContainerQuery');
  });

  it('extracts request tokens', () => {
    expect(extractPageTokens(searchHtml)).toEqual({ lsd: 'AdFakeLsdTokenForTests00', fbDtsg: null, userId: '0' });
    const loggedIn =
      '["DTSGInitialData",[],{"token":"NAfdtsg:1"},258]["CurrentUserInitialData",[],{"ACCOUNT_ID":"100001","USER_ID":"100001","NAME":"X"},270]';
    expect(extractPageTokens(loggedIn)).toEqual({ lsd: null, fbDtsg: 'NAfdtsg:1', userId: '100001' });
  });

  it("computes Facebook's jazoest checksum", () => {
    // values observed on real requests
    expect(jazoest('AdS-0hm34juynpWJhQPoeviQpgk')).toBe('22487');
    expect(jazoest('AdRkgMUzyCSSKBWaasp50H17-_A')).toBe('22226');
  });
});

describe('extractListingDetail', () => {
  const detail = extractListingDetail(itemBlobs, '1631327708471334');

  it('merges the Relay fragments of the item page into a ListingDetail', () => {
    expect(detail).toMatchObject({
      id: '1631327708471334',
      title: 'Free bike lease',
      price: { amount: 0, formatted: 'Free', currency: 'USD' },
      location: 'Brooklyn, NY',
      createdAt: 1791444981000,
      status: 'available',
      description: containing('Teal step-through'),
      condition: 'Used - like new',
      attributes: [{ label: 'Condition', value: 'Used - like new' }],
      categoryName: 'Bicycles',
      categoryId: '1658310421102081',
      shippingOffered: false,
      canMessage: true,
      hasMessaged: false,
      isViewerSeller: false,
      deliveryTypes: ['IN_PERSON'],
    });
  });

  it('collects every photo (from a separate fragment) and the seller', () => {
    expect(detail?.photos).toHaveLength(9);
    expect(detail?.imageUrl).toBe(detail?.photos[0]);
    expect(detail?.seller).toEqual({
      id: 'pfbid0FAKESELLER0001',
      name: 'Seller One',
      avatarUrl: containing('fbcdn.net'),
      // this seller's ratings are private
      rating: null,
      ratingCount: null,
      joinedText: 'Joined Facebook in 2013',
    });
  });

  it('returns null for a removed listing and recognizes the error route', () => {
    expect(extractListingDetail(missingBlobs, '1631327708471399')).toBeNull();
    expect(extractErrorRoute(missingBlobs)).toBe("This content isn't available right now");
    expect(hasProductDetailsPage(missingBlobs)).toBe(false);
    expect(extractErrorRoute(itemBlobs)).toBeNull();
  });

  it('falls back to the listing the page actually rendered', () => {
    expect(extractListingDetail(itemBlobs, '999')?.id).toBe('1631327708471334');
    expect(extractListingDetail([], '1')).toBeNull();
  });

  it('reads public seller ratings', () => {
    const d = extractListingDetail(
      {
        marketplace_product_details_page: {
          target: {
            id: '7',
            marketplace_listing_title: 'Lamp',
            marketplace_listing_seller: {
              id: 's1',
              name: 'Seller One',
              marketplace_ratings_stats_by_role_v2: {
                seller_ratings_are_private: false,
                seller_stats: { five_star_ratings_average: 4.4, five_star_total_rating_count_by_role: 8 },
              },
            },
          },
        },
      },
      '7',
    );
    expect(d?.seller).toMatchObject({ rating: 4.4, ratingCount: 8, avatarUrl: null, joinedText: null });
    expect(d?.description).toBe('');
    expect(d?.photos).toEqual([]);
  });
});

describe('extractLocationOptions', () => {
  const options = extractLocationOptions(parseGraphqlBody(fixture('locations-denver.graphql.txt')));

  it('parses typeahead results', () => {
    expect(options).toHaveLength(10);
    expect(options.find((o) => o.id === '115590505119035')).toEqual({
      id: '115590505119035',
      name: 'Denver, Colorado',
      subtitle: 'City',
      latitude: 39.7391,
      longitude: -104.98360001,
    });
  });

  it('drops check-in counts from subtitles', () => {
    expect(options.find((o) => o.id === '104062792964888')?.subtitle).toBe('Downtown Denver, CO');
    expect(options.every((o) => !(o.subtitle ?? '').includes('checked in'))).toBe(true);
  });

  it('handles empty results', () => {
    expect(extractLocationOptions({ data: { city_street_search: { street_results: { edges: [] } } } })).toEqual([]);
  });
});

// ---------- domain schemas ----------

const decodeSummary = Schema.decodeUnknownSync(ListingSummary);
const decodeDetail = Schema.decodeUnknownSync(ListingDetail);
const decodeLocation = Schema.decodeUnknownSync(LocationOption);
const decodeSearchLocation = Schema.decodeUnknownSync(SearchLocationInfo);

describe('extractor output satisfies the domain schemas', () => {
  const everyListing = [
    ...findListings(searchBlobs),
    ...findListings(homeBlobs),
    ...findListings(parseGraphqlBody(fixture('search-page2.graphql.txt'))),
    ...findListings(parseGraphqlBody(fixture('home-page2.graphql.txt'))),
  ];

  it('every listing from every fixture decodes as a ListingSummary (unchanged)', () => {
    expect(everyListing.length).toBe(14 + 26 + 28 + 6);
    for (const listing of everyListing) expect(decodeSummary(listing)).toEqual(listing);
  });

  it('the item page decodes as a ListingDetail (unchanged)', () => {
    const detail = extractListingDetail(itemBlobs, '1631327708471334');
    expect(detail).not.toBeNull();
    expect(decodeDetail(detail)).toEqual(detail);
  });

  it('location options decode as LocationOption with ids usable as SearchParams.location', () => {
    const options = extractLocationOptions(parseGraphqlBody(fixture('locations-denver.graphql.txt')));
    for (const option of options) {
      expect(decodeLocation(option)).toEqual(option);
      expect(Schema.is(LocationId)(option.id)).toBe(true);
    }
  });

  it('search locations decode as SearchLocationInfo', () => {
    for (const blobs of [searchBlobs, homeBlobs]) {
      const location = extractSearchLocation(blobs);
      expect(decodeSearchLocation(location)).toEqual(location);
    }
  });
});

describe('conform (untrusted Facebook values -> domain-valid values)', () => {
  const raw = {
    id: '123',
    title: 'Desk',
    price: { amount: 20, formatted: '$20', currency: 'USD' },
    previousPrice: null,
    imageUrl: 'https://x.fbcdn.net/a.jpg',
    location: 'Brooklyn, NY',
    createdAt: 1_700_000_000_000,
    status: 'available' as const,
    sellerId: '42',
    sellerName: 'Sam',
    deliveryTypes: ['IN_PERSON'],
    categoryId: null as string | null,
    url: 'https://www.facebook.com/marketplace/item/123/',
  };

  it('clips over-long text instead of dropping the listing', () => {
    const listing = conformSummary({ ...raw, title: 'x'.repeat(2000), location: 'y'.repeat(500) });
    expect(listing?.title).toHaveLength(500);
    expect(listing?.title.endsWith('…')).toBe(true);
    expect(listing?.location).toHaveLength(200);
    expect(clip('short', 10)).toBe('short');
  });

  it('nulls out invalid optional fields', () => {
    const listing = conformSummary({
      ...raw,
      imageUrl: 'data:image/png;base64,AAAA',
      sellerId: 'has spaces and / slashes',
      price: { amount: -5, formatted: '$-5', currency: 'A-VERY-LONG-CURRENCY' },
      createdAt: Number.POSITIVE_INFINITY,
      deliveryTypes: ['', 'IN_PERSON', 'z'.repeat(80)],
      categoryId: 'c'.repeat(100),
    });
    expect(listing).toMatchObject({
      imageUrl: null,
      sellerId: null,
      price: { amount: null, formatted: '$-5', currency: null },
      createdAt: null,
      deliveryTypes: ['IN_PERSON'],
      categoryId: null,
    });
    expect(decodeSummary(listing)).toEqual(listing);
  });

  it('drops listings without a numeric id', () => {
    expect(conformSummary({ ...raw, id: 'abc' })).toBeNull();
    expect(findListings({ marketplace_listing_title: 'x', id: 'pfbid-not-numeric' })).toEqual([]);
  });

  it('keeps only http(s) photos in a detail and drops bad seller avatars', () => {
    const detail = conformDetail({
      ...raw,
      imageUrl: null,
      description: '',
      photos: ['javascript:alert(1)', 'https://x.fbcdn.net/b.jpg'],
      condition: null,
      attributes: [],
      categoryName: null,
      seller: { id: '42', name: 'Sam', avatarUrl: 'data:x', rating: Number.NaN, ratingCount: 2.5, joinedText: null },
      shippingOffered: false,
      canMessage: true,
      hasMessaged: false,
      isViewerSeller: false,
    });
    expect(detail?.photos).toEqual(['https://x.fbcdn.net/b.jpg']);
    expect(detail?.imageUrl).toBe('https://x.fbcdn.net/b.jpg');
    expect(detail?.seller).toEqual({ id: '42', name: 'Sam', avatarUrl: null, rating: null, ratingCount: null, joinedText: null });
  });

  it('drops location options whose id cannot be a search location', () => {
    expect(conformLocation({ id: 'not ok/', name: 'X', subtitle: null, latitude: null, longitude: null })).toBeNull();
    expect(conformLocation({ id: '1', name: 'X', subtitle: null, latitude: Number.NaN, longitude: 2 })).toEqual({
      id: '1',
      name: 'X',
      subtitle: null,
      latitude: null,
      longitude: 2,
    });
  });
});
