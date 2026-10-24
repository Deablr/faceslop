// Local-data server functions over real HTTP (port of the parts of legacy/test/server.test.ts that
// need no Facebook): validation errors, settings, favorites, hidden listings, blocked sellers,
// saved-search CRUD, and the browse functions' input handling. The Facebook-backed behavior (search
// filtering, run-now, seeding) is covered with a fake Marketplace in test/filters.test.ts and
// test/checker.test.ts. FACESLOP_DISABLE_CHECKER=1, so creating a saved search doesn't seed (no
// background Facebook traffic from tests).
//
// Every call goes through one browser (cookie jar): local data belongs to the browser's session,
// created by its first write. Isolation between browsers is tested in test/server-fn-http.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Favorite, type ListingSummary, type SavedSearch } from '@/shared/domain';
import { appErrorOf } from '@/shared/errors';
import { startTestApp, type TestApp, type TestBrowser } from './helpers/faceslop-http';

let app: TestApp;
/** The browser every call below comes from. */
let browser: TestBrowser;

const listing = (id: string, overrides: Partial<ListingSummary> = {}): ListingSummary => ({
  id,
  title: `Listing ${id}`,
  price: { amount: 100, formatted: '$100', currency: 'USD' },
  previousPrice: null,
  imageUrl: 'https://scontent.example/img.jpg',
  location: 'Brooklyn, NY',
  createdAt: null,
  status: 'available',
  sellerId: `seller${id}`,
  sellerName: 'Sam',
  deliveryTypes: ['IN_PERSON'],
  categoryId: null,
  url: `https://www.facebook.com/marketplace/item/${id}/`,
  ...overrides,
});

/** The function's result; fails the test with the error otherwise. */
async function ok(name: string, method: 'GET' | 'POST', data?: unknown): Promise<unknown> {
  const { result, error } = await browser.call(name, method, data);
  expect(appErrorOf(error)).toBeNull();
  return result;
}

/** The function's AppError (code + message). */
async function failure(name: string, method: 'GET' | 'POST', data?: unknown) {
  const { error } = await browser.call(name, method, data);
  const info = appErrorOf(error);
  expect(info).not.toBeNull();
  return info;
}

const pause = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 3);
  });

beforeAll(async () => {
  app = await startTestApp({
    modules: [
      '/src/server/functions/browse.ts',
      '/src/server/functions/favorites.ts',
      '/src/server/functions/hidden.ts',
      '/src/server/functions/blocked-sellers.ts',
      '/src/server/functions/settings.ts',
      '/src/server/functions/saved-searches.ts',
      '/src/server/functions/app-auth.ts',
    ],
    env: { APP_PASSWORD: undefined, FACESLOP_PUBLIC_URL: undefined, FACESLOP_TRUST_PROXY: undefined },
    port: 3331,
  });
  browser = app.browser();
});

afterAll(async () => {
  await app.close();
});

describe('browse input handling (no Facebook calls)', () => {
  it('maps invalid search params to BAD_REQUEST with a readable message', async () => {
    expect((await failure('search', 'GET', { radiusKm: 9000 }))?.message).toMatch(/^radiusKm: /);
    expect(await failure('search', 'GET', { minPrice: 500, maxPrice: 100 })).toEqual({
      code: 'BAD_REQUEST',
      message: 'minPrice: must not be more than maxPrice',
    });
    for (const params of [{ minPrice: -1 }, { minPrice: 10.5 }, { daysSinceListed: 2 }, { conditions: ['mint'] }, { sortBy: 'random' }, { location: '../etc' }]) {
      expect((await failure('search', 'GET', params))?.code).toBe('BAD_REQUEST');
    }
  });

  it('rejects bad listing ids and session ids', async () => {
    expect((await failure('getListing', 'GET', { id: 'a b' }))?.code).toBe('BAD_REQUEST');
    expect((await failure('loadMore', 'POST', { sessionId: '../x' }))?.code).toBe('BAD_REQUEST');
  });

  it('needs two characters to look up locations', async () => {
    expect(await ok('getLocations', 'GET', { q: 'd' })).toEqual([]);
    expect(await ok('getLocations', 'GET', { q: '  d  ' })).toEqual([]);
    expect(await ok('getLocations', 'GET', { q: '' })).toEqual([]);
  });
});

