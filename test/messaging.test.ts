// The Messaging service: input checks and the login requirement (no session file for the account,
// so no browser starts), then a real send through the service against the composer fixture served
// as a fake facebook.com listing in HEADLESS Chrome. Port of legacy/test/messaging.test.ts, plus
// the service-level behavior (one send per account and listing, forgetting the account's cached
// listing, a dead session, which an open remote view of the account must not bring back).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, describe, layer } from '@effect/vitest';
import { Effect, Fiber, Layer } from 'effect';
import type { BrowserContext, Route } from 'playwright';
import { Browser } from '@/server/browser/Browser';
import { AppConfig } from '@/server/config';
import { Marketplace } from '@/server/marketplace/Marketplace';
import { friendlyName } from '@/server/messaging/composer';
import { Messaging } from '@/server/messaging/Messaging';
import { RemoteView } from '@/server/remote-view/RemoteView';
import { type ClientSessionId, type FbUserId, accountProfile, profileKey } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import { MAX_MESSAGE_LENGTH } from '@/shared/domain';
import { AppError } from '@/shared/errors';

const skip = process.env.FACESLOP_SKIP_BROWSER_TESTS === '1';
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const LISTING_ID = '1234567890';
const MESSAGE = 'Hi! Is the desk still available? I could pick it up Saturday morning.';
const USER_ID = '100012345' as FbUserId;
const OTHER_ID = '100067890' as FbUserId;
const SESSION = 'session-a' as ClientSessionId;

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

// ---------- fake facebook.com ----------

const fake = { loggedIn: true, graphqlNames: [] as string[] };

async function serve(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname !== 'www.facebook.com') return route.abort();
  if (url.pathname === '/api/graphql/') {
    fake.graphqlNames.push(friendlyName(request.headers(), request.postData()) ?? '?');
    return route.fulfill({ contentType: 'application/json', body: '{"data":{"marketplace_send_message":{"id":"m1"}}}' });
  }
  if (request.resourceType() !== 'document') return route.fulfill({ status: 404, body: '' });
  const page = (body: string) => route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  if (url.pathname === `/marketplace/item/${LISTING_ID}/`) return page(fs.readFileSync(path.join(FIXTURES, 'messaging-composer.html'), 'utf8'));
  // A listing that bounces to the login page: Facebook has ended the session.
  if (url.pathname === '/marketplace/item/999/') return route.fulfill({ status: 302, headers: { location: '/login/?next=x' } });
  if (url.pathname.startsWith('/login')) return page('<title>Log in</title><input type="password">');
  const viewer = fake.loggedIn ? `{"USER_ID":"${USER_ID}","NAME":"Test User"}` : '{"USER_ID":"0","NAME":""}';
  return page(`<title>Marketplace</title><script type="application/json">{"define":[["CurrentUserInitialData",[],${viewer},1]]}</script>`);
}

const routedBrowser = (dataDir: string) =>
  Layer.effect(
    Browser,
    Effect.gen(function* () {
      const real = yield* Browser;
      const routed = new WeakSet<BrowserContext>();
      const ensure = (context: BrowserContext) =>
        Effect.promise(async () => {
          if (routed.has(context)) return;
          routed.add(context);
          await context.route('**/*', serve);
        });
      return Browser.of({
        ...real,
        withPage: (profile, use) => real.withPage(profile, (page) => Effect.andThen(ensure(page.context()), use(page))),
        openPage: (profile) => Effect.tap(real.openPage(profile), (page) => ensure(page.context())),
        loginContext: Effect.tap(real.loginContext, ensure),
        interactiveContext: (profile, options) => Effect.tap(real.interactiveContext(profile, options), ensure),
      });
    }),
  ).pipe(Layer.provide(Browser.layerNoDeps.pipe(Layer.provide(AppConfig.layerTest({ dataDir })))));

/**
 * Messaging over the real Browser service (exposed, for session setup), plus a RemoteView on the
 * same Browser (a view of the account open while a send runs). No Auth: Messaging doesn't need it.
 */
const messagingLayer = (dataDir: string) =>
  Layer.mergeAll(
    Messaging.layerNoDeps({ composer: { findTimeoutMs: 3000, confirmTimeoutMs: 5000 } }).pipe(Layer.provide(FakeMarketplace)),
    RemoteView.layerNoDeps().pipe(Layer.provide(Layer.mergeAll(FakeMarketplace, AppConfig.layerTest({ dataDir })))),
  ).pipe(Layer.provideMerge(routedBrowser(dataDir)));

const send = (listingId: string, text: string, userId: FbUserId = USER_ID) =>
  Effect.flatMap(Messaging, (messaging) => messaging.sendMessage(userId, listingId, text));

const failureCode = (effect: Effect.Effect<unknown, AppError, Messaging>) =>
  Effect.map(Effect.flip(effect), (error) => {
    assert.instanceOf(error, AppError);
    return error.code;
  });

// ---------- without a session ----------

