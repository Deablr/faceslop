// Proves the error model and the per-browser data model end to end: real Start server (the
// project's vite.config.ts: Start + Nitro + React, booted by ./helpers/faceslop-http.ts), real
// HTTP, server functions decoded on the "client side" with the same Seroval plugins the browser
// uses. AppError keeps its code across the boundary. (Defect -> INTERNAL mapping is unit-tested in
// bridge.test.ts.) Nothing here contacts facebook.com: the checker is disabled and every call
// below is answered from validation or the local database.
//
// Sessions (src/server/session/identity.ts): a browser gets its faceslop_session cookie on its
// first write (never from a GET or a page: those also run during SSR, where it is too late to set
// one), and its local data (favorites, settings, hidden listings, ...) is its own until it logs in
// to Facebook. Two cookie jars here are two browsers.
import { chromium, type Browser as PlaywrightBrowser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOSED_REMOTE_VIEW_STATE } from '@/shared/remote-view';
import { DEFAULT_SETTINGS, type Favorite, type ListingSummary } from '@/shared/domain';
import { AppError, appErrorOf } from '@/shared/errors';
import { setCookieOf, startTestApp, type TestApp, type TestClient } from './helpers/faceslop-http';

let app: TestApp;
let baseUrl: string;

/** The decoded `{ result }` / `{ error }` of a call (the response must be a serialized one). */
async function callServerFn(name: string, method: 'GET' | 'POST', data?: unknown, client: TestClient = app) {
  const { response, result, error } = await client.call(name, method, data);
  expect(response.headers['x-tss-serialized']).toBe('true');
  return { result, error };
}

/** The function's result; fails the test with the error otherwise. */
async function ok(client: TestClient, name: string, method: 'GET' | 'POST', data?: unknown): Promise<unknown> {
  const { result, error } = await client.call(name, method, data);
  expect(appErrorOf(error)).toBeNull();
  return result;
}

const listing = (id: string): ListingSummary => ({
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
});

beforeAll(async () => {
  app = await startTestApp({
    modules: [
      '/src/server/functions/browse.ts',
      '/src/server/functions/messaging.ts',
      '/src/server/functions/saved-searches.ts',
      '/src/server/functions/favorites.ts',
      '/src/server/functions/settings.ts',
      '/src/server/functions/hidden.ts',
      '/src/server/functions/app-auth.ts',
      '/src/server/functions/auth.ts',
      '/src/server/functions/remote-view.ts',
    ],
    env: { APP_PASSWORD: undefined, FACESLOP_PUBLIC_URL: undefined, FACESLOP_TRUST_PROXY: undefined },
    port: 3397,
  });
  baseUrl = `http://127.0.0.1:${String(app.port)}`;
});

afterAll(async () => {
  await app.close();
});

describe('server functions over HTTP', () => {
  it('GET with invalid input -> AppError BAD_REQUEST with the schema message', async () => {
    const { error } = await callServerFn('getListing', 'GET', { id: 'not-a-number' });
    expect(error).toBeInstanceOf(AppError);
    expect(appErrorOf(error)).toEqual({ code: 'BAD_REQUEST', message: 'id: must be a numeric listing id' });
  });

  it('POST with invalid input -> AppError BAD_REQUEST', async () => {
    const { error } = await callServerFn('sendMessage', 'POST', { listingId: '123', text: '   ' });
    expect(appErrorOf(error)).toEqual({ code: 'BAD_REQUEST', message: 'text: is required' });
  });

  it('a typed AppError from a real service keeps its code across HTTP', async () => {
    const { error } = await callServerFn('runSavedSearch', 'POST', { id: 987_654 });
    expect(error).toBeInstanceOf(AppError);
    expect(appErrorOf(error)?.code).toBe('NOT_FOUND');
  });

  it('optional keys set to undefined (Seroval sends them) pass validation', async () => {
    const browser = app.browser();
    const { result, error } = await callServerFn(
      'createSavedSearch',
      'POST',
      { name: 'Bikes', params: { query: 'bike', category: undefined, radiusKm: undefined } },
      browser,
    );
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ name: 'Bikes', params: { query: 'bike' }, newCount: 0 });
    const listed = await callServerFn('listSavedSearches', 'GET', undefined, browser);
    expect(listed.result).toEqual([expect.objectContaining({ name: 'Bikes' })]);
  });

  it('a successful call returns its typed result', async () => {
    const { result, error } = await callServerFn('getLocations', 'GET', { q: 'a' });
    expect(error).toBeUndefined();
    expect(result).toEqual([]);
  });

  it('SSR renders the home page with React Aria components', async () => {
    const page = await app.send('/', { headers: { accept: 'text/html' } });
    expect(page.body).toContain('What are you looking for?');
    expect(page.body).toContain('data-rac');
  });

  it('serves the health route', async () => {
    const health = await app.send('/api/health');
    expect(JSON.parse(health.body)).toEqual({ ok: true });
  });
});

