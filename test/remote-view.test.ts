// The RemoteView service against a real HEADLESS Chrome: the real Browser service, the real
// event Stream, real input dispatch, one view per browser session. The first suites serve a fake
// facebook.com from routes on every browser context (nothing leaves the machine); the last one
// opens the real logged-out Marketplace (skipped when offline). FACESLOP_SKIP_BROWSER_TESTS=1
// skips everything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, describe, layer } from '@effect/vitest';
import { Effect, Fiber, Layer, Option, Stream } from 'effect';
import type { BrowserContext, Page, Route } from 'playwright';
import { expect } from 'vitest';
import { Browser, FB_ORIGIN } from '@/server/browser/Browser';
import { AppConfig } from '@/server/config';
import { Marketplace } from '@/server/marketplace/Marketplace';
import { REMOTE_VIEWS_FULL_MESSAGE, RemoteView, type RemoteViewShape } from '@/server/remote-view/RemoteView';
import { FOCUS_HOME } from '@/server/remote-view/focus-guards';
import { ANONYMOUS_PROFILE, type ClientSessionId, type FbUserId, accountProfile, profileKey } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import { AppError } from '@/shared/errors';
import { CLOSED_REMOTE_VIEW_STATE, type RemoteStreamEvent } from '@/shared/remote-view';

const skip = process.env.FACESLOP_SKIP_BROWSER_TESTS === '1';
const none = { alt: false, ctrl: false, meta: false, shift: false };

// ---------- fakes ----------

const SESSION_A = 'session-a' as ClientSessionId;
const SESSION_B = 'session-b' as ClientSessionId;
const SESSION_C = 'session-c' as ClientSessionId;
const USER_ID = '100012345' as FbUserId;
const ACCOUNT = accountProfile(USER_ID);

const marketplaceCalls: string[] = [];
const FakeMarketplace = Layer.succeed(
  Marketplace,
  Marketplace.of({
    search: () => notImplemented('Marketplace.search'),
    searchFirstPage: () => notImplemented('Marketplace.searchFirstPage'),
    loadMore: () => notImplemented('Marketplace.loadMore'),
    closeSession: () => notImplemented('Marketplace.closeSession'),
    closeAllSessions: (profile) =>
      Effect.sync(() => {
        marketplaceCalls.push(`closeAllSessions:${profileKey(profile)}`);
      }),
    getListing: () => notImplemented('Marketplace.getListing'),
    forgetListing: (profile, id) =>
      Effect.sync(() => {
        marketplaceCalls.push(`forgetListing:${profileKey(profile)}:${id}`);
      }),
    clearListingCache: (profile) =>
      Effect.sync(() => {
        marketplaceCalls.push(`clearListingCache:${profileKey(profile)}`);
      }),
    searchLocations: () => notImplemented('Marketplace.searchLocations'),
    categories: notImplemented('Marketplace.categories'),
  }),
);

/** What closing an account view does to Marketplace (only that account). */
const accountReset = [`closeAllSessions:fb:${USER_ID}`, `clearListingCache:fb:${USER_ID}`];

const html = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0">${body}</body></html>`;

/** A listing page that records the input it receives in window.__events. */
const listingPage = (id: string) =>
  html(
    `Listing ${id} - Marketplace`,
    `<div role="main" style="height:4000px;position:relative">
      <h1 id="path">/marketplace/item/${id}/</h1>
      <textarea id="box" style="position:absolute;left:100px;top:100px;width:300px;height:100px"></textarea>
      <a id="newtab" href="/marketplace/item/456/" target="_blank" style="position:absolute;left:100px;top:300px;display:block;width:200px;height:40px">Open in a new tab</a>
      <div id="area" style="position:absolute;left:500px;top:100px;width:200px;height:200px;background:#ccc"></div>
    </div>
    <script>
      window.__events = [];
      const record = (entry) => window.__events.push(entry);
      document.getElementById('area').addEventListener('click', (e) => record('click:' + e.detail));
      document.getElementById('area').addEventListener('dblclick', () => record('dblclick'));
      document.getElementById('area').addEventListener('contextmenu', (e) => { e.preventDefault(); record('contextmenu'); });
      window.addEventListener('wheel', (e) => record('wheel:' + e.deltaY), { passive: true });
    </script>`,
  );