layer(messagingLayer(fs.mkdtempSync(path.join(os.tmpdir(), 'faceslop-messaging-'))), { excludeTestServices: true })('sendMessage input', (it) => {
  it.effect('rejects listing ids Facebook cannot open', () =>
    Effect.gen(function* () {
      for (const id of ['', 'abc', '12a', '../1', '1/2', ' ', '1'.repeat(21)]) {
        assert.strictEqual(yield* failureCode(send(id, 'Hi')), 'BAD_REQUEST', id);
      }
    }),
  );

  it.effect('requires 1..1000 characters of text', () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* failureCode(send('123', '')), 'BAD_REQUEST');
      assert.strictEqual(yield* failureCode(send('123', '   \n ')), 'BAD_REQUEST');
      assert.strictEqual(yield* failureCode(send('123', 'x'.repeat(MAX_MESSAGE_LENGTH + 1))), 'BAD_REQUEST');
    }),
  );

  it.effect('requires a saved Facebook session for the account', () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* failureCode(send('123', 'Is this available?')), 'NOT_LOGGED_IN');
      assert.strictEqual(yield* failureCode(send('123', 'x'.repeat(MAX_MESSAGE_LENGTH))), 'NOT_LOGGED_IN');
    }),
  );
});

// ---------- with a session (fake facebook.com) ----------

/** Save a Facebook session for the account, as a login would. */
const giveSession = (userId: FbUserId = USER_ID) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* browser.loginContext;
        yield* Effect.promise(() =>
          context.addCookies([
            { name: 'c_user', value: userId, domain: '.facebook.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' },
            { name: 'xs', value: `xs-${userId}`, domain: '.facebook.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' },
          ]),
        );
        yield* browser.saveSession(userId, context);
      }),
    );
  });

describe.skipIf(skip)('sendMessage (headless Chrome, fake facebook.com)', () => {
  layer(messagingLayer(fs.mkdtempSync(path.join(os.tmpdir(), 'faceslop-messaging-send-'))), {
    timeout: '60 seconds',
    excludeTestServices: true,
  })((it) => {
    it.effect("another account's session doesn't count", () =>
      Effect.gen(function* () {
        yield* giveSession(OTHER_ID);
        assert.strictEqual(yield* failureCode(send(LISTING_ID, MESSAGE)), 'NOT_LOGGED_IN');
        const browser = yield* Browser;
        yield* browser.clearSession(OTHER_ID);
      }),
    );

    it.effect(
      "sends through the listing's composer, once, and forgets the account's cached listing",
      () =>
        Effect.gen(function* () {
          yield* giveSession();
          fake.graphqlNames.length = 0;
          marketplaceCalls.length = 0;

          // A double click: two identical requests share one send.
          const first = yield* Effect.forkChild(send(LISTING_ID, MESSAGE));
          yield* Effect.sleep('50 millis');
          const second = yield* Effect.forkChild(send(LISTING_ID, `  ${MESSAGE}  `));
          yield* Effect.sleep('50 millis');
          // A different message while that one is still going out is turned away.
          const other = yield* send(LISTING_ID, 'Something else');
          assert.deepStrictEqual(other, { ok: false, message: 'Still sending your previous message to this seller.', fallbackToWindow: false });

          const sent = { ok: true, message: 'Message sent.', fallbackToWindow: false };
          assert.deepStrictEqual(yield* Fiber.join(first), sent);
          assert.deepStrictEqual(yield* Fiber.join(second), sent);
          assert.deepStrictEqual(fake.graphqlNames, ['useMarketplaceSendMessageMutation']);
          assert.deepStrictEqual(marketplaceCalls, [`forgetListing:fb:${USER_ID}:${LISTING_ID}`]);
        }),
      60_000,
    );

    it.effect(
      "a listing that bounces to the login page means Facebook logged the account out: its session is cleared",
      () =>
        Effect.gen(function* () {
          yield* giveSession();
          fake.loggedIn = false;
          marketplaceCalls.length = 0;
          const error = yield* Effect.flip(send('999', MESSAGE));
          assert.strictEqual(error.code, 'NOT_LOGGED_IN');
          assert.match(error.message, /logged you out/);
          const browser = yield* Browser;
          assert.isFalse(yield* browser.hasSession(USER_ID));
          assert.deepStrictEqual(marketplaceCalls, [`closeAllSessions:fb:${USER_ID}`, `clearListingCache:fb:${USER_ID}`]);
          fake.loggedIn = true;
        }),
      60_000,
    );

    it.effect(
      "an open view of the account doesn't bring the dead session back when it closes",
      () =>
        Effect.gen(function* () {
          const browser = yield* Browser;
          const view = yield* RemoteView;
          yield* giveSession();
          // The user had the listing open in the remote view (to message by hand).
          yield* view.open(SESSION, accountProfile(USER_ID), { target: 'listing', listingId: LISTING_ID });
          fake.loggedIn = false;
          assert.strictEqual(yield* failureCode(send('999', MESSAGE)), 'NOT_LOGGED_IN');
          fake.loggedIn = true;
          assert.isFalse(yield* browser.hasSession(USER_ID));
          // Closing an account view saves its cookies back, but not a login that is no longer saved.
          yield* view.close(SESSION);
          assert.isFalse(yield* browser.hasSession(USER_ID));
        }),
      60_000,
    );

    it.effect('the hidden pages it used are closed afterwards', () =>
      Effect.gen(function* () {
        yield* giveSession();
        yield* send(LISTING_ID, MESSAGE);
        const browser = yield* Browser;
        const pages = yield* Effect.scoped(Effect.map(browser.openPage(accountProfile(USER_ID)), (page) => page.context().pages().length));
        assert.strictEqual(pages, 1, 'only the page this test opened');
      }),
    );
  });
});
