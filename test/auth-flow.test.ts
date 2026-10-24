// The Auth service end to end: per-session password logins and login views, driving the real
// Browser and RemoteView services (headless Chrome) against a fake facebook.com served by routes
// on every browser context, with a fake Sessions (bindings in a Ref). Nothing reaches Facebook,
// and session files go to a temporary data dir. Port of legacy/test/{auth-flow,auth-window}.test.ts,
// plus the multi-user rules: whose session a login binds, whose file it saves, logout keeping the
// file while another browser is still bound, at most two password logins at once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, describe, layer } from '@effect/vitest';
import { Effect, Layer, Option, Ref } from 'effect';
import type { BrowserContext, Page, Route } from 'playwright';
import { afterAll, vi } from 'vitest';
import { Auth, MAX_PASSWORD_LOGINS } from '@/server/auth/Auth';
import { USE_LOGIN_VIEW, sessionTokenFromCookies, userIdFromCookies } from '@/server/auth/auth-parse';
import { Browser, FB_ORIGIN } from '@/server/browser/Browser';
import { AppConfig } from '@/server/config';
import { Marketplace } from '@/server/marketplace/Marketplace';
import { RemoteView } from '@/server/remote-view/RemoteView';
import { type ClientSession, type ClientSessionId, type FbUserId, accountProfile, profileKey } from '@/server/session/identity';
import { Sessions } from '@/server/session/Sessions';
import { notImplemented } from '@/server/stub';
import type { AuthStatus } from '@/shared/domain';
import { AppError } from '@/shared/errors';

const skip = process.env.FACESLOP_SKIP_BROWSER_TESTS === '1';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faceslop-auth-'));
const USER_ID = '100012345' as FbUserId;
const OTHER_ID = '100067890' as FbUserId;
const NAMES: Readonly<Record<string, string>> = { [USER_ID]: 'Test User', [OTHER_ID]: 'Other User' };
const sessionFile = (userId: FbUserId) => path.join(dataDir, 'fb-sessions', `${userId}.json`);
const PASSWORD = 'correct horse battery staple';

const A = 'session-a' as ClientSessionId;
const B = 'session-b' as ClientSessionId;
const C = 'session-c' as ClientSessionId;

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Nothing may print the password: collect everything written to the console.
const logged: string[] = [];
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
}

// ---------- the fake facebook.com ----------

const fake: { marketplaceLoggedIn: boolean; approveAfterMs: number; onMarketplace: (() => void) | null } = {
  marketplaceLoggedIn: true,
  approveAfterMs: 4000,
  /** Runs once, when the next Marketplace page is requested (before it is served). */
  onMarketplace: null,
};

const html = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

/** Facebook's session cookies for `userId`; every login gets a new xs token. */
const setSession = (userId: string) => `document.cookie = "c_user=${userId}; domain=.facebook.com; path=/; secure; max-age=86400";
  document.cookie = "xs=" + Date.now() + "-" + Math.random().toString(36).slice(2) + "; domain=.facebook.com; path=/; secure; max-age=86400";`;
const goTo = (url: string) => `<script>location.replace(${JSON.stringify(url)});</script>`;

function loginPage(alert = ''): string {
  // Mirrors the 2026 Comet login page: generated input ids, a div[role=button] "Log In", a 0x0
  // submit input, and the EU cookie dialog on top.
  return html(
    'Log in to Facebook',
    `<div role="dialog" data-testid="cookie-policy-manage-dialog" style="position:fixed;inset:0;background:#fff;z-index:10">
      <span>Allow the use of cookies from Facebook on this browser?</span>
      <button data-cookiebanner="accept_only_essential_button" onclick="this.closest('[role=dialog]').remove()">Decline optional cookies</button>
      <button data-cookiebanner="accept_button" onclick="this.closest('[role=dialog]').remove()">Allow all cookies</button>
    </div>
    <form id="login_form" method="POST" action="/login/device-based/regular/login/?login_attempt=1" novalidate>
      ${alert === '' ? '' : `<div role="alert">${alert}</div>`}
      <div><input id="_R_c9l6ne_" type="text" name="email" autocomplete="username webauthn"><label for="_R_c9l6ne_">Email or mobile number</label></div>
      <div><input id="_R_cdl6ne_" type="password" name="pass"><label for="_R_cdl6ne_">Password</label></div>
      <div aria-label="Log In" role="button" tabindex="0" onclick="this.closest('form').submit()"><span>Log in</span></div>
      <input type="submit" style="width:0;height:0;padding:0;border:0">
      <a href="/recover/initiate/">Forgot password?</a>
    </form>`,
  );
}

