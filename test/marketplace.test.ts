// The Marketplace engine (search sessions, listing detail, location typeahead) driving a real
// headless Chrome against a fake facebook.com: every request to www.facebook.com is answered from
// test/fixtures (or a synthetic GraphQL response) and anything else is aborted, so nothing leaves
// the machine. Never headed. Set FACESLOP_SKIP_BROWSER_TESTS=1 where no Chrome/Chromium is installed.
// Every profile's pages come from the same fake context; which profile asked is recorded per page.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, describe, expect, layer } from '@effect/vitest';
import { Context, Effect, Fiber, Layer, Option, Schema } from 'effect';
import { chromium, type BrowserContext, type Page, type Route } from 'playwright';
import { Browser, type BrowserShape } from '@/server/browser/Browser';
import { AppConfig } from '@/server/config';
import { CATEGORIES } from '@/server/marketplace/categories';
import { extractJsonBlobs, extractPageInfo, findListings, parseGraphqlBody } from '@/server/marketplace/extract';
import { makeListingDetails } from '@/server/marketplace/listing';
import { DEFAULT_LOCATION_DOC_ID, makeLocationSearch } from '@/server/marketplace/locations';
import { Marketplace } from '@/server/marketplace/Marketplace';
import { makeSearchEngine, requestedCursor } from '@/server/marketplace/search';
import { ANONYMOUS_PROFILE, accountProfile, fbUserIdOf, profileKey, type FbProfile, type FbUserId } from '@/server/session/identity';
import { ListingDetail, ListingSummary, LocationOption } from '@/shared/domain';
import type { AppError } from '@/shared/errors';

// ---------- fixtures ----------

const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const searchHtml = fixture('search-nyc-bike.html');
const homeHtml = fixture('home-nyc.html');
const itemHtml = fixture('item.html');
const searchListingIds = findListings(extractJsonBlobs(searchHtml)).map((l) => l.id);
const homeListingIds = findListings(extractJsonBlobs(homeHtml)).map((l) => l.id);
const PAGE1_CURSOR = extractPageInfo(extractJsonBlobs(searchHtml))?.endCursor ?? 'missing';
const HOME_PAGE2 = fixture('home-page2.graphql.txt');
const HOME_PAGE2_CURSOR = extractPageInfo(parseGraphqlBody(HOME_PAGE2))?.endCursor ?? 'missing';
const DENVER = fixture('locations-denver.graphql.txt');
const SEARCH_DOC_ID = '28792298773764420';
const HOME_FEED_DOC_ID = '29458939410356522';

/** The search page plus the bit of Facebook's client we need: on scroll, request page 2 (once). */
const scrollingSearchHtml = `${searchHtml}<script>
(() => {
  let sent = false;
  addEventListener('wheel', () => {
    if (sent) return;
    sent = true;
    const name = 'CometMarketplaceSearchContentPaginationQuery';
    const body = new URLSearchParams({ __req: '1a', fb_api_req_friendly_name: name, variables: JSON.stringify({ count: 24, cursor: ${JSON.stringify(PAGE1_CURSOR)} }), doc_id: '777' });
    fetch('/api/graphql/', { method: 'POST', headers: { 'x-fb-friendly-name': name, 'x-asbd-id': '129477', 'content-type': 'application/x-www-form-urlencoded' }, body });
  });
})();
</script>`;

/** facebook.com/marketplace/ for the location helper: request tokens and a location picker that queries as you type. */
const locationPickerHtml = `<!DOCTYPE html><html><body>
<script type="application/json">{"define":[["LSD",[],{"token":"LsdTokenForLocations"},323]]}</script>
<div role="button" id="opener">Within 65 km</div>
<div role="dialog" id="picker" hidden><input aria-label="Location" type="text"></div>
<script>
document.getElementById('opener').addEventListener('click', () => { document.getElementById('picker').hidden = false; });
document.querySelector('input').addEventListener('input', (event) => {
  const name = 'MarketplaceSearchAddressDataSourceQuery';
  const body = new URLSearchParams({ fb_api_req_friendly_name: name, variables: JSON.stringify({ params: { query: event.target.value } }), doc_id: 'NEWDOC' });
  fetch('/api/graphql/', { method: 'POST', headers: { 'x-fb-friendly-name': name, 'content-type': 'application/x-www-form-urlencoded' }, body });
});
</script></body></html>`;

const userId = (value: string): FbUserId => {
  const id = fbUserIdOf(value);
  if (id === null) throw new Error(`not a Facebook user id: ${value}`);
  return id;
};
const ANON = ANONYMOUS_PROFILE;
const ALICE = accountProfile(userId('100001'));
const BOB = accountProfile(userId('100002'));

const jsonScript = (value: unknown) => `<script type="application/json">${JSON.stringify(value)}</script>`;

// ---------- the fake facebook.com ----------

interface Reply {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly delayMs?: number;
}
type PageHandler = (url: URL) => Reply;
type GraphqlHandler = (form: URLSearchParams) => Reply;

const fake = {
  /** By pathname. */
  pages: new Map<string, PageHandler>(),
  /** Answers for the next GraphQL requests, in order; then `graphqlFallback`, else HTTP 500. */
  graphql: [] as GraphqlHandler[],
  graphqlFallback: null as GraphqlHandler | null,
  pageLoads: [] as string[],
  graphqlRequests: [] as URLSearchParams[],
  pagesOpened: 0,
  /** profileKey of the profile each page was opened for, in order. */
  pageProfiles: [] as string[],
};

const page = (body: string, extra: Partial<Reply> = {}): PageHandler => () => ({ body, ...extra });
const redirect = (location: string): PageHandler => () => ({ status: 302, headers: { location } });

