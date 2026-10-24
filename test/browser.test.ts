// Browser service against a real headless Chrome (never headed, no network: data: URLs and
// cookies only). Set FACESLOP_SKIP_BROWSER_TESTS=1 where no Chrome/Chromium is installed (the
// legacy session file migration doesn't start Chrome and always runs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, describe, it as plain, layer } from '@effect/vitest';
import { Effect, Exit, Layer, Scope } from 'effect';
import type { BrowserContext, Page } from 'playwright';
import { Browser, FB_ORIGIN, MAX_CONCURRENT_PAGES, facebookUserOf, type BrowserOptions } from '@/server/browser/Browser';
import { AppConfig } from '@/server/config';
import { ANONYMOUS_PROFILE, accountProfile, fbUserIdOf, type FbProfile, type FbUserId } from '@/server/session/identity';

const userId = (value: string): FbUserId => {
  const id = fbUserIdOf(value);
  if (id === null) throw new Error(`not a Facebook user id: ${value}`);
  return id;
};

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'faceslop-browser-'));
const sessionsDirOf = (dataDir: string) => path.join(dataDir, 'fb-sessions');
const sessionFileOf = (dataDir: string, id: FbUserId) => path.join(sessionsDirOf(dataDir), `${id}.json`);
const modeOf = (file: string) => fs.statSync(file).mode & 0o777;

const browserLayer = (dataDir: string, options?: BrowserOptions) =>
  (options ? Browser.layerNoDepsWith(options) : Browser.layerNoDeps).pipe(Layer.provide(AppConfig.layerTest({ dataDir })));

const dataDir = tempDir();
const TestBrowser = browserLayer(dataDir);

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

/** A Playwright storageState file logged in to `id`. */
const storageStateOf = (id: string) => JSON.stringify({ cookies: [fbCookie('c_user', id), fbCookie('xs', 'secret-token')], origins: [] });

/** The hidden context a profile's pages come from right now. */
const hiddenContextOf = (profile: FbProfile) =>
  Effect.flatMap(Browser, (browser) => browser.withPage(profile, (page) => Effect.succeed(page.context())));

const cookieValue = (profile: FbProfile, name: string) =>
  Effect.flatMap(Browser, (browser) =>
    Effect.map(browser.getCookies(profile), (cookies) => cookies.find((cookie) => cookie.name === name)?.value ?? null),
  );

/** Give `id` a saved session the way a login does: a login context's cookies, saved with saveSession. */
const logIn = (id: FbUserId, extra: readonly ReturnType<typeof fbCookie>[] = []) =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Browser;
      const context = yield* browser.loginContext;
      yield* Effect.promise(() => context.addCookies([fbCookie('c_user', id), ...extra]));
      yield* browser.saveSession(id, context);
    }),
  );

/** Resolves once `context` has closed. */
const closedFlag = (context: BrowserContext) => {
  const flag = { closed: false };
  context.on('close', () => {
    flag.closed = true;
  });
  return flag;
};