describe('settings', () => {
  it('returns defaults', async () => {
    expect(await ok('getSettings', 'GET')).toEqual(DEFAULT_SETTINGS);
  });

  it('normalizes keywords and merges partial updates', async () => {
    expect(
      await ok('updateSettings', 'POST', { excludedKeywords: [' Crib ', 'crib', 'FREE  Kittens', ''], checkIntervalMinutes: 0 }),
    ).toMatchObject({ excludedKeywords: ['crib', 'free kittens'], checkIntervalMinutes: 0, sessionNudgeMinutes: 30 });
    expect(await ok('updateSettings', 'POST', { defaultLocation: { id: '115590505119035', name: 'Brooklyn, NY' }, defaultRadiusKm: 20 })).toMatchObject({
      excludedKeywords: ['crib', 'free kittens'],
      defaultLocation: { id: '115590505119035', name: 'Brooklyn, NY' },
      defaultRadiusKm: 20,
    });
    expect(await ok('updateSettings', 'POST', { defaultLocation: null, defaultRadiusKm: null })).toMatchObject({
      defaultLocation: null,
      defaultRadiusKm: null,
    });
    expect(await ok('getSettings', 'GET')).toMatchObject({ excludedKeywords: ['crib', 'free kittens'], checkIntervalMinutes: 0 });
  });

  it.each([
    { checkIntervalMinutes: 10 },
    { checkIntervalMinutes: 1441 },
    { sessionNudgeMinutes: 241 },
    { defaultRadiusKm: 0 },
    { defaultRadiusKm: 501 },
    { excludedKeywords: Array.from({ length: 101 }, (_, i) => `word${String(i)}`) },
    { desktopNotifications: 'yes' },
    { defaultLocation: { id: '../x', name: 'x' } },
  ])('rejects %o', async (patch) => {
    expect((await failure('updateSettings', 'POST', patch))?.code).toBe('BAD_REQUEST');
  });

  it('accepts the boundaries', async () => {
    for (const patch of [{ checkIntervalMinutes: 15 }, { checkIntervalMinutes: 1440 }, { sessionNudgeMinutes: 240 }, { defaultRadiusKm: 500 }]) {
      expect(await ok('updateSettings', 'POST', patch)).toMatchObject(patch);
    }
  });
});

describe('favorites, hidden, blocked sellers', () => {
  it('stores favorites with their original price, newest first; deletes idempotently', async () => {
    const first = (await ok('addFavorite', 'POST', { listing: listing('1'), note: '  ' })) as Favorite;
    expect(first).toMatchObject({ originalPrice: { amount: 100 }, note: null, lastCheckedAt: null });
    await pause();
    await ok('addFavorite', 'POST', { listing: listing('2'), note: ' call first ' });
    const list = (await ok('listFavorites', 'GET')) as Favorite[];
    expect(list.map((f) => f.listing.id)).toEqual(['2', '1']);
    expect(list[0]?.note).toBe('call first');

    // Re-favoriting keeps savedAt and the original price.
    const again = (await ok('addFavorite', 'POST', { listing: listing('1', { price: { amount: 60, formatted: '$60', currency: 'USD' } }) })) as Favorite;
    expect(again).toMatchObject({ savedAt: first.savedAt, originalPrice: { amount: 100 }, listing: { price: { amount: 60 } } });

    expect(await ok('removeFavorite', 'POST', { listingId: '1' })).toEqual({ ok: true });
    expect(await ok('removeFavorite', 'POST', { listingId: '1' })).toEqual({ ok: true });
    expect(((await ok('listFavorites', 'GET')) as Favorite[]).map((f) => f.listing.id)).toEqual(['2']);
  });

  it('validates favorite listings', async () => {
    expect((await failure('addFavorite', 'POST', { listing: { id: '1' } }))?.code).toBe('BAD_REQUEST');
    expect((await failure('addFavorite', 'POST', { listing: listing('1', { url: 'javascript:alert(1)' }) }))?.code).toBe('BAD_REQUEST');
  });

  it('hides, unhides and clears listings', async () => {
    expect(await ok('hideListing', 'POST', { id: '5', title: ' Couch ' })).toMatchObject({ id: '5', title: 'Couch' });
    await pause();
    await ok('hideListing', 'POST', { id: '6' });
    const hidden = (await ok('listHidden', 'GET')) as { id: string; title: string }[];
    expect(hidden).toMatchObject([{ id: '6', title: '' }, { id: '5' }]);
    expect(await ok('unhideListing', 'POST', { id: '5' })).toEqual({ ok: true });
    expect(await ok('unhideListing', 'POST', { id: '5' })).toEqual({ ok: true });
    expect(((await ok('listHidden', 'GET')) as { id: string }[]).map((h) => h.id)).toEqual(['6']);
    expect(await ok('clearHidden', 'POST')).toEqual({ ok: true });
    expect(await ok('listHidden', 'GET')).toEqual([]);
    expect((await failure('hideListing', 'POST', { id: 'abc' }))?.code).toBe('BAD_REQUEST');
  });

  it('blocks and unblocks sellers', async () => {
    expect(await ok('blockSeller', 'POST', { id: '777', name: 'Spam' })).toMatchObject({ id: '777', name: 'Spam' });
    expect(((await ok('listBlockedSellers', 'GET')) as unknown[]).length).toBe(1);
    expect(await ok('unblockSeller', 'POST', { id: '777' })).toEqual({ ok: true });
    expect(await ok('unblockSeller', 'POST', { id: '777' })).toEqual({ ok: true });
    expect(await ok('listBlockedSellers', 'GET')).toEqual([]);
    expect((await failure('blockSeller', 'POST', { id: 'a b', name: 'x' }))?.code).toBe('BAD_REQUEST');
  });
});