function resetFake(): void {
  fake.pages = new Map<string, PageHandler>([
    ['/marketplace/nyc/search/', page(scrollingSearchHtml)],
    ['/marketplace/austin/search/', page(searchHtml)],
    ['/marketplace/nyc/', page(homeHtml)],
    ['/marketplace/nyc/bicycles/', page(searchHtml)],
    ['/marketplace/nyc/notacategory/', page(homeHtml)],
    ['/marketplace/walled/search/', redirect('https://www.facebook.com/login/?next=%2Fmarketplace%2F')],
    ['/login/', page('<form id="login_form"></form>')],
    ['/marketplace/limited/search/', page('Too many requests', { status: 429 })],
    ['/marketplace/softblock/search/', page('<h2>You’re Temporarily Blocked</h2>')],
    ['/marketplace/loginwall/search/', page('<title>Facebook</title><form id="login_form" method="POST"></form>')],
    ['/marketplace/empty/search/', page('<html><body>Marketplace</body></html>')],
    [
      '/marketplace/none/search/',
      page(jsonScript({ marketplace_search: { feed_units: { edges: [], page_info: { end_cursor: 'x', has_next_page: true } } } })),
    ],
    ['/marketplace/', page(locationPickerHtml)],
    ['/marketplace/item/1631327708471334/', page(itemHtml)],
    ['/marketplace/item/1631327708471399/', page(fixture('item-missing.html'))],
    ['/marketplace/item/555/', redirect('https://www.facebook.com/marketplace/item/555/')],
    ['/marketplace/item/556/', page('<title>Facebook</title><form id="login_form" method="POST"></form>')],
    ['/marketplace/item/557/', page('<html><body>?</body></html>')],
    ['/marketplace/item/558/', redirect('https://www.facebook.com/checkpoint/123/')],
  ]);
  fake.graphql = [];
  fake.graphqlFallback = null;
  fake.pageLoads = [];
  fake.graphqlRequests = [];
  fake.pagesOpened = 0;
  fake.pageProfiles = [];
}

const json = (value: unknown): Reply => ({ body: JSON.stringify(value), headers: { 'content-type': 'application/json' } });
const listingNode = (id: string) => ({
  node: {
    listing: {
      __typename: 'GroupCommerceProductItem',
      id,
      marketplace_listing_title: `Item ${id}`,
      listing_price: { amount: '5.00', formatted_amount: '$5' },
      is_live: true,
    },
  },
});
/** A search pagination response with these listing ids. */
const feed = (ids: readonly string[], endCursor: string | null, hasNextPage = true): Reply =>
  json({ data: { marketplace_search: { feed_units: { edges: ids.map(listingNode), page_info: { end_cursor: endCursor, has_next_page: hasNextPage } } } } });
const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => String(from + i));
const answer = (...replies: Reply[]) => {
  for (const reply of replies) fake.graphql.push(() => reply);
};

async function respond(route: Route, reply: Reply): Promise<void> {
  if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
  await route.fulfill({
    status: reply.status ?? 200,
    body: reply.body ?? '',
    headers: { 'content-type': 'text/html; charset=utf-8', ...reply.headers },
  });
}

async function handle(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname !== 'www.facebook.com') {
    await route.abort();
    return;
  }
  let reply: Reply;
  if (url.pathname === '/api/graphql/' && request.method() === 'POST') {
    const form = new URLSearchParams(request.postData() ?? '');
    fake.graphqlRequests.push(form);
    const handler = fake.graphql.shift() ?? fake.graphqlFallback;
    reply = handler ? handler(form) : { status: 500, body: 'no answer' };
  } else {
    fake.pageLoads.push(url.pathname + url.search);
    reply = fake.pages.get(url.pathname)?.(url) ?? { status: 404, body: 'not found' };
  }
  // The page may have been closed meanwhile (sessions closing); nothing to answer then.
  await respond(route, reply).catch(() => undefined);
}

/** A BrowserShape over our own headless Chrome (the real one would talk to facebook.com). */
function fakeBrowser(context: BrowserContext): BrowserShape {
  const unused = (name: string) => Effect.die(new Error(`${name} is not used by the Marketplace engine`));
  const newPage = (profile: FbProfile) =>
    Effect.promise(async () => {
      const opened = await context.newPage();
      fake.pagesOpened++;
      fake.pageProfiles.push(profileKey(profile));
      return opened;
    });
  const closePage = (opened: Page) => Effect.promise(() => opened.close().catch(() => undefined));
  return {
    withPage: (profile, use) => Effect.acquireUseRelease(newPage(profile), use, closePage),
    openPage: (profile) => Effect.acquireRelease(newPage(profile), closePage),
    hasSession: () => Effect.succeed(false),
    getCookies: () => Effect.succeed([]),
    saveSession: () => unused('saveSession'),
    resetContext: () => unused('resetContext'),
    clearSession: () => unused('clearSession'),
    loginContext: unused('loginContext'),
    interactiveContext: () => unused('interactiveContext'),
  };
}

class FakeFacebook extends Context.Service<FakeFacebook, { readonly browser: BrowserShape; readonly context: BrowserContext }>()(
  'test/FakeFacebook',
) {
  static readonly layer = Layer.effect(
    FakeFacebook,
    Effect.gen(function* () {
      const launched = yield* Effect.acquireRelease(
        Effect.tryPromise(() => chromium.launch({ headless: true, channel: 'chrome' })).pipe(
          Effect.catch(() => Effect.tryPromise(() => chromium.launch({ headless: true }))),
          Effect.orDie,
        ),
        (browser) => Effect.promise(() => browser.close()),
      );
      const context = yield* Effect.promise(() => launched.newContext({ viewport: { width: 1280, height: 900 } }));
      yield* Effect.promise(() => context.route('**/*', handle));
      return { browser: fakeBrowser(context), context };
    }),
  );
}