describe('legacy session file migration (no Chrome)', () => {
  plain.effect('moves fb-session.json to fb-sessions/<c_user>.json (0600, dir 0700) and removes it', () =>
    Effect.gen(function* () {
      const dir = tempDir();
      const legacy = path.join(dir, 'fb-session.json');
      const state = storageStateOf('100000000000001');
      fs.writeFileSync(legacy, state);
      const id = userId('100000000000001');
      const hasSession = yield* Effect.provide(
        Effect.flatMap(Browser, (browser) => browser.hasSession(id)),
        browserLayer(dir),
      );
      assert.isTrue(hasSession);
      assert.isFalse(fs.existsSync(legacy));
      assert.strictEqual(fs.readFileSync(sessionFileOf(dir, id), 'utf8'), state);
      assert.strictEqual(modeOf(sessionFileOf(dir, id)), 0o600);
      assert.strictEqual(modeOf(sessionsDirOf(dir)), 0o700);
    }),
  );

  plain.effect("keeps an account's existing session file, and drops a logged-out legacy file", () =>
    Effect.gen(function* () {
      const id = userId('100000000000002');
      const dir = tempDir();
      fs.mkdirSync(sessionsDirOf(dir), { mode: 0o700 });
      fs.writeFileSync(sessionFileOf(dir, id), 'newer', { mode: 0o600 });
      fs.writeFileSync(path.join(dir, 'fb-session.json'), storageStateOf(id));
      yield* Effect.provide(Effect.asVoid(Browser), browserLayer(dir));
      assert.strictEqual(fs.readFileSync(sessionFileOf(dir, id), 'utf8'), 'newer');
      assert.isFalse(fs.existsSync(path.join(dir, 'fb-session.json')));

      const loggedOut = tempDir();
      fs.writeFileSync(path.join(loggedOut, 'fb-session.json'), JSON.stringify({ cookies: [fbCookie('datr', 'x')], origins: [] }));
      yield* Effect.provide(Effect.asVoid(Browser), browserLayer(loggedOut));
      assert.isFalse(fs.existsSync(path.join(loggedOut, 'fb-session.json')));
      assert.isFalse(fs.existsSync(sessionsDirOf(loggedOut)));
    }),
  );

  plain.effect('leaves an unreadable legacy file in place', () =>
    Effect.gen(function* () {
      const dir = tempDir();
      const legacy = path.join(dir, 'fb-session.json');
      fs.writeFileSync(legacy, '{not json');
      yield* Effect.provide(Effect.asVoid(Browser), browserLayer(dir));
      assert.strictEqual(fs.readFileSync(legacy, 'utf8'), '{not json');
      assert.isFalse(fs.existsSync(sessionsDirOf(dir)));
    }),
  );

  plain.effect('removes temp files of interrupted session writes (they hold cookies), and nothing else', () =>
    Effect.gen(function* () {
      const id = userId('100000000000003');
      const dir = tempDir();
      fs.mkdirSync(sessionsDirOf(dir), { mode: 0o700 });
      const saved = sessionFileOf(dir, id);
      const unfinished = `${saved}.0b7e9c52-3c1f-4a8e-9d55-2f1b6c0e4a11.tmp`;
      const unrelated = path.join(sessionsDirOf(dir), 'notes.tmp');
      fs.writeFileSync(saved, storageStateOf(id), { mode: 0o600 });
      fs.writeFileSync(unfinished, storageStateOf(id), { mode: 0o600 });
      fs.writeFileSync(unrelated, 'keep');
      yield* Effect.provide(Effect.asVoid(Browser), browserLayer(dir));
      assert.isFalse(fs.existsSync(unfinished));
      assert.isTrue(fs.existsSync(saved));
      assert.isTrue(fs.existsSync(unrelated));
    }),
  );

  plain('reads the account from the facebook.com c_user cookie only', () => {
    assert.strictEqual(facebookUserOf([{ name: 'c_user', value: '123', domain: '.facebook.com' }]), '123');
    assert.strictEqual(facebookUserOf([{ name: 'c_user', value: '123', domain: 'www.facebook.com' }]), '123');
    assert.isNull(facebookUserOf([{ name: 'c_user', value: '123', domain: '.notfacebook.com' }]));
    assert.isNull(facebookUserOf([{ name: 'c_user', value: '../123', domain: '.facebook.com' }]));
    assert.isNull(facebookUserOf([]));
  });
});