describe('browser sessions', () => {
  it('GET server functions and pages never set a cookie; a browser without one reads empty data', async () => {
    const reads: readonly (readonly [string, unknown])[] = [
      ['getSettings', DEFAULT_SETTINGS],
      ['listFavorites', []],
      ['listHidden', []],
      ['listSavedSearches', []],
      ['getAppAuthStatus', { required: false, authenticated: true }],
      ['getAuthStatus', { state: 'logged_out', userId: null, userName: null, message: null }],
      ['getRemoteViewState', CLOSED_REMOTE_VIEW_STATE],
    ];
    for (const [name, expected] of reads) {
      const { response, result, error } = await app.call(name, 'GET', name === 'getAuthStatus' ? {} : undefined);
      expect(appErrorOf(error), name).toBeNull();
      expect(result, name).toEqual(expected);
      expect(setCookieOf(response), name).toBe('');
    }
    for (const pathname of ['/', '/settings', '/saved']) {
      expect(setCookieOf(await app.send(pathname, { headers: { accept: 'text/html' } })), pathname).toBe('');
    }
  });

  it('the first write sets the session cookie (HttpOnly, SameSite=Lax, Path=/); later writes reuse and renew it', async () => {
    const browser = app.browser();
    const first = await browser.call('hideListing', 'POST', { id: '41', title: 'Lamp' });
    expect(appErrorOf(first.error)).toBeNull();
    const setCookie = setCookieOf(first.response);
    expect(setCookie).toMatch(/^faceslop_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toMatch(/Max-Age=\d{8}/);
    expect(setCookie).not.toMatch(/;\s*Secure/i); // plain http on loopback

    const second = await browser.call('hideListing', 'POST', { id: '42', title: 'Desk' });
    expect(appErrorOf(second.error)).toBeNull();
    // Same token, fresh Max-Age: a browser in use never reaches the 400-day cookie limit.
    const token = (cookie: string) => cookie.split(';')[0];
    expect(token(setCookieOf(second.response))).toBe(token(setCookie));
    expect(setCookieOf(second.response)).toMatch(/Max-Age=\d{8}/);
    expect(((await ok(browser, 'listHidden', 'GET')) as { id: string }[]).map((hidden) => hidden.id).sort()).toEqual(['41', '42']);
  });

  it("keeps each browser's favorites, settings and hidden listings to itself", async () => {
    const a = app.browser();
    const b = app.browser();

    await ok(a, 'addFavorite', 'POST', { listing: listing('100') });
    await ok(a, 'updateSettings', 'POST', { excludedKeywords: ['crib'], sessionNudgeMinutes: 15 });
    await ok(a, 'hideListing', 'POST', { id: '200', title: 'Couch' });

    // B has no cookie yet: empty.
    expect(await ok(b, 'listFavorites', 'GET')).toEqual([]);
    expect(await ok(b, 'getSettings', 'GET')).toEqual(DEFAULT_SETTINGS);
    expect(await ok(b, 'listHidden', 'GET')).toEqual([]);

    // B's own writes stay B's, and A's stay A's.
    await ok(b, 'addFavorite', 'POST', { listing: listing('101') });
    await ok(b, 'updateSettings', 'POST', { sessionNudgeMinutes: 60 });
    expect(a.cookieHeader()).not.toBe(b.cookieHeader());

    expect(((await ok(a, 'listFavorites', 'GET')) as Favorite[]).map((favorite) => favorite.listing.id)).toEqual(['100']);
    expect(((await ok(b, 'listFavorites', 'GET')) as Favorite[]).map((favorite) => favorite.listing.id)).toEqual(['101']);
    expect(await ok(a, 'getSettings', 'GET')).toMatchObject({ excludedKeywords: ['crib'], sessionNudgeMinutes: 15 });
    expect(await ok(b, 'getSettings', 'GET')).toMatchObject({ excludedKeywords: [], sessionNudgeMinutes: 60 });
    expect(((await ok(a, 'listHidden', 'GET')) as { id: string }[]).map((hidden) => hidden.id)).toEqual(['200']);
    expect(await ok(b, 'listHidden', 'GET')).toEqual([]);

    // B removing "its" copy of A's favorite changes nothing for A.
    await ok(b, 'removeFavorite', 'POST', { listingId: '100' });
    expect(((await ok(a, 'listFavorites', 'GET')) as Favorite[]).map((favorite) => favorite.listing.id)).toEqual(['100']);

    // A cookie-less request still sees nothing.
    expect(await ok(app, 'listFavorites', 'GET')).toEqual([]);
  });

  it('an unknown or forged cookie is a browser without a session', async () => {
    const headers = { cookie: 'faceslop_session=forged-token' };
    const read = await app.call('listFavorites', 'GET', undefined, headers);
    expect(read.result).toEqual([]);
    const write = await app.call('hideListing', 'POST', { id: '300', title: 'x' }, headers);
    expect(appErrorOf(write.error)).toBeNull();
    // A new session (and cookie) instead of the forged one.
    expect(setCookieOf(write.response)).toMatch(/^faceslop_session=[A-Za-z0-9_-]{43};/);
  });
});

describe('in a real (headless) browser', () => {
  it.skipIf(process.env.FACESLOP_SKIP_BROWSER_TESTS === '1')(
    'hydrates, navigates client-side, sends x-faceslop on server-function calls, and keeps its session',
    async () => {
      const browser: PlaywrightBrowser = await chromium
        .launch({ headless: true, channel: 'chrome' })
        .catch(() => chromium.launch({ headless: true }));
      try {
        const page = await browser.newPage();
        const problems: string[] = [];
        page.on('pageerror', (error) => problems.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') problems.push(message.text());
        });
        const serverFnHeaders: Record<string, string>[] = [];
        page.on('request', (request) => {
          if (request.url().includes('/_serverFn/')) serverFnHeaders.push(request.headers());
        });
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(baseUrl, { waitUntil: 'networkidle' });
        // Client-side navigation, then a mutation (adding an excluded keyword) -> server-function calls.
        await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
        await page.getByRole('heading', { level: 1, name: 'Settings' }).waitFor({ timeout: 15_000 });
        expect(new URL(page.url()).pathname).toBe('/settings');
        await page.getByPlaceholder('e.g. broken, parts only').fill('zzz-probe');
        await page.getByRole('button', { name: 'Add keyword' }).click();
        await page.getByRole('list', { name: 'Excluded keywords' }).getByText('zzz-probe').waitFor({ timeout: 10_000 });
        await page.waitForLoadState('networkidle');
        expect(serverFnHeaders.length).toBeGreaterThan(0);
        expect(serverFnHeaders.every((headers) => headers['x-faceslop'] === '1')).toBe(true);

        // The write gave this browser its session cookie: a full reload (SSR) shows its keyword.
        const cookies = await page.context().cookies(baseUrl);
        expect(cookies.find((cookie) => cookie.name === 'faceslop_session')).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
        await page.reload({ waitUntil: 'networkidle' });
        await page.getByRole('list', { name: 'Excluded keywords' }).getByText('zzz-probe').waitFor({ timeout: 10_000 });
        expect(problems).toEqual([]);
      } finally {
        await browser.close();
      }
    },
  );
});