const openPages = (context: BrowserContext) => context.pages().length;
/** Wait (polling) until `condition` holds; the test timeout bounds it. */
const until = (condition: () => boolean) =>
  Effect.gen(function* () {
    while (!condition()) yield* Effect.sleep('20 millis');
  });
const codeOf = <A>(effect: Effect.Effect<A, AppError>) => Effect.map(Effect.flip(effect), (error) => error.code);
const cursorOf = (form: URLSearchParams | undefined) => requestedCursor(form?.toString() ?? '');
const decodeSummary = Schema.decodeUnknownSync(ListingSummary);

describe.skipIf(process.env.FACESLOP_SKIP_BROWSER_TESTS === '1')('Marketplace engine (headless Chrome, fake facebook.com)', () => {
  // excludeTestServices: real clock (Playwright needs real time), not TestClock.
  layer(FakeFacebook.layer, { timeout: '60 seconds', excludeTestServices: true })((it) => {
    // ---------- search + load more ----------

    it.effect("reads page 1, then captures Facebook's own pagination request by scrolling and replays it", () =>
      Effect.gen(function* () {
        const { browser, context } = yield* FakeFacebook;
        resetFake();
        const engine = yield* makeSearchEngine(browser, { scrollCaptureMs: 5000 });

        const first = yield* engine.search(ANON, { location: 'nyc', query: 'bike' });
        expect(first.listings.map((l) => l.id)).toEqual(searchListingIds);
        expect(first.listings).toHaveLength(14);
        for (const listing of first.listings) expect(decodeSummary(listing)).toEqual(listing);
        expect(first.hasMore).toBe(true);
        expect(first.location).toEqual({ name: 'New York, New York', latitude: 40.7142, longitude: -74.0064, radiusKm: 65 });
        expect(fake.pageLoads).toEqual(['/marketplace/nyc/search/?query=bike']);
        const sessionId = first.sessionId ?? assert.fail('expected a session');
        expect(yield* engine.sessionCount()).toBe(1);

        // 1st load: the scroll makes the page ask for page 2 itself; its response is used as is.
        answer(feed(ids(9001, 12), 'c2'));
        const second = yield* engine.loadMore(ANON, sessionId);
        expect(second).toMatchObject({ sessionId, hasMore: true, location: first.location });
        expect(second.listings.map((l) => l.id)).toEqual(ids(9001, 12));
        expect(fake.graphqlRequests).toHaveLength(1);
        expect(fake.graphqlRequests[0]?.get('doc_id')).toBe('777');
        expect(cursorOf(fake.graphqlRequests[0])).toBe(PAGE1_CURSOR);

        // 2nd load: replays the captured request with the next cursor; fewer than 10 new listings
        // (one is a repeat) means it fetches another page in the same load.
        answer(feed(['9001', ...ids(9013, 3)], 'c3'), feed(ids(9016, 8), 'c4'));
        const third = yield* engine.loadMore(ANON, sessionId);
        expect(third.listings.map((l) => l.id)).toEqual([...ids(9013, 3), ...ids(9016, 8)]);
        expect(fake.graphqlRequests.slice(1).map((f) => [f.get('doc_id'), cursorOf(f), f.get('__req')])).toEqual([
          ['777', 'c2', (parseInt('1a', 36) + 1).toString(36)],
          ['777', 'c3', (parseInt('1a', 36) + 2).toString(36)],
        ]);
        expect(fake.graphqlRequests[1]?.get('x-fb-friendly-name')).toBeNull();

        // 3rd load: one page, then every strategy fails: the listings already fetched are returned.
        answer(feed(ids(9024, 2), 'c5'));
        const fourth = yield* engine.loadMore(ANON, sessionId);
        expect(fourth).toMatchObject({ sessionId, hasMore: true });
        expect(fourth.listings.map((l) => l.id)).toEqual(ids(9024, 2));
        // captured replay (c4: ok), captured replay (c5: 500), preloaded query replay (c5: 500)
        expect(fake.graphqlRequests.slice(3).map((f) => [f.get('doc_id'), cursorOf(f)])).toEqual([
          ['777', 'c4'],
          ['777', 'c5'],
          [SEARCH_DOC_ID, 'c5'],
        ]);
        expect(fake.graphqlRequests[5]?.get('lsd')).toBe('AdFakeLsdTokenForTests00');

        // 4th load: retries from the last good cursor; the feed ends, the session closes.
        answer(feed(['9026'], null, false));
        const fifth = yield* engine.loadMore(ANON, sessionId);
        expect(cursorOf(fake.graphqlRequests[6])).toBe('c5');
        expect(fifth).toMatchObject({ sessionId: null, hasMore: false });
        expect(fifth.listings.map((l) => l.id)).toEqual(['9026']);
        expect(yield* engine.sessionCount()).toBe(0);
        expect(openPages(context)).toBe(0);
        expect(yield* codeOf(engine.loadMore(ANON, sessionId))).toBe('SESSION_EXPIRED');
      }),
    );

    it.effect("falls back to the page's preloaded feed query when scrolling captures nothing", () =>
      Effect.gen(function* () {
        const { browser } = yield* FakeFacebook;
        resetFake();
        const engine = yield* makeSearchEngine(browser, { scrollCaptureMs: 1000 });
        const first = yield* engine.search(ANON, { location: 'austin', query: 'bike' });
        answer(feed(ids(8001, 10), 'c2'));
        const next = yield* engine.loadMore(ANON, first.sessionId ?? assert.fail('expected a session'));
        expect(next.listings.map((l) => l.id)).toEqual(ids(8001, 10));
        const request = fake.graphqlRequests[0];
        expect(request?.get('doc_id')).toBe(SEARCH_DOC_ID);
        expect(request?.get('fb_api_req_friendly_name')).toBe('CometMarketplaceSearchContentContainerQuery');
        expect(request?.get('lsd')).toBe('AdFakeLsdTokenForTests00');
        expect(request?.get('av')).toBe('0');
        expect(cursorOf(request)).toBe(PAGE1_CURSOR);
      }),
    );

    it.effect('reports a failed load (most relevant error first) and keeps the session for a retry', () =>
      Effect.gen(function* () {
        const { browser } = yield* FakeFacebook;
        resetFake();
        const engine = yield* makeSearchEngine(browser, { scrollCaptureMs: 5000 });
        const first = yield* engine.search(ANON, { location: 'nyc', query: 'bike' });
        const sessionId = first.sessionId ?? assert.fail('expected a session');
        fake.graphqlFallback = () => ({ status: 429 });
        const error = yield* Effect.flip(engine.loadMore(ANON, sessionId));
        expect(error).toMatchObject({ code: 'FB_BLOCKED', message: 'Facebook is rate limiting requests. Try again in a few minutes.' });
        fake.graphqlFallback = null;
        answer(feed(ids(9101, 10), 'c2'));
        const retried = yield* engine.loadMore(ANON, sessionId);
        expect(retried.listings.map((l) => l.id)).toEqual(ids(9101, 10));
        expect(cursorOf(fake.graphqlRequests.at(-1))).toBe(PAGE1_CURSOR);
      }),
    );

    it.effect('runs loadMore calls on one session one at a time', () =>
      Effect.gen(function* () {
        const { browser } = yield* FakeFacebook;
        resetFake();
        const engine = yield* makeSearchEngine(browser, { scrollCaptureMs: 5000 });
        const first = yield* engine.search(ANON, { location: 'nyc', query: 'bike' });
        const sessionId = first.sessionId ?? assert.fail('expected a session');
        answer({ ...feed(ids(7001, 10), 'cA'), delayMs: 300 }, feed(ids(7011, 10), 'cB'));
        const pages = yield* Effect.all([engine.loadMore(ANON, sessionId), engine.loadMore(ANON, sessionId)], { concurrency: 'unbounded' });
        expect(pages.flatMap((p) => p.listings.map((l) => l.id)).sort()).toEqual([...ids(7001, 10), ...ids(7011, 10)]);
        // The second load waited for the first one's cursor.
        expect(fake.graphqlRequests.map(cursorOf)).toEqual([PAGE1_CURSOR, 'cA']);
      }),
    );

    it.effect('keeps at most maxSessions sessions, closing the least recently used', () =>
      Effect.gen(function* () {
        const { browser, context } = yield* FakeFacebook;
        resetFake();
        const engine = yield* makeSearchEngine(browser, { maxSessions: 2, scrollCaptureMs: 5000 });
        const a = (yield* engine.search(ANON, { location: 'nyc', query: 'bike' })).sessionId ?? assert.fail('a');
        const b = (yield* engine.search(ANON, { location: 'nyc', query: 'bike' })).sessionId ?? assert.fail('b');
        // Using `a` makes `b` the least recently used.
        answer(feed(ids(6001, 10), 'c2'));
        yield* engine.loadMore(ANON, a);
        const c = (yield* engine.search(ANON, { location: 'nyc', query: 'bike' })).sessionId ?? assert.fail('c');
        expect(new Set([a, b, c]).size).toBe(3);
        expect(yield* engine.sessionCount()).toBe(2);
        expect(openPages(context)).toBe(2);
        expect(yield* codeOf(engine.loadMore(ANON, b))).toBe('SESSION_EXPIRED');
        answer(feed(ids(6011, 10), 'c3'));
        expect((yield* engine.loadMore(ANON, a)).listings).toHaveLength(10);
      }),
    );

    it.effect('closes idle sessions', () =>
      Effect.gen(function* () {
        const { browser, context } = yield* FakeFacebook;
        resetFake();
        const engine = yield* makeSearchEngine(browser, { sessionIdleMs: 300, sweepIntervalMs: 100 });
        const sessionId = (yield* engine.search(ANON, { location: 'nyc', query: 'bike' })).sessionId ?? assert.fail('session');
        expect(openPages(context)).toBe(1);
        yield* Effect.sleep('800 millis');
        expect(yield* engine.sessionCount()).toBe(0);
        expect(openPages(context)).toBe(0);
        expect(yield* codeOf(engine.loadMore(ANON, sessionId))).toBe('SESSION_EXPIRED');
      }),
    );

    it.effect('expires sessions whose page died (browser context reset) and on closeAllSessions', () =>
      Effect.gen(function* () {
        const { browser, context } = yield* FakeFacebook;
        resetFake();
        const engine = yield* makeSearchEngine(browser);
        const a = (yield* engine.search(ANON, { location: 'nyc', query: 'bike' })).sessionId ?? assert.fail('a');
        const b = (yield* engine.search(ANON, { location: 'nyc', query: 'bike' })).sessionId ?? assert.fail('b');
        // Login/logout resets the hidden context: every page in it closes.
        yield* Effect.promise(() => Promise.all(context.pages().map((p) => p.close())));
        expect(yield* codeOf(engine.loadMore(ANON, a))).toBe('SESSION_EXPIRED');
        const c = (yield* engine.search(ANON, { location: 'nyc', query: 'bike' })).sessionId ?? assert.fail('c');
        // Registering `c` forgot the dead `b`.
        expect(yield* engine.sessionCount()).toBe(1);
        expect(yield* codeOf(engine.loadMore(ANON, b))).toBe('SESSION_EXPIRED');
        yield* engine.closeAllSessions(ANON);
        expect(yield* engine.sessionCount()).toBe(0);
        expect(openPages(context)).toBe(0);
        expect(yield* codeOf(engine.loadMore(ANON, c))).toBe('SESSION_EXPIRED');
        // closeSession on an unknown or closed session is a no-op.
        yield* engine.closeSession(ANON, c);
        yield* engine.closeSession(ANON, 'nope');
      }),
    );

    it.effect('maps walled, blocked and unreadable pages to typed errors and closes their pages', () =>
      Effect.gen(function* () {
        const { browser, context } = yield* FakeFacebook;
        resetFake();
        const engine = yield* makeSearchEngine(browser);
        const cases = [
          [{ location: 'nyc', category: 'notacategory' }, 'BAD_REQUEST'],
          [{ location: 'walled', query: 'x' }, 'FB_BLOCKED'],
          [{ location: 'limited', query: 'x' }, 'FB_BLOCKED'],
          [{ location: 'softblock', query: 'x' }, 'FB_BLOCKED'],
          [{ location: 'loginwall', query: 'x' }, 'FB_BLOCKED'],
          [{ location: 'empty', query: 'x' }, 'FB_PARSE_FAILED'],
        ] as const;
        for (const [params, code] of cases) expect([params, yield* codeOf(engine.search(ANON, params))]).toEqual([params, code]);
        expect((yield* Effect.flip(engine.search(ANON, { location: 'nyc', category: 'notacategory' }))).message).toBe(
          'Unknown Marketplace category "notacategory".',
        );
        // No results: no session, even though Facebook still reports a next page.
        expect(yield* engine.search(ANON, { location: 'none', query: 'x' })).toEqual({ sessionId: null, listings: [], hasMore: false, location: null });
        // A real category page is a search feed.
        expect((yield* engine.search(ANON, { location: 'nyc', category: 'bicycles' })).listings).toHaveLength(14);
        yield* engine.closeAllSessions(ANON);
        expect(yield* engine.sessionCount()).toBe(0);
        expect(openPages(context)).toBe(0);
      }),
    );

    it.effect("browses the nearby feed (Today's picks) and loads more of it (cents prices on paginated cards)", () =>
      Effect.gen(function* () {
        const { browser } = yield* FakeFacebook;
        resetFake();
        const engine = yield* makeSearchEngine(browser, { scrollCaptureMs: 1000 });
        const nearby = yield* engine.search(ANON, { location: 'nyc' });
        expect(fake.pageLoads).toEqual(['/marketplace/nyc/']);
        expect(nearby.listings.map((l) => l.id)).toEqual(homeListingIds);
        expect(nearby.location?.name).toBe('New York, New York');
        answer({ body: HOME_PAGE2 });
        const more = yield* engine.loadMore(ANON, nearby.sessionId ?? assert.fail('expected a session'));
        // Page 2 repeats one listing of page 1 (1145596791359797): only the 5 new ones come back.
        const page2 = findListings(parseGraphqlBody(HOME_PAGE2));
        expect(page2).toHaveLength(6);
        expect(more.listings).toEqual(page2.filter((l) => !homeListingIds.includes(l.id)));
        expect(more.listings).toHaveLength(5);
        for (const listing of more.listings) {
          expect(decodeSummary(listing)).toEqual(listing);
          expect(listing.price.currency).toBe('USD');
        }
        // Preloaded browse-feed query for page 2; its next page failed, so the 5 came back on their own.
        expect(fake.graphqlRequests.map((f) => [f.get('doc_id'), cursorOf(f)])).toEqual([
          [HOME_FEED_DOC_ID, extractPageInfo(extractJsonBlobs(homeHtml))?.endCursor],
          [HOME_FEED_DOC_ID, HOME_PAGE2_CURSOR],
        ]);
        expect(more).toMatchObject({ hasMore: true, sessionId: nearby.sessionId });
      }),
    );

    // ---------- per-profile sessions ----------

    it.effect("keeps sessions to their profile: another profile's loadMore is SESSION_EXPIRED, its close a no-op", () =>
      Effect.gen(function* () {
        const { browser, context } = yield* FakeFacebook;
        resetFake();
        const engine = yield* makeSearchEngine(browser, { scrollCaptureMs: 5000 });
        const first = yield* engine.search(ALICE, { location: 'nyc', query: 'bike' });
        const sessionId = first.sessionId ?? assert.fail('expected a session');
        expect(fake.pageProfiles).toEqual(['fb:100001']);

        expect(yield* codeOf(engine.loadMore(BOB, sessionId))).toBe('SESSION_EXPIRED');
        expect(yield* codeOf(engine.loadMore(ANON, sessionId))).toBe('SESSION_EXPIRED');
        yield* engine.closeSession(BOB, sessionId);
        yield* engine.closeAllSessions(BOB);
        yield* engine.closeAllSessions(ANON);
        expect(yield* engine.sessionCount(ALICE)).toBe(1);
        expect(openPages(context)).toBe(1);
        // Nothing reached Facebook for the refused calls; the owner still pages on.
        expect(fake.graphqlRequests).toHaveLength(0);
        answer(feed(ids(4001, 10), 'c2'));
        expect((yield* engine.loadMore(ALICE, sessionId)).listings.map((l) => l.id)).toEqual(ids(4001, 10));

        // closeAllSessions closes only that profile's sessions.
        const bobs = (yield* engine.search(BOB, { location: 'nyc', query: 'bike' })).sessionId ?? assert.fail('bob');
        yield* engine.closeAllSessions(ALICE);
        expect(yield* engine.sessionCount(ALICE)).toBe(0);
        expect(yield* engine.sessionCount(BOB)).toBe(1);
        expect(openPages(context)).toBe(1);
        expect(yield* codeOf(engine.loadMore(ALICE, sessionId))).toBe('SESSION_EXPIRED');
        yield* engine.closeSession(BOB, bobs);
        expect(yield* engine.sessionCount()).toBe(0);
        expect(openPages(context)).toBe(0);
      }),
    );

    it.effect('caps sessions per profile and in total, closing the least recently used', () =>
      Effect.gen(function* () {
        const { browser, context } = yield* FakeFacebook;
        resetFake();
        const engine = yield* makeSearchEngine(browser, { maxSessionsPerProfile: 2, maxSessions: 3, scrollCaptureMs: 5000 });
        const open = (profile: FbProfile) =>
          Effect.map(engine.search(profile, { location: 'nyc', query: 'bike' }), (page) => page.sessionId ?? assert.fail('session'));
        const a1 = yield* open(ALICE);
        const a2 = yield* open(ALICE);
        const b1 = yield* open(BOB);
        // Alice's third session closes her least recently used one, not Bob's (older overall: a1, a2).
        const a3 = yield* open(ALICE);
        expect(yield* codeOf(engine.loadMore(ALICE, a1))).toBe('SESSION_EXPIRED');
        expect(yield* engine.sessionCount(ALICE)).toBe(2);
        expect(yield* engine.sessionCount(BOB)).toBe(1);
        // Using Bob's session makes Alice's a2 the least recently used overall.
        answer(feed(ids(3001, 10), 'c2'));
        yield* engine.loadMore(BOB, b1);
        // The pool is full (3): a fourth session, of anyone, closes the least recently used overall.
        const anon = yield* open(ANON);
        expect(yield* codeOf(engine.loadMore(ALICE, a2))).toBe('SESSION_EXPIRED');
        expect(yield* engine.sessionCount()).toBe(3);
        expect([yield* engine.sessionCount(ALICE), yield* engine.sessionCount(BOB), yield* engine.sessionCount(ANON)]).toEqual([1, 1, 1]);
        expect(openPages(context)).toBe(3);
        for (const [profile, id] of [[ALICE, a3], [BOB, b1], [ANON, anon]] as const) yield* engine.closeSession(profile, id);
        expect(openPages(context)).toBe(0);
      }),
    );

    it.effect('searchFirstPage reads page 1 in a one-shot page and keeps no session', () =>
      Effect.gen(function* () {
        const { browser, context } = yield* FakeFacebook;
        resetFake();
        const engine = yield* makeSearchEngine(browser, { maxSessions: 1 });
        const kept = (yield* engine.search(ALICE, { location: 'nyc', query: 'bike' })).sessionId ?? assert.fail('session');

        const first = yield* engine.searchFirstPage(BOB, { location: 'nyc', query: 'bike' });
        expect(first).toMatchObject({ sessionId: null, hasMore: false, location: { name: 'New York, New York' } });
        expect(first.listings.map((l) => l.id)).toEqual(searchListingIds);
        expect(fake.pageProfiles).toEqual(['fb:100001', 'fb:100002']);
        // Alice's session wasn't evicted to make room (the pool holds one).
        expect(yield* engine.sessionCount()).toBe(1);
        expect(openPages(context)).toBe(1);
        expect(yield* codeOf(engine.searchFirstPage(BOB, { location: 'walled', query: 'x' }))).toBe('FB_BLOCKED');
        expect(yield* codeOf(engine.searchFirstPage(BOB, { location: 'nyc', category: 'notacategory' }))).toBe('BAD_REQUEST');
        expect(openPages(context)).toBe(1);
        yield* engine.closeSession(ALICE, kept);
      }),
    );

    // ---------- listing detail ----------

    it.effect('loads a listing once: concurrent callers share the lookup, later ones hit the cache, everyone gets a copy', () =>
      Effect.gen(function* () {
        const { browser, context } = yield* FakeFacebook;
        resetFake();
        fake.pages.set('/marketplace/item/1631327708471334/', page(itemHtml, { delayMs: 200 }));
        const details = yield* makeListingDetails(browser);
        const [a, b] = yield* Effect.all([details.getListing(ANON, '1631327708471334'), details.getListing(ANON, '1631327708471334')], {
          concurrency: 'unbounded',
        });
        expect(fake.pageLoads).toEqual(['/marketplace/item/1631327708471334/']);
        expect(Schema.decodeUnknownSync(ListingDetail)(a)).toEqual(a);
        expect(a).toMatchObject({ id: '1631327708471334', title: 'Free bike lease', canMessage: true, condition: 'Used - like new' });
        expect(a.photos).toHaveLength(9);
        expect(b).toEqual(a);
        expect(b).not.toBe(a);

        // A caller's tweak never reaches the cache.
        Object.assign(a, { title: 'changed', canMessage: false });
        const again = yield* details.getListing(ANON, ' 1631327708471334 ');
        expect(again).toMatchObject({ title: 'Free bike lease', canMessage: true });
        expect(fake.pageLoads).toHaveLength(1);
        expect(openPages(context)).toBe(0);

        yield* details.forgetListing(ANON, '1631327708471334');
        yield* details.getListing(ANON, '1631327708471334');
        expect(fake.pageLoads).toHaveLength(2);
        yield* details.clearCache(ANON);
        yield* details.getListing(ANON, '1631327708471334');
        expect(fake.pageLoads).toHaveLength(3);

        for (const bad of ['abc', '12a', '', '1'.repeat(21)]) expect(yield* codeOf(details.getListing(ANON, bad))).toBe('BAD_REQUEST');
        expect(fake.pageLoads).toHaveLength(3);
      }),
    );

    it.effect('NOT_FOUND for removed listings and redirect loops, typed errors otherwise; failures are not cached', () =>
      Effect.gen(function* () {
        const { browser, context } = yield* FakeFacebook;
        resetFake();
        const details = yield* makeListingDetails(browser);
        expect(yield* Effect.flip(details.getListing(ANON, '1631327708471399'))).toMatchObject({
          code: 'NOT_FOUND',
          message: 'This listing is no longer available on Facebook.',
        });
        expect(yield* codeOf(details.getListing(ANON, '1631327708471399'))).toBe('NOT_FOUND');
        expect(fake.pageLoads.filter((p) => p.includes('1631327708471399'))).toHaveLength(2);
        expect(yield* codeOf(details.getListing(ANON, '555'))).toBe('NOT_FOUND');
        expect(yield* codeOf(details.getListing(ANON, '556'))).toBe('FB_BLOCKED');
        expect(yield* codeOf(details.getListing(ANON, '557'))).toBe('FB_PARSE_FAILED');
        expect(yield* codeOf(details.getListing(ANON, '558'))).toBe('FB_BLOCKED');
        expect(openPages(context)).toBe(0);
      }),
    );

    it.effect('caches listings per profile: each profile loads its own view, forget/clear touch only theirs', () =>
      Effect.gen(function* () {
        const { browser } = yield* FakeFacebook;
        resetFake();
        const details = yield* makeListingDetails(browser);
        const id = '1631327708471334';
        const loads = () => fake.pageLoads.filter((p) => p.startsWith('/marketplace/item/')).length;
        yield* details.getListing(ALICE, id);
        yield* details.getListing(BOB, id);
        yield* details.getListing(ALICE, id);
        yield* details.getListing(BOB, id);
        expect(loads()).toBe(2);
        expect(fake.pageProfiles).toEqual(['fb:100001', 'fb:100002']);

        yield* details.forgetListing(BOB, id);
        yield* details.getListing(ALICE, id);
        expect(loads()).toBe(2);
        yield* details.getListing(BOB, id);
        expect(loads()).toBe(3);

        yield* details.getListing(ANON, id);
        yield* details.clearCache(ALICE);
        yield* details.getListing(BOB, id);
        yield* details.getListing(ANON, id);
        expect(loads()).toBe(4);
        yield* details.getListing(ALICE, id);
        expect(loads()).toBe(5);
        expect(fake.pageProfiles.slice(2)).toEqual(['fb:100002', 'anonymous', 'fb:100001']);
      }),
    );

    it.effect('expires cached listings after the time to live', () =>
      Effect.gen(function* () {
        const { browser } = yield* FakeFacebook;
        resetFake();
        const details = yield* makeListingDetails(browser, { timeToLive: '300 millis' });
        yield* details.getListing(ANON, '1631327708471334');
        yield* details.getListing(ANON, '1631327708471334');
        expect(fake.pageLoads).toHaveLength(1);
        yield* Effect.sleep('400 millis');
        yield* details.getListing(ANON, '1631327708471334');
        expect(fake.pageLoads).toHaveLength(2);
      }),
    );

    // ---------- locations ----------

    /** Answers the typeahead query only for this doc id (Facebook rotates them). */
    const typeaheadFor = (docId: string): GraphqlHandler => (form) =>
      form.get('doc_id') === docId ? { body: DENVER } : json({ errors: [{ message: 'PersistedQueryNotFound' }] });

    it.effect('replays the typeahead query from a warm page, caches case-insensitively, de-duplicates lookups', () =>
      Effect.gen(function* () {
        const { browser } = yield* FakeFacebook;
        resetFake();
        fake.graphqlFallback = typeaheadFor(DEFAULT_LOCATION_DOC_ID);
        const locations = yield* makeLocationSearch(browser);
        const options = yield* locations.searchLocations('  Denver ');
        expect(options).toHaveLength(10);
        expect(options[0]?.subtitle).toBe('City');
        expect(options.find((o) => o.id === '115590505119035')).toEqual({
          id: '115590505119035',
          name: 'Denver, Colorado',
          subtitle: 'City',
          latitude: 39.7391,
          longitude: -104.98360001,
        });
        for (const option of options) expect(Schema.decodeUnknownSync(LocationOption)(option)).toEqual(option);
        const request = fake.graphqlRequests[0];
        expect(request?.get('fb_api_req_friendly_name')).toBe('MarketplaceSearchAddressDataSourceQuery');
        expect(request?.get('doc_id')).toBe(DEFAULT_LOCATION_DOC_ID);
        expect(request?.get('lsd')).toBe('LsdTokenForLocations');
        expect(request?.get('variables')).toContain('"query":"Denver"');
        expect(fake.pageLoads).toEqual(['/marketplace/']);

        expect(yield* locations.searchLocations('denver')).toEqual(options);
        expect(yield* locations.searchLocations('D')).toEqual([]);
        expect(yield* codeOf(locations.searchLocations('x'.repeat(101)))).toBe('BAD_REQUEST');
        expect(fake.graphqlRequests).toHaveLength(1);

        yield* Effect.all([locations.searchLocations('Boulder'), locations.searchLocations('boulder')], { concurrency: 'unbounded' });
        expect(fake.graphqlRequests).toHaveLength(2);
        // Still the same warm helper page.
        expect(fake.pageLoads).toEqual(['/marketplace/']);
        expect(fake.pagesOpened).toBe(1);
      }),
    );

    it.effect("falls back to Marketplace's location dialog when the replay fails, and learns the new doc id", () =>
      Effect.gen(function* () {
        const { browser } = yield* FakeFacebook;
        resetFake();
        fake.graphqlFallback = typeaheadFor('NEWDOC');
        const locations = yield* makeLocationSearch(browser, { dialogTimeoutMs: 5000 });
        const options = yield* locations.searchLocations('Austin');
        expect(options).toHaveLength(10);
        expect(yield* locations.docId).toBe('NEWDOC');
        // The helper page, then the same page reloaded for the dialog.
        expect(fake.pageLoads).toEqual(['/marketplace/', '/marketplace/']);
        expect(fake.graphqlRequests.at(-1)?.get('variables')).toContain('"query":"Austin"');

        const before = fake.graphqlRequests.length;
        yield* locations.searchLocations('Paris');
        expect(fake.graphqlRequests.slice(before).map((f) => f.get('doc_id'))).toEqual(['NEWDOC']);
        expect(fake.pageLoads).toHaveLength(2);
      }),
    );

    it.effect('does not click around a block, and does not cache failures', () =>
      Effect.gen(function* () {
        const { browser } = yield* FakeFacebook;
        resetFake();
        fake.graphqlFallback = () => ({ status: 429 });
        const locations = yield* makeLocationSearch(browser);
        expect(yield* codeOf(locations.searchLocations('Denver'))).toBe('FB_BLOCKED');
        expect(fake.pageLoads).toEqual(['/marketplace/']);
        fake.graphqlFallback = typeaheadFor(DEFAULT_LOCATION_DOC_ID);
        expect(yield* locations.searchLocations('Denver')).toHaveLength(10);
      }),
    );

    it.effect('retries on a fresh helper page when a session change closes it in the middle of a lookup', () =>
      Effect.gen(function* () {
        const { browser, context } = yield* FakeFacebook;
        resetFake();
        // The first replay is slow; the helper page closes while it is in flight.
        fake.graphql.push(() => ({ body: DENVER, delayMs: 1500 }));
        fake.graphqlFallback = typeaheadFor(DEFAULT_LOCATION_DOC_ID);
        const locations = yield* makeLocationSearch(browser);
        const pending = yield* Effect.forkChild(locations.searchLocations('Denver'));
        yield* until(() => fake.graphqlRequests.length === 1);
        yield* locations.closeHelper;
        const options = yield* Fiber.join(pending);
        expect(options).toHaveLength(10);
        // No dialog fallback on the dead page: a fresh helper, then the same replay again.
        expect(fake.pageLoads).toEqual(['/marketplace/', '/marketplace/']);
        expect(fake.graphqlRequests.map((f) => f.get('doc_id'))).toEqual([DEFAULT_LOCATION_DOC_ID, DEFAULT_LOCATION_DOC_ID]);
        expect(fake.pagesOpened).toBe(2);
        expect(openPages(context)).toBe(1);
        yield* locations.closeHelper;
      }),
    );

    it.effect('closes the helper page when idle and opens a fresh one for the next lookup', () =>
      Effect.gen(function* () {
        const { browser, context } = yield* FakeFacebook;
        resetFake();
        fake.graphqlFallback = typeaheadFor(DEFAULT_LOCATION_DOC_ID);
        const locations = yield* makeLocationSearch(browser, { helperIdleMs: 300, helperSweepMs: 100 });
        yield* locations.searchLocations('Denver');
        expect(openPages(context)).toBe(1);
        yield* Effect.sleep('800 millis');
        expect(openPages(context)).toBe(0);
        yield* locations.searchLocations('Boulder');
        expect(fake.pagesOpened).toBe(2);
        yield* locations.closeHelper;
        expect(openPages(context)).toBe(0);
      }),
    );

    // ---------- the service ----------

    it.effect('Marketplace service: categories, the configured doc id, anonymous locations, closeAllSessions/clearListingCache per profile', () =>
      Effect.gen(function* () {
        const { browser, context } = yield* FakeFacebook;
        resetFake();
        fake.graphqlFallback = typeaheadFor('CONFIGURED');
        const dataDir = path.join(os.tmpdir(), 'faceslop-marketplace-test');
        const service = Marketplace.layerNoDeps.pipe(
          Layer.provide([Layer.succeed(Browser, browser), AppConfig.layerTest({ dataDir, locationDocId: Option.some('CONFIGURED') })]),
        );
        yield* Effect.gen(function* () {
          const marketplace = yield* Marketplace;
          expect(yield* marketplace.categories).toEqual(CATEGORIES);
          expect(yield* codeOf(marketplace.getListing(ALICE, 'abc'))).toBe('BAD_REQUEST');

          expect(yield* marketplace.searchLocations('Denver')).toHaveLength(10);
          expect(fake.graphqlRequests.map((f) => f.get('doc_id'))).toEqual(['CONFIGURED']);
          // Location lookups never carry an account's cookies.
          expect(fake.pageProfiles).toEqual(['anonymous']);

          yield* marketplace.getListing(ALICE, '1631327708471334');
          yield* marketplace.getListing(BOB, '1631327708471334');
          const alices = yield* marketplace.search(ALICE, { location: 'nyc', query: 'bike' });
          const bobs = yield* marketplace.search(BOB, { location: 'nyc', query: 'bike' });
          expect(fake.pageProfiles.slice(1)).toEqual(['fb:100001', 'fb:100002', 'fb:100001', 'fb:100002']);
          expect(openPages(context)).toBe(3);
          // Alice logs out: her search pages close and her cached details go; Bob keeps his, and
          // the (anonymous) location helper stays warm.
          yield* marketplace.closeAllSessions(ALICE);
          yield* marketplace.clearListingCache(ALICE);
          expect(openPages(context)).toBe(2);
          expect(yield* codeOf(marketplace.loadMore(ALICE, alices.sessionId ?? 'none'))).toBe('SESSION_EXPIRED');
          answer(feed(ids(5001, 10), 'c2'));
          expect((yield* marketplace.loadMore(BOB, bobs.sessionId ?? 'none')).listings).toHaveLength(10);
          yield* marketplace.getListing(ALICE, '1631327708471334');
          yield* marketplace.getListing(BOB, '1631327708471334');
          expect(fake.pageLoads.filter((p) => p.startsWith('/marketplace/item/'))).toHaveLength(3);

          // searchFirstPage through the service: no session.
          const first = yield* marketplace.searchFirstPage(BOB, { location: 'nyc', query: 'bike' });
          expect(first).toMatchObject({ sessionId: null, hasMore: false });
          expect(openPages(context)).toBe(2);
        }).pipe(Effect.provide(service));
        // Disposing the layer closed everything.
        expect(openPages(context)).toBe(0);
      }),
    );
  });
});