describe.skipIf(process.env.FACESLOP_SKIP_BROWSER_TESTS === '1')('Browser (headless Chrome)', () => {
  // excludeTestServices: real clock (Playwright needs real time), not TestClock.
  layer(TestBrowser, { timeout: '60 seconds', excludeTestServices: true })((it) => {
    it.effect('runs at most MAX_CONCURRENT_PAGES withPage calls at once, across profiles', () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        let active = 0;
        let peak = 0;
        const task = (profile: FbProfile) =>
          browser.withPage(profile, (page) =>
            Effect.gen(function* () {
              active++;
              peak = Math.max(peak, active);
              yield* Effect.promise(() => page.goto('data:text/html,<title>ok</title>'));
              // Hold the page so later callers have to queue.
              yield* Effect.sleep('300 millis');
              active--;
              return yield* Effect.promise(() => page.title());
            }),
          );
        const profiles = [ANONYMOUS_PROFILE, accountProfile(userId('200000000000001')), ANONYMOUS_PROFILE];
        const titles = yield* Effect.all(
          Array.from({ length: 5 }, (_, i) => task(profiles[i % profiles.length] ?? ANONYMOUS_PROFILE)),
          { concurrency: 'unbounded' },
        );
        assert.deepStrictEqual(titles, ['ok', 'ok', 'ok', 'ok', 'ok']);
        assert.strictEqual(peak, MAX_CONCURRENT_PAGES);
      }),
    );

    it.effect('closes withPage pages even when the work fails', () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const seen: { page?: Page } = {};
        const exit = yield* Effect.exit(
          browser.withPage(ANONYMOUS_PROFILE, (page) => {
            seen.page = page;
            return Effect.fail('boom' as const);
          }),
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.isTrue(seen.page?.isClosed());
      }),
    );

    it.effect('serves an account without a session file from the anonymous context', () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const nobody = userId('200000000000002');
        assert.isFalse(yield* browser.hasSession(nobody));
        const anonymous = yield* hiddenContextOf(ANONYMOUS_PROFILE);
        assert.strictEqual(yield* hiddenContextOf(accountProfile(nobody)), anonymous);
        assert.isNull(yield* cookieValue(accountProfile(nobody), 'c_user'));
        // openPage too, and its page lives as long as the scope.
        const scope = yield* Scope.make();
        const page = yield* browser.openPage(accountProfile(nobody)).pipe(Scope.provide(scope));
        assert.strictEqual(page.context(), anonymous);
        yield* Scope.close(scope, Exit.void);
        assert.isTrue(page.isClosed());
        // Saving the anonymous context as an account would hand out a logged-out session.
        assert.strictEqual((yield* Effect.flip(browser.saveSession(nobody))).code, 'NOT_LOGGED_IN');
        assert.isFalse(fs.existsSync(sessionFileOf(dataDir, nobody)));
      }),
    );

    it.effect('saves an account session (0600) into its own hidden context; accounts stay apart; clearSession forgets it', () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const alice = userId('200000000000003');
        const bob = userId('200000000000004');
        yield* logIn(alice);
        yield* logIn(bob);
        assert.isTrue(yield* browser.hasSession(alice));
        assert.strictEqual(modeOf(sessionFileOf(dataDir, alice)), 0o600);
        assert.strictEqual(modeOf(sessionsDirOf(dataDir)), 0o700);
        assert.deepStrictEqual(fs.readdirSync(sessionsDirOf(dataDir)).filter((f) => f.endsWith('.tmp')), []);

        const aliceContext = yield* hiddenContextOf(accountProfile(alice));
        assert.notStrictEqual(aliceContext, yield* hiddenContextOf(ANONYMOUS_PROFILE));
        assert.notStrictEqual(aliceContext, yield* hiddenContextOf(accountProfile(bob)));
        assert.strictEqual(yield* cookieValue(accountProfile(alice), 'c_user'), alice);
        assert.strictEqual(yield* cookieValue(accountProfile(bob), 'c_user'), bob);
        assert.isNull(yield* cookieValue(ANONYMOUS_PROFILE, 'c_user'));

        // A context logged in to Alice is never saved as Bob's session.
        const misfiled = yield* Effect.flip(
          Effect.scoped(
            Effect.gen(function* () {
              const context = yield* browser.loginContext;
              yield* Effect.promise(() => context.addCookies([fbCookie('c_user', alice)]));
              yield* browser.saveSession(bob, context);
            }),
          ),
        );
        assert.strictEqual(misfiled.code, 'NOT_LOGGED_IN');
        assert.strictEqual(yield* cookieValue(accountProfile(bob), 'c_user'), bob);

        // Saving the account's own hidden context keeps that context (nothing new to pick up).
        yield* browser.saveSession(alice);
        assert.strictEqual(yield* hiddenContextOf(accountProfile(alice)), aliceContext);
        // A new login replaces the hidden context, which picks up the new cookies.
        yield* logIn(alice, [fbCookie('xs', 'second-login')]);
        assert.notStrictEqual(yield* hiddenContextOf(accountProfile(alice)), aliceContext);
        assert.strictEqual(yield* cookieValue(accountProfile(alice), 'xs'), 'second-login');

        yield* browser.clearSession(alice);
        assert.isFalse(yield* browser.hasSession(alice));
        assert.isFalse(fs.existsSync(sessionFileOf(dataDir, alice)));
        assert.isNull(yield* cookieValue(accountProfile(alice), 'c_user'));
        assert.strictEqual(yield* cookieValue(accountProfile(bob), 'c_user'), bob);
        assert.strictEqual(FB_ORIGIN, 'https://www.facebook.com');
      }),
    );

    it.effect('loginContext starts without cookies and saves nothing on close', () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const before = fs.existsSync(sessionsDirOf(dataDir)) ? fs.readdirSync(sessionsDirOf(dataDir)) : [];
        const flag = yield* Effect.scoped(
          Effect.gen(function* () {
            const login = yield* browser.loginContext;
            assert.deepStrictEqual(yield* Effect.promise(() => login.cookies()), []);
            yield* Effect.promise(() => login.addCookies([fbCookie('c_user', '200000000000005')]));
            return closedFlag(login);
          }),
        );
        assert.isTrue(flag.closed);
        assert.isFalse(fs.existsSync(sessionFileOf(dataDir, userId('200000000000005'))));
        assert.deepStrictEqual(fs.existsSync(sessionsDirOf(dataDir)) ? fs.readdirSync(sessionsDirOf(dataDir)) : [], before);
      }),
    );

    it.effect("interactive contexts save back on close only while logged in to their own account", () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const carol = userId('200000000000006');
        const dave = userId('200000000000007');
        yield* logIn(carol);
        const carolFile = sessionFileOf(dataDir, carol);
        const original = fs.readFileSync(carolFile, 'utf8');
        const view = (profile: FbProfile, change: (context: BrowserContext) => Promise<void>) =>
          Effect.scoped(
            Effect.flatMap(browser.interactiveContext(profile), (context) => Effect.promise(() => change(context))),
          );

        // Carol's view starts with her cookies; what changed in it is kept, and her hidden context reloads.
        const hiddenBefore = yield* hiddenContextOf(accountProfile(carol));
        yield* view(accountProfile(carol), async (context) => {
          const cookies = await context.cookies(FB_ORIGIN);
          assert.strictEqual(cookies.find((c) => c.name === 'c_user')?.value, carol);
          await context.addCookies([fbCookie('presence', 'refreshed')]);
        });
        assert.strictEqual(modeOf(carolFile), 0o600);
        assert.notStrictEqual(yield* hiddenContextOf(accountProfile(carol)), hiddenBefore);
        assert.strictEqual(yield* cookieValue(accountProfile(carol), 'presence'), 'refreshed');
        const refreshed = fs.readFileSync(carolFile, 'utf8');
        assert.notStrictEqual(refreshed, original);

        // Logged out in the view, or switched to another account: discarded.
        yield* view(accountProfile(carol), (context) => context.clearCookies());
        yield* view(accountProfile(carol), (context) => context.addCookies([fbCookie('c_user', dave)]));
        assert.strictEqual(fs.readFileSync(carolFile, 'utf8'), refreshed);
        assert.strictEqual(yield* cookieValue(accountProfile(carol), 'c_user'), carol);

        // Dave has no session: his view starts empty and a foreign login in it is not his session.
        yield* view(accountProfile(dave), async (context) => {
          assert.deepStrictEqual(await context.cookies(), []);
          await context.addCookies([fbCookie('c_user', carol)]);
        });
        assert.isFalse(yield* browser.hasSession(dave));
        assert.strictEqual(fs.readFileSync(carolFile, 'utf8'), refreshed);

        // Anonymous views never save anything, even after logging in.
        const files = fs.readdirSync(sessionsDirOf(dataDir)).sort();
        yield* view(ANONYMOUS_PROFILE, (context) => context.addCookies([fbCookie('c_user', '200000000000008')]));
        assert.deepStrictEqual(fs.readdirSync(sessionsDirOf(dataDir)).sort(), files);
        assert.strictEqual(fs.readFileSync(carolFile, 'utf8'), refreshed);

        // A view's own viewport.
        const viewport = yield* Effect.scoped(
          Effect.flatMap(browser.interactiveContext(ANONYMOUS_PROFILE, { viewport: { width: 800, height: 600 } }), (context) =>
            Effect.promise(async () => (await context.newPage()).viewportSize()),
          ),
        );
        assert.deepStrictEqual(viewport, { width: 800, height: 600 });
      }),
    );

    it.effect('resetContext closes only that profile\'s hidden context', () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const erin = userId('200000000000009');
        yield* logIn(erin);
        const erinContext = yield* hiddenContextOf(accountProfile(erin));
        const anonymous = yield* hiddenContextOf(ANONYMOUS_PROFILE);
        yield* browser.resetContext(accountProfile(erin));
        assert.notStrictEqual(yield* hiddenContextOf(accountProfile(erin)), erinContext);
        assert.strictEqual(yield* hiddenContextOf(ANONYMOUS_PROFILE), anonymous);
        yield* browser.resetContext(ANONYMOUS_PROFILE);
        assert.notStrictEqual(yield* hiddenContextOf(ANONYMOUS_PROFILE), anonymous);
        assert.strictEqual(yield* cookieValue(accountProfile(erin), 'c_user'), erin);
      }),
    );
  });

  describe('account context limits (a Chrome of their own)', () => {
    plain.live('closes account contexts after the idle time, but not while one of their pages is open', () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const frank = userId('300000000000001');
        yield* logIn(frank);
        const first = yield* hiddenContextOf(accountProfile(frank));
        const firstFlag = closedFlag(first);
        // An open page (e.g. a search session) keeps the context in use.
        const scope = yield* Scope.make();
        yield* browser.openPage(accountProfile(frank)).pipe(Scope.provide(scope));
        yield* Effect.sleep('900 millis');
        assert.isFalse(firstFlag.closed);
        assert.strictEqual(yield* hiddenContextOf(accountProfile(frank)), first);
        yield* Scope.close(scope, Exit.void);
        yield* Effect.sleep('900 millis');
        assert.isTrue(firstFlag.closed);
        // Next use reopens it from the session file.
        const second = yield* hiddenContextOf(accountProfile(frank));
        assert.notStrictEqual(second, first);
        assert.strictEqual(yield* cookieValue(accountProfile(frank), 'c_user'), frank);
        // The anonymous context is long-lived.
        const anonymous = yield* hiddenContextOf(ANONYMOUS_PROFILE);
        yield* Effect.sleep('900 millis');
        assert.strictEqual(yield* hiddenContextOf(ANONYMOUS_PROFILE), anonymous);
      }).pipe(Effect.provide(browserLayer(tempDir(), { accountIdleMs: 400, sweepIntervalMs: 100 }))),
      60_000,
    );

    plain.live('keeps at most maxAccountContexts, closing the least recently used idle one (never one in use)', () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const [a, b, c] = [userId('300000000000002'), userId('300000000000003'), userId('300000000000004')];
        for (const id of [a, b, c]) yield* logIn(id);

        // A is used (an open page) before B, so A is the least recently used, but in use: making
        // room for C closes B, the least recently used IDLE one.
        const scope = yield* Scope.make();
        const contextA = (yield* browser.openPage(accountProfile(a)).pipe(Scope.provide(scope))).context();
        yield* Effect.sleep('20 millis');
        const contextB = yield* hiddenContextOf(accountProfile(b));
        assert.notStrictEqual(contextB, contextA);
        const [flagA, flagB] = [closedFlag(contextA), closedFlag(contextB)];
        const contextC = (yield* browser.openPage(accountProfile(c)).pipe(Scope.provide(scope))).context();
        const flagC = closedFlag(contextC);
        assert.isFalse(flagA.closed);
        assert.isTrue(flagB.closed);

        // Every open context is in use: B gets one anyway (over the cap) rather than killing pages.
        const contextB2 = yield* hiddenContextOf(accountProfile(b));
        assert.notStrictEqual(contextB2, contextB);
        assert.isFalse(flagA.closed);
        assert.isFalse(flagC.closed);
        assert.strictEqual(yield* hiddenContextOf(accountProfile(a)), contextA);
        assert.strictEqual(yield* hiddenContextOf(accountProfile(c)), contextC);
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(browserLayer(tempDir(), { maxAccountContexts: 2 }))),
      60_000,
    );
  });
});