function codePage(alert = ''): string {
  return html(
    'Two-factor authentication required',
    `<form method="POST" action="/two_step_verification/two_factor/submit/">
      <h2>Go to your authentication app</h2>
      <p>Enter the 6-digit code for this account from the two-factor authentication app that you set up (such as Duo Mobile or Google Authenticator).</p>
      ${alert === '' ? '' : `<div role="alert">${alert}</div>`}
      <input type="text" name="code" aria-label="Code" autocomplete="one-time-code" inputmode="numeric">
      <div role="button" tabindex="0" onclick="this.closest('form').submit()">Continue</div>
      <div role="button" tabindex="0">Try another way</div>
    </form>`,
  );
}

const trustPage = html(
  'Trust this device?',
  `<h2>Trust this device?</h2><p>You won't need to enter a code next time you log in from here.</p>
  <div role="button" tabindex="0" onclick='${setSession(USER_ID).replace(/'/g, '&#39;')} location.replace("/marketplace/")'>Trust this device</div>
  <div role="button" tabindex="0">Don't trust</div>`,
);

const approvalPage = () =>
  html(
    'Check your notifications',
    `<h2>Check your notifications on another device</h2>
    <p>We sent a notification to your iPhone. Approve the login to continue.</p><p>Waiting for approval</p>
    <script>setTimeout(() => { ${setSession(USER_ID)} location.replace('/marketplace/'); }, ${fake.approveAfterMs});</script>`,
  );

function marketplacePage(cookieHeader: string): string {
  const userId = /(?:^|;\s*)c_user=(\d+)/.exec(cookieHeader)?.[1];
  const name = userId === undefined ? undefined : NAMES[userId];
  const viewer =
    fake.marketplaceLoggedIn && userId !== undefined && name !== undefined
      ? `{"ACCOUNT_ID":"${userId}","USER_ID":"${userId}","NAME":"${name}","SHORT_NAME":"${name.split(' ')[0] ?? ''}"}`
      : '{"ACCOUNT_ID":"0","USER_ID":"0","NAME":"","SHORT_NAME":null}';
  return html(
    'Marketplace',
    `<script type="application/json">{"define":[["CurrentUserInitialData",[],${viewer},270]]}</script><div role="main">Marketplace</div>`,
  );
}

async function serve(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  if (!/(^|\.)facebook\.com$/.test(url.hostname)) return route.abort();
  if (request.resourceType() !== 'document') return route.fulfill({ status: 204, body: '' });
  const form = new URLSearchParams(request.postData() ?? '');
  const page = (body: string) => route.fulfill({ contentType: 'text/html; charset=utf-8', body });

  if (url.pathname === '/login/' || url.pathname === '/login.php') return page(loginPage());
  if (url.pathname === '/login/device-based/regular/login/') {
    if (form.get('pass') !== PASSWORD) return page(loginPage("The password that you've entered is incorrect. Forgot password?"));
    switch (form.get('email') ?? '') {
      case 'code@example.com':
        return page(goTo('/two_step_verification/two_factor/?encrypted_context=abc'));
      case 'approve@example.com':
        return page(goTo('/two_step_verification/authentication/?encrypted_context=abc'));
      case 'captcha@example.com':
        return page(html('Security check', '<p>Security check</p><iframe title="captcha" src="/captcha/frame" width="300" height="80"></iframe>'));
      case 'other@example.com':
        return page(`<script>${setSession(OTHER_ID)} location.replace('/marketplace/');</script>`);
      default:
        return page(`<script>${setSession(USER_ID)} location.replace('/marketplace/');</script>`);
    }
  }
  if (url.pathname === '/two_step_verification/two_factor/') return page(codePage());
  if (url.pathname === '/two_step_verification/two_factor/submit/') {
    return form.get('code') === '123456'
      ? page(goTo('/two_step_verification/trust/'))
      : page(codePage("This code doesn't work. Check it's correct or try a new one."));
  }
  if (url.pathname === '/two_step_verification/trust/') return page(trustPage);
  if (url.pathname === '/two_step_verification/authentication/') return page(approvalPage());
  if (url.pathname.startsWith('/marketplace')) {
    const hook = fake.onMarketplace;
    fake.onMarketplace = null;
    hook?.();
    return page(marketplacePage((await request.allHeaders()).cookie ?? ''));
  }
  return page(html('Facebook', '<p>feed</p>'));
}

// ---------- layers ----------

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
    forgetListing: () => Effect.void,
    clearListingCache: (profile) =>
      Effect.sync(() => {
        marketplaceCalls.push(`clearListingCache:${profileKey(profile)}`);
      }),
    searchLocations: () => notImplemented('Marketplace.searchLocations'),
    categories: notImplemented('Marketplace.categories'),
  }),
);

const resetOf = (userId: FbUserId) => [`closeAllSessions:fb:${userId}`, `clearListingCache:fb:${userId}`];

/** Browser sessions and their Facebook bindings (what the real Sessions keeps in SQLite). */
const sessionStore = Ref.makeUnsafe<ReadonlyMap<ClientSessionId, ClientSession>>(new Map());
const sessionCalls: string[] = [];