async function serve(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  if (!/(^|\.)facebook\.com$/.test(url.hostname)) return route.abort();
  if (request.resourceType() !== 'document') return route.fulfill({ status: 204, body: '' });
  const item = /^\/marketplace\/item\/(\d+)\/$/.exec(url.pathname);
  const body = item?.[1] !== undefined ? listingPage(item[1]) : html(`Facebook ${url.pathname}`, `<h1 id="path">${url.pathname}</h1>`);
  return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
}

/** The real Browser service, with every context it creates served by `handler` (routes registered first). */
const routedBrowser = (handler: (route: Route) => Promise<void>) =>
  Layer.effect(
    Browser,
    Effect.gen(function* () {
      const real = yield* Browser;
      const routed = new WeakSet<BrowserContext>();
      const ensure = (context: BrowserContext) =>
        Effect.promise(async () => {
          if (routed.has(context)) return;
          routed.add(context);
          await context.route('**/*', handler);
        });
      return Browser.of({
        ...real,
        withPage: (profile, use) => real.withPage(profile, (page) => Effect.andThen(ensure(page.context()), use(page))),
        openPage: (profile) => Effect.tap(real.openPage(profile), (page) => ensure(page.context())),
        loginContext: Effect.tap(real.loginContext, ensure),
        interactiveContext: (profile, options) => Effect.tap(real.interactiveContext(profile, options), ensure),
      });
    }),
  );

const configLayer = (dataDir: string, maxRemoteViews = 3) => AppConfig.layerTest({ dataDir, maxRemoteViews });

/** RemoteView over the routed real Browser (exposed, for session setup and checks). */
const remoteViewLayer = (prefix: string, options: { readonly maxRemoteViews?: number; readonly idleTimeoutMs?: number; readonly idleCheckMs?: number } = {}) => {
  const config = configLayer(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), options.maxRemoteViews);
  const browser = routedBrowser(serve).pipe(Layer.provide(Browser.layerNoDeps.pipe(Layer.provide(config))));
  return RemoteView.layerNoDeps(options).pipe(Layer.provide(Layer.mergeAll(FakeMarketplace, config)), Layer.provideMerge(browser));
};

// ---------- helpers ----------

const openPage = (view: RemoteViewShape, sessionId: ClientSessionId = SESSION_A) => Effect.map(view.page(sessionId), Option.getOrThrow);

/** The first event matching `predicate` from a fresh subscription to `sessionId`'s events. */
const nextEvent = <E extends RemoteStreamEvent>(
  view: RemoteViewShape,
  predicate: (event: RemoteStreamEvent) => event is E,
  sessionId: ClientSessionId = SESSION_A,
) => view.events(sessionId).pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow), Effect.timeout('20 seconds'));

const isFrame = (event: RemoteStreamEvent): event is Extract<RemoteStreamEvent, { _tag: 'frame' }> => event._tag === 'frame';
const stateWhere =
  (check: (state: Extract<RemoteStreamEvent, { _tag: 'state' }>) => boolean) =>
  (event: RemoteStreamEvent): event is Extract<RemoteStreamEvent, { _tag: 'state' }> =>
    event._tag === 'state' && check(event);

const poll = <A>(read: () => A | Promise<A>, expected: A, timeout = 15_000) =>
  Effect.promise(() => expect.poll(read, { timeout }).toEqual(expected));

/** Re-run `read` until `check` passes (dies after `timeoutMs`). */
const eventually = <A>(read: Effect.Effect<A>, check: (value: A) => boolean, timeoutMs = 15_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = yield* read;
      if (check(value)) return value;
      if (Date.now() > deadline) return yield* Effect.die(new Error('timed out waiting for a condition'));
      yield* Effect.sleep('100 millis');
    }
  });

const pageEvents = (page: Page) => page.evaluate(() => (window as unknown as { __events: string[] }).__events);

const fbCookie = (name: string, value: string) => ({
  name,
  value,
  domain: '.facebook.com',
  path: '/',
  expires: Math.floor(Date.now() / 1000) + 3600,
  httpOnly: true,
  secure: true,
  sameSite: 'None' as const,
});