describe('saved searches', () => {
  it('creates (trimmed name, autoCheck on by default, nothing new yet), lists, patches, deletes', async () => {
    const created = (await ok('createSavedSearch', 'POST', { name: ' Bikes ', params: { query: ' bike ', conditions: ['new', 'new'] } })) as SavedSearch;
    expect(created).toMatchObject({
      name: 'Bikes',
      params: { query: 'bike', conditions: ['new'] },
      autoCheck: true,
      newCount: 0,
      lastViewedAt: null,
      lastCheckedAt: null,
    });
    await pause();
    const manual = (await ok('createSavedSearch', 'POST', { name: 'Desks', params: {}, autoCheck: false })) as SavedSearch;
    expect(manual.autoCheck).toBe(false);
    expect(((await ok('listSavedSearches', 'GET')) as SavedSearch[]).map((s) => s.id)).toEqual([manual.id, created.id]);

    const renamed = (await ok('updateSavedSearch', 'POST', { id: created.id, patch: { name: 'Road bikes' } })) as SavedSearch;
    expect(renamed).toMatchObject({ name: 'Road bikes', params: { query: 'bike', conditions: ['new'] } });
    const changed = (await ok('updateSavedSearch', 'POST', { id: created.id, patch: { params: { query: 'road bike', maxPrice: 300 } } })) as SavedSearch;
    expect(changed).toMatchObject({ params: { query: 'road bike', maxPrice: 300 }, lastViewedAt: null });

    expect(await ok('deleteSavedSearch', 'POST', { id: created.id })).toEqual({ ok: true });
    expect(await ok('deleteSavedSearch', 'POST', { id: created.id })).toEqual({ ok: true });
    expect(((await ok('listSavedSearches', 'GET')) as SavedSearch[]).map((s) => s.id)).toEqual([manual.id]);
  });

  it('validates input and reports unknown ids as NOT_FOUND', async () => {
    expect((await failure('createSavedSearch', 'POST', { name: '', params: {} }))?.code).toBe('BAD_REQUEST');
    expect((await failure('createSavedSearch', 'POST', { name: 'x', params: { radiusKm: 0 } }))?.message).toMatch(/^params\.radiusKm: /);
    expect(await failure('runSavedSearch', 'POST', { id: 999 })).toEqual({ code: 'NOT_FOUND', message: 'That saved search no longer exists.' });
    expect((await failure('updateSavedSearch', 'POST', { id: 999, patch: { name: 'x' } }))?.code).toBe('NOT_FOUND');
    expect((await failure('updateSavedSearch', 'POST', { id: 'abc', patch: { name: 'x' } }))?.code).toBe('BAD_REQUEST');
    expect(await ok('deleteSavedSearch', 'POST', { id: 999 })).toEqual({ ok: true });
  });
});

describe('app auth without a password', () => {
  it('is open', async () => {
    expect(await ok('getAppAuthStatus', 'GET')).toEqual({ required: false, authenticated: true });
    expect(await ok('appLogin', 'POST', { password: 'anything' })).toEqual({ required: false, authenticated: true });
    expect(await ok('appLogout', 'POST')).toEqual({ required: false, authenticated: true });
  });
});