const withSession = (id: ClientSessionId, fbUserId: FbUserId | null) =>
  Ref.update(sessionStore, (sessions) => new Map(sessions).set(id, { id, unlocked: true, fbUserId }));

const FakeSessions = Layer.succeed(
  Sessions,
  Sessions.of({
    passwordRequired: false,
    resolve: () => notImplemented('Sessions.resolve'),
    get: (id) => Effect.map(Ref.get(sessionStore), (sessions) => Option.fromNullishOr(sessions.get(id))),
    create: notImplemented('Sessions.create'),
    unlock: () => notImplemented('Sessions.unlock'),
    lock: () => notImplemented('Sessions.lock'),
    bindAccount: (id, userId) =>
      Effect.andThen(
        Effect.sync(() => {
          sessionCalls.push(`bind:${id}:${userId}`);
        }),
        withSession(id, userId),
      ),
    unbindAccount: (id) =>
      Ref.modify(sessionStore, (sessions) => {
        sessionCalls.push(`unbind:${id}`);
        const userId = sessions.get(id)?.fbUserId ?? null;
        const next = new Map(sessions).set(id, { id, unlocked: true, fbUserId: null });
        const remaining = userId === null ? 0 : [...next.values()].filter((session) => session.fbUserId === userId).length;
        return [{ userId, remaining }, next];
      }),
  }),
);

/** The real Browser service, with every context it creates (hidden, login and interactive) served by the fake. */
const config = AppConfig.layerTest({ dataDir });
const FakeFacebookBrowser = Layer.effect(
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
).pipe(Layer.provide(Browser.layerNoDeps.pipe(Layer.provide(config))));

const ViewLayer = RemoteView.layerNoDeps().pipe(Layer.provide(Layer.mergeAll(FakeMarketplace, config)), Layer.provideMerge(FakeFacebookBrowser));
const TestLayer = Auth.layerNoDeps({ viewPollMs: 100, viewSettleMs: 300 }).pipe(
  Layer.provide(Layer.mergeAll(FakeMarketplace, FakeSessions)),
  Layer.provideMerge(ViewLayer),
);

// ---------- helpers ----------

const loggedOut: AuthStatus = { state: 'logged_out', userId: null, userName: null, message: null };
const loggedInAs = (userId: FbUserId): AuthStatus => ({ state: 'logged_in', userId, userName: NAMES[userId] ?? null, message: null });
const loggedIn = loggedInAs(USER_ID);

/** The browser session as Sessions has it now (unknown ids: a fresh unbound session). */
const sessionOf = (id: ClientSessionId) =>
  Effect.map(Ref.get(sessionStore), (sessions): ClientSession => sessions.get(id) ?? { id, unlocked: true, fbUserId: null });

const boundTo = (id: ClientSessionId) => Effect.map(sessionOf(id), (session) => session.fbUserId);

const statusOf = (id: ClientSessionId, verify = false) =>
  Effect.flatMap(sessionOf(id), (session) => Auth.use((auth) => auth.status(session, { verify })));
const isLoggedIn = (id: ClientSessionId) => Effect.flatMap(sessionOf(id), (session) => Auth.use((auth) => auth.isLoggedIn(session)));
const login = (id: ClientSessionId, email: string, password = PASSWORD) =>
  Effect.flatMap(sessionOf(id), (session) => Auth.use((auth) => auth.loginWithPassword(session, { email, password })));
const submitCode = (id: ClientSessionId, code: string) =>
  Effect.flatMap(sessionOf(id), (session) => Auth.use((auth) => auth.submitLoginCode(session, code)));
const openLoginView = (id: ClientSessionId) => Effect.flatMap(sessionOf(id), (session) => Auth.use((auth) => auth.openLoginView(session)));
const logout = (id: ClientSessionId) => Effect.flatMap(sessionOf(id), (session) => Auth.use((auth) => auth.logout(session)));

/** Each test starts with every session logged out, no login in progress, no view open, no session files. */
const reset = Effect.gen(function* () {
  for (const id of [A, B, C]) assert.deepStrictEqual(yield* logout(id), loggedOut);
  const browser = yield* Browser;
  yield* browser.clearSession(USER_ID);
  yield* browser.clearSession(OTHER_ID);
  yield* Ref.set(sessionStore, new Map());
  marketplaceCalls.length = 0;
  sessionCalls.length = 0;
  fake.marketplaceLoggedIn = true;
  fake.approveAfterMs = 4000;
  fake.onMarketplace = null;
});

const pollStatus = (id: ClientSessionId, until: (status: AuthStatus) => boolean, timeoutMs = 20_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = yield* statusOf(id);
      if (until(status) || Date.now() > deadline) return status;
      yield* Effect.sleep('250 millis');
    }
  });