/** Save a Facebook session for the account, as a login would. */
const giveSession = (userId: FbUserId, xs = 'x') =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* browser.loginContext;
        yield* Effect.promise(() => context.addCookies([fbCookie('c_user', userId), fbCookie('xs', xs)]));
        yield* browser.saveSession(userId, context);
      }),
    );
  });

const savedXs = (userId: FbUserId) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const cookies = yield* browser.getCookies(accountProfile(userId));
    return cookies.find((cookie) => cookie.name === 'xs')?.value ?? null;
  });

// ---------- fake facebook.com ----------

describe.skipIf(skip)('RemoteView (headless Chrome, fake facebook.com)', () => {
  layer(remoteViewLayer('faceslop-remote-view-'), { timeout: '60 seconds', excludeTestServices: true })((it) => {
    it.effect(
      'opens a listing and streams its state and frames',
      () =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          assert.deepStrictEqual(yield* view.state(SESSION_A), CLOSED_REMOTE_VIEW_STATE);
          const opened = yield* view.open(SESSION_A, ANONYMOUS_PROFILE, { target: 'listing', listingId: '123' });
          assert.deepInclude(opened, { open: true, target: 'listing', url: `${FB_ORIGIN}/marketplace/item/123/`, width: 1100, height: 860 });

          const frame = yield* nextEvent(view, isFrame);
          assert.strictEqual(frame.width, 1100);
          assert.strictEqual(frame.height, 860);
          assert.isTrue(Buffer.from(frame.data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'a JPEG');

          const titled = yield* nextEvent(view, stateWhere((s) => s.title === 'Listing 123 - Marketplace'));
          assert.strictEqual(titled.url, `${FB_ORIGIN}/marketplace/item/123/`);

          // A new subscriber starts with the current state, then the latest frame.
          const [first, second] = yield* view.events(SESSION_A).pipe(Stream.take(2), Stream.runCollect, Effect.timeout('5 seconds'));
          assert.strictEqual(first?._tag, 'state');
          assert.strictEqual(second?._tag, 'frame');
          // Other sessions have no view.
          assert.deepStrictEqual(yield* view.state(SESSION_B), CLOSED_REMOTE_VIEW_STATE);
          assert.isTrue(Option.isNone(yield* view.page(SESSION_B)));
        }),
      60_000,
    );

    it.effect(
      'dispatches mouse, wheel, key and text input',
      () =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          const page = yield* openPage(view);
          yield* Effect.promise(() => page.locator('#box').waitFor());
          const input = (event: Parameters<RemoteViewShape['input']>[1]) => view.input(SESSION_A, event);

          // Click into the text box and type (text events), with a named key in between.
          yield* input({ _tag: 'mouse', action: 'move', x: 140, y: 140, button: 'left', clickCount: 0 });
          yield* input({ _tag: 'mouse', action: 'click', x: 150, y: 150, button: 'left', clickCount: 1 });
          yield* input({ _tag: 'text', text: 'Is this still available?' });
          yield* input({ _tag: 'key', action: 'press', key: 'Enter', code: 'Enter', modifiers: none });
          yield* input({ _tag: 'text', text: 'Thanks 🙂' });
          assert.strictEqual(yield* Effect.promise(() => page.inputValue('#box')), 'Is this still available?\nThanks 🙂');

          // Select all from a Mac viewer (Cmd+A) works whatever the server's OS, then delete.
          yield* input({ _tag: 'key', action: 'press', key: 'a', code: 'KeyA', modifiers: { ...none, meta: true } });
          yield* input({ _tag: 'key', action: 'press', key: 'Backspace', modifiers: none });
          assert.strictEqual(yield* Effect.promise(() => page.inputValue('#box')), '');

          // Keys Playwright doesn't know are ignored, not errors.
          yield* input({ _tag: 'key', action: 'press', key: 'AudioVolumeMute', modifiers: none });

          // Double click (second press carries clickCount 2), right click, wheel.
          yield* input({ _tag: 'mouse', action: 'click', x: 600, y: 200, button: 'left', clickCount: 1 });
          yield* input({ _tag: 'mouse', action: 'click', x: 600, y: 200, button: 'left', clickCount: 2 });
          yield* input({ _tag: 'mouse', action: 'down', x: 600, y: 200, button: 'right', clickCount: 1 });
          yield* input({ _tag: 'mouse', action: 'up', x: 600, y: 200, button: 'right', clickCount: 1 });
          yield* input({ _tag: 'wheel', x: 600, y: 400, deltaX: 0, deltaY: 600 });
          yield* poll(() => page.evaluate(() => window.scrollY > 0), true);
          const events = yield* Effect.promise(() => pageEvents(page));
          assert.includeMembers(events, ['click:1', 'click:2', 'dblclick', 'contextmenu', 'wheel:600']);
          assert.strictEqual(events.filter((e) => e.startsWith('click:')).length, 2, 'one press per click event');

          // Coordinates outside the viewport are clamped, not rejected.
          yield* input({ _tag: 'mouse', action: 'move', x: 9999, y: 9999, button: 'left', clickCount: 0 });
          yield* input({ _tag: 'navigate', action: 'reload' });
          yield* poll(() => page.locator('#box').count(), 1);

          // A session without a view can't send input.
          const error = yield* Effect.flip(view.input(SESSION_B, { _tag: 'text', text: 'x' }));
          assert.strictEqual(error.code, 'BAD_REQUEST');
        }),
      60_000,
    );

    it.effect(
      'keeps the view on Marketplace: an SPA navigation to /watch goes back',
      () =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          const page = yield* openPage(view);
          yield* Effect.promise(() =>
            page.evaluate(() => {
              history.pushState({}, '', '/watch');
            }),
          );
          yield* poll(() => page.url(), FOCUS_HOME);
          const state = yield* nextEvent(view, stateWhere((s) => s.url === FOCUS_HOME));
          assert.strictEqual(state.target, 'listing');
          // A full load of a blocked page is turned back too.
          yield* Effect.promise(() => page.goto(`${FB_ORIGIN}/notifications/`).catch(() => null));
          yield* poll(() => page.url(), FOCUS_HOME);
        }),
      60_000,
    );

    it.effect(
      'opens popups (target=_blank links) in the view itself',
      () =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          yield* view.open(SESSION_A, ANONYMOUS_PROFILE, { target: 'listing', listingId: '123' });
          const page = yield* openPage(view);
          const box = yield* Effect.promise(() => page.locator('#newtab').boundingBox());
          assert.isNotNull(box);
          const at = { x: box.x + 20, y: box.y + 20 };
          yield* view.input(SESSION_A, { _tag: 'mouse', action: 'click', ...at, button: 'left', clickCount: 1 });
          yield* poll(() => new URL(page.url()).pathname, '/marketplace/item/456/');
          yield* poll(() => page.context().pages().length, 1);
        }),
      60_000,
    );

    it.effect('needs a Facebook session for the inbox, selling and create pages', () =>
      Effect.gen(function* () {
        const view = yield* RemoteView;
        for (const target of ['inbox', 'selling', 'create'] as const) {
          // Not logged in, and an account without a saved session.
          for (const profile of [ANONYMOUS_PROFILE, accountProfile('999' as FbUserId)]) {
            const error = yield* Effect.flip(view.open(SESSION_A, profile, { target }));
            assert.instanceOf(error, AppError);
            assert.strictEqual(error.code, 'NOT_LOGGED_IN');
          }
        }
        assert.strictEqual((yield* view.state(SESSION_A)).target, 'listing', 'the open view is untouched');
      }),
    );

    it.effect(
      're-opening navigates the open view instead of opening another',
      () =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          const before = yield* openPage(view);
          const state = yield* view.open(SESSION_A, ANONYMOUS_PROFILE, { target: 'login' });
          assert.strictEqual(state.target, 'login');
          const after = yield* openPage(view);
          assert.strictEqual(after, before);
          assert.strictEqual(new URL(after.url()).pathname, '/login/');
        }),
      60_000,
    );

    it.effect(
      'closing an anonymous view discards its cookies and leaves Marketplace alone',
      () =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          const browser = yield* Browser;
          const page = yield* openPage(view);
          // Someone logged in inside an anonymous view: not saved (only Auth's login view is).
          yield* Effect.promise(() => page.context().addCookies([fbCookie('c_user', USER_ID), fbCookie('xs', 'x')]));
          const seen = yield* view.events(SESSION_A).pipe(
            Stream.takeUntil((event) => event._tag === 'closed'),
            Stream.runCollect,
            Effect.timeout('20 seconds'),
            Effect.forkChild,
          );
          yield* Effect.sleep('200 millis');
          marketplaceCalls.length = 0;

          assert.deepStrictEqual(yield* view.close(SESSION_A), CLOSED_REMOTE_VIEW_STATE);
          const events = yield* Fiber.join(seen);
          assert.strictEqual(events.at(-1)?._tag, 'closed');
          assert.deepInclude(events.at(-2), { _tag: 'state', open: false });
          assert.deepStrictEqual(marketplaceCalls, []);
          assert.isTrue(page.isClosed());
          assert.deepStrictEqual(yield* view.state(SESSION_A), CLOSED_REMOTE_VIEW_STATE);
          assert.isTrue(Option.isNone(yield* view.page(SESSION_A)));
          assert.isFalse(yield* browser.hasSession(USER_ID));

          assert.deepStrictEqual(yield* view.close(SESSION_A), CLOSED_REMOTE_VIEW_STATE, 'closing a closed view does nothing');
          const error = yield* Effect.flip(view.input(SESSION_A, { _tag: 'text', text: 'x' }));
          assert.strictEqual(error.code, 'BAD_REQUEST');
          // New subscribers see the closed state.
          const [first] = yield* view.events(SESSION_A).pipe(Stream.take(1), Stream.runCollect, Effect.timeout('5 seconds'));
          assert.deepStrictEqual(first, { _tag: 'state', ...CLOSED_REMOTE_VIEW_STATE });
        }),
      60_000,
    );

    it.effect(
      "closing an account view saves its cookies to that account and resets only that account's Marketplace state",
      () =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          yield* giveSession(USER_ID, 'old-xs');
          yield* view.open(SESSION_A, ACCOUNT, { target: 'listing', listingId: '5' });
          const page = yield* openPage(view);
          // Facebook refreshed the session inside the view.
          yield* Effect.promise(() => page.context().addCookies([fbCookie('xs', 'new-xs')]));
          marketplaceCalls.length = 0;
          yield* view.close(SESSION_A);
          assert.deepStrictEqual(marketplaceCalls, accountReset);
          assert.strictEqual(yield* savedXs(USER_ID), 'new-xs');
          assert.strictEqual(marketplaceCalls.length, 2);
          yield* view.close(SESSION_A);
          assert.strictEqual(marketplaceCalls.length, 2, 'closing a closed view does nothing');
        }),
      60_000,
    );

    it.effect(
      "closing an account view never writes back a login the account's saved session no longer is",
      () =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          const browser = yield* Browser;
          // Facebook ended the login and it was deleted while the view was open (a session check,
          // a send that bounced, another browser's check).
          yield* giveSession(USER_ID, 'dead-xs');
          yield* view.open(SESSION_A, ACCOUNT, { target: 'listing', listingId: '5' });
          yield* browser.clearSession(USER_ID);
          yield* view.close(SESSION_A);
          assert.isFalse(yield* browser.hasSession(USER_ID), 'the dead login stays deleted');

          // A newer login (e.g. from another browser) replaced it while the view was open.
          yield* giveSession(USER_ID, 'old-xs');
          yield* view.open(SESSION_A, ACCOUNT, { target: 'listing', listingId: '5' });
          yield* giveSession(USER_ID, 'newer-xs');
          yield* view.close(SESSION_A);
          assert.strictEqual(yield* savedXs(USER_ID), 'newer-xs', 'the newer login stays');

          // A login made inside the view after its session was deleted is saved.
          yield* view.open(SESSION_A, ACCOUNT, { target: 'listing', listingId: '5' });
          yield* browser.clearSession(USER_ID);
          const page = yield* openPage(view);
          yield* Effect.promise(() => page.context().addCookies([fbCookie('xs', 'view-xs')]));
          yield* view.close(SESSION_A);
          assert.strictEqual(yield* savedXs(USER_ID), 'view-xs');
        }),
      60_000,
    );

    it.effect(
      'a different profile closes the open view and opens a new one',
      () =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          yield* view.open(SESSION_A, ANONYMOUS_PROFILE, { target: 'listing', listingId: '11' });
          const anonymous = yield* openPage(view);
          marketplaceCalls.length = 0;

          // The browser logged in to Facebook meanwhile.
          yield* view.open(SESSION_A, ACCOUNT, { target: 'listing', listingId: '11' });
          const account = yield* openPage(view);
          assert.notStrictEqual(account, anonymous);
          assert.isTrue(anonymous.isClosed());
          assert.deepStrictEqual(marketplaceCalls, [], 'an anonymous view changed no account');
          const cookies = yield* Effect.promise(() => account.context().cookies(FB_ORIGIN));
          assert.isTrue(cookies.some((cookie) => cookie.name === 'c_user' && cookie.value === USER_ID), "the account's cookies");

          // The same profile again just navigates.
          yield* view.open(SESSION_A, ACCOUNT, { target: 'inbox' });
          assert.strictEqual(yield* openPage(view), account);

          // 'login' always starts without cookies.
          yield* view.open(SESSION_A, ACCOUNT, { target: 'login' });
          const login = yield* openPage(view);
          assert.notStrictEqual(login, account);
          assert.isTrue(account.isClosed());
          assert.deepStrictEqual(marketplaceCalls, accountReset, 'the account view saved its cookies');
          const loginCookies = yield* Effect.promise(() => login.context().cookies(FB_ORIGIN));
          assert.isFalse(loginCookies.some((cookie) => cookie.name === 'c_user'));
          yield* view.close(SESSION_A);
        }),
      60_000,
    );

    it.effect(
      "going back from the view's first page stays there (never the blank start page)",
      () =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          yield* view.open(SESSION_A, ANONYMOUS_PROFILE, { target: 'listing', listingId: '321' });
          const page = yield* openPage(view);
          yield* view.input(SESSION_A, { _tag: 'navigate', action: 'back' });
          assert.strictEqual(new URL(page.url()).pathname, '/marketplace/item/321/');
          yield* view.close(SESSION_A);
        }),
      60_000,
    );

    it.effect(
      'with a session, the inbox opens; a page that dies closes the view',
      () =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          const browser = yield* Browser;
          yield* giveSession(USER_ID);
          const state = yield* view.open(SESSION_A, ACCOUNT, { target: 'inbox' });
          assert.strictEqual(state.url, `${FB_ORIGIN}/marketplace/inbox/`);
          marketplaceCalls.length = 0;
          const page = yield* openPage(view);
          yield* Effect.promise(() => page.close());
          yield* eventually(view.state(SESSION_A), (current) => !current.open);
          yield* poll(() => marketplaceCalls.length, 2);
          yield* browser.clearSession(USER_ID);
        }),
      60_000,
    );
  });

  // ---------- several sessions ----------

  layer(remoteViewLayer('faceslop-remote-sessions-', { maxRemoteViews: 2 }), { timeout: '60 seconds', excludeTestServices: true })((it) => {
    it.effect(
      "each session sees only its own view: events of A never carry B's frames or state",
      () =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          // A is watching before anything is open.
          const seenByA = yield* view.events(SESSION_A).pipe(
            Stream.takeUntil((event) => event._tag === 'closed'),
            Stream.runCollect,
            Effect.timeout('30 seconds'),
            Effect.forkChild,
          );
          yield* Effect.sleep('200 millis');

          // B opens, streams frames, navigates, closes: A hears nothing.
          yield* view.open(SESSION_B, ANONYMOUS_PROFILE, { target: 'listing', listingId: '222' });
          yield* nextEvent(view, isFrame, SESSION_B);
          yield* view.open(SESSION_B, ANONYMOUS_PROFILE, { target: 'listing', listingId: '223' });
          yield* nextEvent(view, stateWhere((s) => s.url === `${FB_ORIGIN}/marketplace/item/223/`), SESSION_B);

          // Then A opens its own view.
          yield* view.open(SESSION_A, ANONYMOUS_PROFILE, { target: 'listing', listingId: '111' });
          const pageA = yield* openPage(view, SESSION_A);
          const pageB = yield* openPage(view, SESSION_B);
          assert.notStrictEqual(pageA, pageB);
          yield* nextEvent(view, isFrame, SESSION_A);
          yield* view.close(SESSION_B);
          yield* view.close(SESSION_A);

          const events = yield* Fiber.join(seenByA);
          const states = events.filter((event) => event._tag === 'state');
          assert.deepStrictEqual(states[0], { _tag: 'state', ...CLOSED_REMOTE_VIEW_STATE }, 'A started closed');
          for (const state of states.slice(1)) {
            assert.isTrue(state.url === null || state.url === `${FB_ORIGIN}/marketplace/item/111/` || state.url === 'about:blank', `A saw ${state.url}`);
          }
          assert.isTrue(states.some((state) => state.url === `${FB_ORIGIN}/marketplace/item/111/`));
          assert.strictEqual(events.filter((event) => event._tag === 'closed').length, 1, "only A's own close");
          // Every frame A got came after A's view opened (B was streaming long before).
          const firstOpen = events.findIndex((event) => event._tag === 'state' && event.open);
          const firstFrame = events.findIndex((event) => event._tag === 'frame');
          assert.isAbove(firstFrame, firstOpen);
        }),
      60_000,
    );

    it.effect(
      "input goes to the caller's own view only",
      () =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          yield* view.open(SESSION_A, ANONYMOUS_PROFILE, { target: 'listing', listingId: '111' });
          yield* view.open(SESSION_B, ANONYMOUS_PROFILE, { target: 'listing', listingId: '222' });
          const pageA = yield* openPage(view, SESSION_A);
          const pageB = yield* openPage(view, SESSION_B);
          yield* Effect.promise(() => Promise.all([pageA.locator('#box').waitFor(), pageB.locator('#box').waitFor()]));

          yield* view.input(SESSION_B, { _tag: 'mouse', action: 'click', x: 150, y: 150, button: 'left', clickCount: 1 });
          yield* view.input(SESSION_B, { _tag: 'text', text: 'only B' });
          yield* view.input(SESSION_A, { _tag: 'mouse', action: 'click', x: 600, y: 200, button: 'left', clickCount: 1 });
          assert.strictEqual(yield* Effect.promise(() => pageB.inputValue('#box')), 'only B');
          assert.strictEqual(yield* Effect.promise(() => pageA.inputValue('#box')), '');
          assert.deepStrictEqual(yield* Effect.promise(() => pageA.evaluate(() => (window as unknown as { __events: string[] }).__events)), ['click:1']);
          assert.deepStrictEqual(yield* Effect.promise(() => pageEvents(pageB)), []);

          // Closing B leaves A alone.
          yield* view.close(SESSION_B);
          assert.isFalse(pageA.isClosed());
          assert.isTrue((yield* view.state(SESSION_A)).open);
        }),
      60_000,
    );

    it.effect(
      'at most maxRemoteViews views are open at once; a session reusing its own view is never refused',
      () =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          // A is open (previous test); B takes the second slot.
          yield* view.open(SESSION_B, ANONYMOUS_PROFILE, { target: 'listing', listingId: '222' });
          const error = yield* Effect.flip(view.open(SESSION_C, ANONYMOUS_PROFILE, { target: 'listing', listingId: '333' }));
          assert.instanceOf(error, AppError);
          assert.strictEqual(error.code, 'BAD_REQUEST');
          assert.strictEqual(error.message, REMOTE_VIEWS_FULL_MESSAGE);
          assert.isFalse((yield* view.state(SESSION_C)).open);

          // Navigating (or switching the profile of) an open view needs no new slot.
          yield* view.open(SESSION_A, ANONYMOUS_PROFILE, { target: 'login' });
          yield* giveSession(USER_ID);
          yield* view.open(SESSION_B, ACCOUNT, { target: 'inbox' });

          // A slot frees up when a view closes.
          yield* view.close(SESSION_A);
          yield* view.open(SESSION_C, ANONYMOUS_PROFILE, { target: 'listing', listingId: '333' });
          assert.isTrue((yield* view.state(SESSION_C)).open);
          yield* view.close(SESSION_B);
          yield* view.close(SESSION_C);
        }),
      60_000,
    );
  });

  layer(remoteViewLayer('faceslop-remote-idle-', { idleTimeoutMs: 1000, idleCheckMs: 200 }), {
    timeout: '60 seconds',
    excludeTestServices: true,
  })((it) => {
    it.effect(
      'closes by itself after a while without input',
      () =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          yield* view.open(SESSION_A, ANONYMOUS_PROFILE, { target: 'listing', listingId: '7' });
          yield* view.open(SESSION_B, ANONYMOUS_PROFILE, { target: 'listing', listingId: '8' });
          yield* Effect.sleep('600 millis');
          yield* view.input(SESSION_A, { _tag: 'mouse', action: 'move', x: 10, y: 10, button: 'left', clickCount: 0 });
          yield* Effect.sleep('600 millis');
          assert.isTrue((yield* view.state(SESSION_A)).open, 'input keeps it open');
          assert.isFalse((yield* view.state(SESSION_B)).open, "the other session's view had no input");
          yield* eventually(view.state(SESSION_A), (state) => !state.open, 5000);
        }),
      30_000,
    );
  });
});

// ---------- real, logged-out facebook.com ----------

/** A real listing id from test/fixtures (the listing may be gone; Facebook still serves a Marketplace page). */
const LIVE_LISTING_ID = '1631327708471334';

const liveLayer = () => {
  const config = configLayer(fs.mkdtempSync(path.join(os.tmpdir(), 'faceslop-remote-live-')));
  return RemoteView.layerNoDeps().pipe(
    Layer.provide(Layer.mergeAll(FakeMarketplace, config)),
    Layer.provideMerge(Browser.layerNoDeps.pipe(Layer.provide(config))),
  );
};

describe.skipIf(skip)('RemoteView (live, logged-out facebook.com)', () => {
  layer(liveLayer(), { timeout: '60 seconds', excludeTestServices: true })((it) => {
    it.effect(
      'streams a real Marketplace page, takes input, and keeps the SPA on Marketplace',
      (ctx) =>
        Effect.gen(function* () {
          const view = yield* RemoteView;
          yield* view.open(SESSION_A, ANONYMOUS_PROFILE, { target: 'listing', listingId: LIVE_LISTING_ID });
          const page = yield* openPage(view);
          const loaded = yield* Effect.promise(() =>
            page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).then(
              () => page.url().startsWith(FB_ORIGIN),
              () => false,
            ),
          );
          if (!loaded) {
            ctx.skip(); // offline or Facebook unreachable
            return;
          }

          const frame = yield* nextEvent(view, isFrame);
          assert.isAbove(frame.data.length, 1000);
          const state = yield* nextEvent(view, stateWhere((s) => s.url?.startsWith(`${FB_ORIGIN}/marketplace/`) === true && s.title !== ''));
          assert.strictEqual(state.target, 'listing');

          // Input reaches the page without errors (logged out, Facebook shows a login prompt).
          yield* view.input(SESSION_A, { _tag: 'mouse', action: 'click', x: 1080, y: 840, button: 'left', clickCount: 1 });
          yield* view.input(SESSION_A, { _tag: 'wheel', x: 550, y: 500, deltaX: 0, deltaY: 400 });
          yield* view.input(SESSION_A, { _tag: 'text', text: 'desk' });
          yield* view.input(SESSION_A, { _tag: 'key', action: 'press', key: 'Escape', modifiers: none });

          // Facebook's SPA router is turned back from /watch to Marketplace.
          yield* Effect.promise(() =>
            page.evaluate(() => {
              history.pushState({}, '', '/watch');
            }),
          );
          yield* poll(() => page.url().startsWith(`${FB_ORIGIN}/marketplace/`), true, 30_000);
          const back = yield* nextEvent(view, stateWhere((s) => s.url?.startsWith(`${FB_ORIGIN}/marketplace/`) === true));
          assert.isFalse(back.url?.includes('/watch'));
          yield* view.close(SESSION_A);
        }),
      120_000,
    );
  });
});