const viewPage = (id: ClientSessionId) => Effect.flatMap(RemoteView, (view) => Effect.map(view.page(id), Option.getOrThrow));

/** What the user does in the view: Facebook sets the session cookie and sends them on to `landing`. */
const logInInView = (page: Page, landing = '/marketplace/', userId: FbUserId = USER_ID) =>
  Effect.promise(() =>
    page.evaluate(
      ([id, to]) => {
        document.cookie = `c_user=${id}; domain=.facebook.com; path=/; secure; max-age=86400`;
        document.cookie = `xs=view-${Date.now()}; domain=.facebook.com; path=/; secure; max-age=86400`;
        location.replace(to);
      },
      [userId, landing] as const,
    ),
  );

/** The xs token of the account's saved session (null without one). */
const savedXs = (userId: FbUserId) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    if (!(yield* browser.hasSession(userId))) return null;
    const cookies = yield* browser.getCookies(accountProfile(userId));
    return cookies.find((cookie) => cookie.name === 'xs')?.value ?? null;
  });

const failureOf = <A, R>(effect: Effect.Effect<A, AppError, R>) =>
  Effect.map(Effect.flip(effect), (error) => {
    assert.instanceOf(error, AppError);
    return error;
  });

describe.skipIf(skip)('Auth (headless Chrome, fake facebook.com)', () => {
  layer(TestLayer, { timeout: '60 seconds', excludeTestServices: true })((it) => {
    // ---------- password login ----------

    it.effect('starts logged out without a session file', () =>
      Effect.gen(function* () {
        yield* reset;
        assert.deepStrictEqual(yield* statusOf(A), loggedOut);
        assert.isFalse(yield* isLoggedIn(A));
      }),
    );

    it.effect(
      "reports Facebook's message for a wrong password, to that session only",
      () =>
        Effect.gen(function* () {
          yield* reset;
          const status = yield* login(A, 'someone@example.com', 'wrong password');
          assert.deepStrictEqual(status, {
            state: 'error',
            userId: null,
            userName: null,
            message: "The password that you've entered is incorrect. Forgot password?",
          });
          // The error stays visible for a while, in this browser.
          assert.strictEqual((yield* statusOf(A)).state, 'error');
          assert.deepStrictEqual(yield* statusOf(B), loggedOut);
          assert.isFalse(fs.existsSync(sessionFile(USER_ID)));
        }),
      60_000,
    );

    it.effect(
      "logs in without 2FA: saves the account's session and binds this browser to it",
      () =>
        Effect.gen(function* () {
          yield* reset;
          assert.deepStrictEqual(yield* login(A, 'plain@example.com'), loggedIn);
          assert.isTrue(fs.existsSync(sessionFile(USER_ID)));
          assert.strictEqual(fs.statSync(sessionFile(USER_ID)).mode & 0o777, 0o600);
          assert.strictEqual(fs.statSync(path.dirname(sessionFile(USER_ID))).mode & 0o777, 0o700);
          assert.strictEqual(yield* boundTo(A), USER_ID);
          assert.deepStrictEqual(sessionCalls, [`bind:${A}:${USER_ID}`]);
          assert.includeMembers(marketplaceCalls, resetOf(USER_ID));
          assert.isTrue(yield* isLoggedIn(A));
          // Another browser is not logged in by it.
          assert.isFalse(yield* isLoggedIn(B));
          assert.deepStrictEqual(yield* statusOf(B), loggedOut);
          // Already logged in: another login just confirms the session.
          assert.deepStrictEqual(yield* login(A, 'plain@example.com'), loggedIn);
        }),
      60_000,
    );

    it.effect(
      'walks the 2FA code step, including a wrong code and the "trust this device" prompt',
      () =>
        Effect.gen(function* () {
          yield* reset;
          const first = yield* login(A, 'code@example.com');
          assert.strictEqual(first.state, 'needs_code');
          assert.match(first.message ?? '', /6-digit code/);
          assert.strictEqual((yield* statusOf(A)).state, 'needs_code');
          // A repeated submit (double click) doesn't restart the login.
          assert.deepStrictEqual(yield* login(A, 'CODE@example.com'), first);

          const wrong = yield* submitCode(A, '000000');
          assert.deepInclude(wrong, { state: 'needs_code', message: "This code doesn't work. Check it's correct or try a new one." });

          assert.deepStrictEqual(yield* submitCode(A, '123 456'), loggedIn);
          assert.isTrue(fs.existsSync(sessionFile(USER_ID)));
          assert.strictEqual(yield* boundTo(A), USER_ID);
          assert.include(marketplaceCalls, `closeAllSessions:fb:${USER_ID}`);
          // A repeated code submit after success just reports the session.
          assert.strictEqual((yield* submitCode(A, '123456')).state, 'logged_in');
        }),
      60_000,
    );

    it.effect(
      'waits for approval on another device and finishes by itself',
      () =>
        Effect.gen(function* () {
          yield* reset;
          const first = yield* login(A, 'approve@example.com');
          assert.strictEqual(first.state, 'needs_approval');
          assert.match(first.message ?? '', /approve this login/i);
          const final = yield* pollStatus(A, (status) => status.state !== 'needs_approval');
          assert.deepStrictEqual(final, loggedIn);
          assert.strictEqual(yield* boundTo(A), USER_ID);
        }),
      60_000,
    );

    it.effect(
      "points at Facebook's own login page for captchas",
      () =>
        Effect.gen(function* () {
          yield* reset;
          const status = yield* login(A, 'captcha@example.com');
          assert.strictEqual(status.state, 'error');
          assert.match(status.message ?? '', /captcha/i);
          assert.include(status.message ?? '', USE_LOGIN_VIEW);
        }),
      60_000,
    );

    it.effect('rejects codes when no login is waiting, and bad input', () =>
      Effect.gen(function* () {
        yield* reset;
        for (const attempt of [
          submitCode(A, '123456'),
          submitCode(A, '12'),
          submitCode(A, 'not a code!'),
          login(A, '  ', 'x'),
          login(A, 'a@example.com', ''),
        ]) {
          assert.strictEqual((yield* failureOf(attempt)).code, 'BAD_REQUEST');
        }
      }),
    );

    it.effect(
      'password logins are per session, and at most two run at once',
      () =>
        Effect.gen(function* () {
          yield* reset;
          assert.strictEqual(MAX_PASSWORD_LOGINS, 2);
          fake.approveAfterMs = 120_000;
          assert.strictEqual((yield* login(A, 'code@example.com')).state, 'needs_code');
          assert.strictEqual((yield* login(B, 'approve@example.com')).state, 'needs_approval');

          // Each browser sees its own login.
          assert.strictEqual((yield* statusOf(A)).state, 'needs_code');
          assert.strictEqual((yield* statusOf(B)).state, 'needs_approval');
          assert.deepStrictEqual(yield* statusOf(C), loggedOut);
          // B can't answer A's code prompt.
          assert.strictEqual((yield* failureOf(submitCode(B, '123456'))).code, 'BAD_REQUEST');

          // A third login waits for a free slot.
          const busy = yield* failureOf(login(C, 'plain@example.com'));
          assert.strictEqual(busy.code, 'BAD_REQUEST');
          assert.strictEqual(busy.message, 'Another login is in progress. Try again in a minute.');
          // A repeated submit of a running login isn't a new one.
          assert.strictEqual((yield* login(A, 'code@example.com')).state, 'needs_code');

          // A gives up (logout cancels its login): its slot frees up.
          yield* logout(A);
          assert.deepStrictEqual(yield* login(C, 'plain@example.com'), loggedIn);
          assert.strictEqual(yield* boundTo(C), USER_ID);
          assert.isNull(yield* boundTo(A));
          assert.isNull(yield* boundTo(B));
          assert.strictEqual((yield* statusOf(B)).state, 'needs_approval');
        }),
      60_000,
    );

    it.effect(
      'cancelLogin gives up a waiting login (freeing its slot) and keeps the binding',
      () =>
        Effect.gen(function* () {
          yield* reset;
          fake.approveAfterMs = 120_000;
          // A is bound already (its Facebook session ended, say) and starts another login.
          yield* withSession(A, USER_ID);
          assert.strictEqual((yield* login(A, 'code@example.com')).state, 'needs_code');
          assert.strictEqual((yield* login(B, 'approve@example.com')).state, 'needs_approval');

          const auth = yield* Auth;
          const after = yield* auth.cancelLogin(yield* sessionOf(A));
          assert.notStrictEqual(after.state, 'needs_code');
          assert.strictEqual(after.userId, USER_ID);
          assert.strictEqual(yield* boundTo(A), USER_ID);
          // The code prompt is gone, and its slot is free for another browser.
          assert.strictEqual((yield* failureOf(submitCode(A, '123456'))).code, 'BAD_REQUEST');
          assert.deepStrictEqual(yield* login(C, 'plain@example.com'), loggedIn);
          assert.strictEqual((yield* statusOf(B)).state, 'needs_approval');
        }),
      60_000,
    );

    it.effect(
      'logs out: clears the session file and resets Marketplace when no other browser is bound',
      () =>
        Effect.gen(function* () {
          yield* reset;
          yield* login(A, 'plain@example.com');
          assert.isTrue(fs.existsSync(sessionFile(USER_ID)));
          marketplaceCalls.length = 0;
          assert.deepStrictEqual(yield* logout(A), loggedOut);
          assert.isFalse(fs.existsSync(sessionFile(USER_ID)));
          assert.deepStrictEqual(marketplaceCalls, resetOf(USER_ID));
          assert.isNull(yield* boundTo(A));
          assert.deepStrictEqual(yield* statusOf(A), loggedOut);
        }),
      60_000,
    );

    it.effect(
      "logout keeps the account's session while another browser is still bound to it",
      () =>
        Effect.gen(function* () {
          yield* reset;
          assert.deepStrictEqual(yield* login(A, 'plain@example.com'), loggedIn);
          // The same person on another device logs in to the same account.
          assert.deepStrictEqual(yield* login(B, 'plain@example.com'), loggedIn);
          assert.strictEqual(yield* boundTo(B), USER_ID);

          assert.deepStrictEqual(yield* logout(A), loggedOut);
          assert.isTrue(fs.existsSync(sessionFile(USER_ID)), 'B still uses it');
          assert.deepStrictEqual(yield* statusOf(A), loggedOut);
          assert.deepStrictEqual(yield* statusOf(B), loggedIn);

          assert.deepStrictEqual(yield* logout(B), loggedOut);
          assert.isFalse(fs.existsSync(sessionFile(USER_ID)), 'nobody uses it anymore');
        }),
      60_000,
    );

    it.effect(
      'verify notices a session Facebook has ended: clears it, keeps the binding',
      () =>
        Effect.gen(function* () {
          yield* reset;
          yield* login(A, 'plain@example.com');
          assert.deepStrictEqual(yield* statusOf(A, true), loggedIn);
          fake.marketplaceLoggedIn = false;
          marketplaceCalls.length = 0;
          const status = yield* statusOf(A, true);
          assert.strictEqual(status.state, 'logged_out');
          assert.match(status.message ?? '', /session has ended/);
          assert.isFalse(fs.existsSync(sessionFile(USER_ID)));
          assert.deepStrictEqual(marketplaceCalls, resetOf(USER_ID));
          assert.strictEqual(yield* boundTo(A), USER_ID, "the browser's data still belongs to the account");
          assert.isFalse(yield* isLoggedIn(A));
        }),
      60_000,
    );

    it.effect(
      "verify: closing the browser's open view afterwards doesn't bring the dead session back",
      () =>
        Effect.gen(function* () {
          yield* reset;
          const view = yield* RemoteView;
          yield* login(A, 'plain@example.com');
          yield* view.open(A, accountProfile(USER_ID), { target: 'listing', listingId: '1' });
          fake.marketplaceLoggedIn = false;
          assert.strictEqual((yield* statusOf(A, true)).state, 'logged_out');
          yield* view.close(A);
          assert.strictEqual((yield* statusOf(A)).state, 'logged_out');
          assert.isFalse(yield* isLoggedIn(A));
          assert.isFalse(fs.existsSync(sessionFile(USER_ID)));
        }),
      60_000,
    );

    it.effect(
      'verify keeps a new login made inside an open view',
      () =>
        Effect.gen(function* () {
          yield* reset;
          const view = yield* RemoteView;
          yield* login(A, 'plain@example.com');
          yield* view.open(A, accountProfile(USER_ID), { target: 'listing', listingId: '1' });
          // The user logged in again in the view: a new session token.
          const page = yield* viewPage(A);
          yield* Effect.promise(() =>
            page.context().addCookies([
              { name: 'xs', value: 'new-xs', domain: '.facebook.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' },
            ]),
          );
          fake.marketplaceLoggedIn = false;
          assert.strictEqual((yield* statusOf(A, true)).state, 'logged_out');
          fake.marketplaceLoggedIn = true;
          yield* view.close(A);
          assert.deepInclude(yield* statusOf(A), { state: 'logged_in', userId: USER_ID });
          assert.strictEqual(yield* savedXs(USER_ID), 'new-xs');
        }),
      60_000,
    );

    it.effect(
      "a password login hands its session to the browser's view that was already open",
      () =>
        Effect.gen(function* () {
          yield* reset;
          const view = yield* RemoteView;
          const browser = yield* Browser;
          yield* login(A, 'plain@example.com');
          const before = yield* savedXs(USER_ID);
          yield* view.open(A, accountProfile(USER_ID), { target: 'listing', listingId: '1' });
          // The saved session went away meanwhile (e.g. another device's check found it dead).
          yield* browser.clearSession(USER_ID);
          assert.strictEqual((yield* statusOf(A)).state, 'logged_out');

          assert.deepStrictEqual(yield* login(A, 'plain@example.com'), loggedIn);
          const after = yield* savedXs(USER_ID);
          assert.notStrictEqual(after, before);
          // Closing the view saves its cookies as the session: they must be the new ones.
          yield* view.close(A);
          assert.strictEqual(yield* savedXs(USER_ID), after);
          assert.deepStrictEqual(yield* statusOf(A), loggedIn);
        }),
      60_000,
    );

    it.effect(
      "after verify finds the session dead, a new login gives the browser's open view the new session",
      () =>
        Effect.gen(function* () {
          yield* reset;
          const view = yield* RemoteView;
          yield* login(A, 'plain@example.com');
          yield* view.open(A, accountProfile(USER_ID), { target: 'listing', listingId: '1' });
          const page = yield* viewPage(A);
          fake.marketplaceLoggedIn = false;
          assert.strictEqual((yield* statusOf(A, true)).state, 'logged_out');
          fake.marketplaceLoggedIn = true;

          assert.deepStrictEqual(yield* login(A, 'plain@example.com'), loggedIn);
          // Opening the view again reuses it as is: it must carry the new session.
          yield* view.open(A, accountProfile(USER_ID), { target: 'inbox' });
          assert.strictEqual(yield* viewPage(A), page);
          const cookies = yield* Effect.promise(() => page.context().cookies(FB_ORIGIN));
          assert.strictEqual(userIdFromCookies(cookies), USER_ID);
          assert.strictEqual(sessionTokenFromCookies(cookies), yield* savedXs(USER_ID));
          yield* view.close(A);
          assert.deepStrictEqual(yield* statusOf(A), loggedIn);
        }),
      60_000,
    );

    it.effect(
      'a login gives the session to a view of the account opened while it had none',
      () =>
        Effect.gen(function* () {
          yield* reset;
          const view = yield* RemoteView;
          yield* login(A, 'plain@example.com');
          fake.marketplaceLoggedIn = false;
          assert.strictEqual((yield* statusOf(A, true)).state, 'logged_out');
          fake.marketplaceLoggedIn = true;
          // Still bound to the account: a listing opens under its (now empty) profile.
          yield* view.open(A, accountProfile(USER_ID), { target: 'listing', listingId: '1' });
          const page = yield* viewPage(A);
          assert.isNull(userIdFromCookies(yield* Effect.promise(() => page.context().cookies(FB_ORIGIN))));

          assert.deepStrictEqual(yield* login(A, 'plain@example.com'), loggedIn);
          const cookies = yield* Effect.promise(() => page.context().cookies(FB_ORIGIN));
          assert.strictEqual(userIdFromCookies(cookies), USER_ID);
          assert.strictEqual(sessionTokenFromCookies(cookies), yield* savedXs(USER_ID));
          yield* view.close(A);
          assert.deepStrictEqual(yield* statusOf(A), loggedIn);
        }),
      60_000,
    );

    it.effect(
      'verify never reports logged_in for a session deleted while Facebook was being asked',
      () =>
        Effect.gen(function* () {
          yield* reset;
          yield* login(A, 'plain@example.com');
          // Another browser's check deletes the session while this one's probe is out.
          fake.onMarketplace = () => {
            fs.rmSync(sessionFile(USER_ID), { force: true });
          };
          const status = yield* statusOf(A, true);
          assert.isNull(fake.onMarketplace, 'the probe ran');
          // Logged out, but still naming the account this browser is bound to.
          assert.deepStrictEqual(status, { ...loggedOut, userId: USER_ID });
          assert.strictEqual(yield* boundTo(A), USER_ID);
        }),
      60_000,
    );

    it.effect(
      'two browsers of one account verifying at once both see that Facebook ended the session',
      () =>
        Effect.gen(function* () {
          yield* reset;
          yield* login(A, 'plain@example.com');
          yield* login(B, 'plain@example.com');
          fake.marketplaceLoggedIn = false;
          const [a, b] = yield* Effect.all([statusOf(A, true), statusOf(B, true)], { concurrency: 'unbounded' });
          for (const status of [a, b]) {
            assert.strictEqual(status.state, 'logged_out');
            assert.match(status.message ?? '', /session has ended/);
          }
          assert.isFalse(fs.existsSync(sessionFile(USER_ID)));
          assert.strictEqual(yield* boundTo(A), USER_ID);
          assert.strictEqual(yield* boundTo(B), USER_ID);
        }),
      60_000,
    );

    // ---------- the login view ----------

    it.effect(
      "opens the browser's view on Facebook's login page and finishes once the user is in",
      () =>
        Effect.gen(function* () {
          yield* reset;
          const view = yield* RemoteView;
          const opened = yield* openLoginView(A);
          assert.strictEqual(opened.state, 'window_open');
          assert.match(opened.message ?? '', /closes by itself/);
          assert.deepInclude(yield* view.state(A), { open: true, target: 'login' });
          assert.isFalse((yield* view.state(B)).open, "another browser's view is untouched");
          assert.deepStrictEqual(yield* statusOf(B), loggedOut);
          const page = yield* viewPage(A);
          assert.strictEqual(new URL(page.url()).pathname, '/login/');
          assert.strictEqual((yield* statusOf(A)).state, 'window_open');
          // Opening it again while it's open just reports it.
          assert.strictEqual((yield* openLoginView(A)).state, 'window_open');

          yield* logInInView(page);
          const final = yield* pollStatus(A, (status) => status.state !== 'window_open');
          assert.deepStrictEqual(final, loggedIn);
          assert.isFalse((yield* view.state(A)).open, 'closed by itself');
          assert.isTrue(fs.existsSync(sessionFile(USER_ID)));
          assert.strictEqual(yield* boundTo(A), USER_ID);
          assert.isNull(yield* boundTo(B));
          assert.includeMembers(marketplaceCalls, resetOf(USER_ID));

          // Already logged in: no view opens.
          assert.deepStrictEqual(yield* openLoginView(A), loggedIn);
          assert.isFalse((yield* view.state(A)).open);
        }),
      60_000,
    );

    it.effect(
      'a login view saves under the account that logged in, unbinding the previous one first',
      () =>
        Effect.gen(function* () {
          yield* reset;
          const browser = yield* Browser;
          yield* login(A, 'plain@example.com');
          // Facebook ended that session; this time someone logs in with another account.
          yield* browser.clearSession(USER_ID);
          sessionCalls.length = 0;
          marketplaceCalls.length = 0;

          assert.strictEqual((yield* openLoginView(A)).state, 'window_open');
          yield* logInInView(yield* viewPage(A), '/marketplace/', OTHER_ID);
          assert.deepStrictEqual(yield* pollStatus(A, (status) => status.state !== 'window_open'), loggedInAs(OTHER_ID));
          assert.strictEqual(yield* boundTo(A), OTHER_ID);
          assert.deepStrictEqual(sessionCalls, [`unbind:${A}`, `bind:${A}:${OTHER_ID}`]);
          assert.isTrue(fs.existsSync(sessionFile(OTHER_ID)));
          assert.isFalse(fs.existsSync(sessionFile(USER_ID)));
          assert.includeMembers(marketplaceCalls, [...resetOf(USER_ID), ...resetOf(OTHER_ID)]);
        }),
      60_000,
    );

    it.effect(
      'returns to logged_out when the user closes the view without logging in',
      () =>
        Effect.gen(function* () {
          yield* reset;
          const view = yield* RemoteView;
          assert.strictEqual((yield* openLoginView(A)).state, 'window_open');
          yield* view.close(A);
          assert.deepStrictEqual(yield* statusOf(A), loggedOut);
          assert.deepStrictEqual(marketplaceCalls, [], 'an anonymous view changed no account');
          assert.isNull(yield* boundTo(A));
        }),
      60_000,
    );

    it.effect(
      'waits while the session cookie exists but Facebook is still on a 2FA page',
      () =>
        Effect.gen(function* () {
          yield* reset;
          yield* openLoginView(A);
          const page = yield* viewPage(A);
          yield* logInInView(page, '/two_step_verification/two_factor/');
          yield* Effect.sleep('1200 millis');
          assert.strictEqual((yield* statusOf(A)).state, 'window_open');

          yield* Effect.promise(() => page.goto('https://www.facebook.com/marketplace/'));
          assert.deepStrictEqual(yield* pollStatus(A, (status) => status.state !== 'window_open'), loggedIn);
        }),
      60_000,
    );

    it.effect(
      'logout cancels a login view in progress',
      () =>
        Effect.gen(function* () {
          yield* reset;
          const view = yield* RemoteView;
          yield* openLoginView(A);
          const page = yield* viewPage(A);
          // Session cookie set, still on the login page: the watcher keeps waiting.
          yield* Effect.promise(() =>
            page.evaluate((id) => {
              document.cookie = `c_user=${id}; domain=.facebook.com; path=/; secure; max-age=86400`;
            }, USER_ID),
          );
          assert.deepStrictEqual(yield* logout(A), loggedOut);
          assert.isFalse((yield* view.state(A)).open);
          yield* Effect.sleep('500 millis');
          assert.isFalse(fs.existsSync(sessionFile(USER_ID)));
          assert.deepStrictEqual(yield* statusOf(A), loggedOut);
        }),
      60_000,
    );

    it.effect(
      "logout closes the browser's account view before forgetting the session",
      () =>
        Effect.gen(function* () {
          yield* reset;
          const view = yield* RemoteView;
          yield* login(A, 'plain@example.com');
          yield* view.open(A, accountProfile(USER_ID), { target: 'inbox' });
          assert.deepStrictEqual(yield* logout(A), loggedOut);
          assert.isFalse((yield* view.state(A)).open);
          assert.isFalse(fs.existsSync(sessionFile(USER_ID)), "the view's cookies didn't come back");
          assert.deepStrictEqual(yield* statusOf(A), loggedOut);
        }),
      60_000,
    );

    it.effect('never logs or returns the password', () =>
      Effect.sync(() => {
        assert.notInclude(logged.join('\n'), PASSWORD);
        assert.notInclude(logged.join('\n'), 'wrong password');
      }),
    );
  });
});
