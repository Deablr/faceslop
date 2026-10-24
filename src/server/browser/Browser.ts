// Owns every Chrome instance the app uses. Ported from legacy/src/server/fb/browser.ts, minus the
// headed windows (they cannot work in Docker; the remote view replaces them). OWNER: foundation.
//
// - One headless Chrome, launched lazily on first use and closed when the runtime is disposed.
// - Hidden "scraping" contexts, one per Facebook profile (src/server/session/identity.ts), all
//   blocking images/media/fonts. Search/listing/messaging work happens in pages from them
//   (`withPage`, `openPage`):
//   - the anonymous context: no cookies, long-lived;
//   - one context per account, created on demand from `<sessionsDir>/<c_user>.json`. An account
//     whose session file is missing is served by the anonymous context, so callers need no
//     fallback (`hasSession` tells whether the account is really logged in). Account contexts
//     close after ACCOUNT_IDLE_MS without use (no lease, no open page; a sweeper fiber in the
//     layer scope), and at most MAX_ACCOUNT_CONTEXTS stay open: making room closes the least
//     recently used one that isn't in use (when every one is in use, the cap is exceeded rather
//     than killing pages someone is using). MAX_CONCURRENT_PAGES is one limit across profiles.
// - Session files: written atomically (tmp + rename), mode 0600, in a 0700 directory. Paths are
//   built only from FbUserIds (digits). When the layer is built, temp files of writes a crash
//   interrupted are removed, and the single-user file from before multi-user support
//   (`<dataDir>/fb-session.json`) is migrated once: it becomes its c_user's file, then it is removed.
// - `loginContext`: a fresh cookie-less context for password logins (saved explicitly).
// - `interactiveContext` for the remote view: no resource blocking, carries the profile's saved
//   cookies; when its scope closes, an account context still logged in to THAT account saves its
//   cookies back to the account's file. Anything else is discarded, so one account's cookies can
//   never end up in another account's file.
//
// Never launches a visible browser. Only this file imports `chromium`. Never logs cookie values.
import '@tanstack/react-start/server-only';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Clock, Context, Effect, Layer, Option, Schema, Semaphore, type Scope } from 'effect';
import { chromium, type Browser as PlaywrightBrowser, type BrowserContext, type Cookie, type LaunchOptions, type Page } from 'playwright';
import { AppConfig, type AppConfigShape, type ChromeChannel } from '@/server/config';
import { accountProfile, fbUserIdOf, type FbProfile, type FbUserId } from '@/server/session/identity';
import { AppError } from '@/shared/errors';

export const FB_ORIGIN = 'https://www.facebook.com';

/** At most this many `withPage` pages run at once (across all profiles); extra callers wait their turn. */
export const MAX_CONCURRENT_PAGES = 3;
/** An account's hidden context closes after this long without use (it reopens from its session file). */
export const ACCOUNT_IDLE_MS = 15 * 60_000;
/** How often idle account contexts are looked for. */
const ACCOUNT_SWEEP_MS = 30_000;
/** Open account contexts kept at most (exceeded only while every one of them is in use). */
export const MAX_ACCOUNT_CONTEXTS = 6;
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);
const HIDDEN_VIEWPORT = { width: 1280, height: 900 } as const;
export const DEFAULT_INTERACTIVE_VIEWPORT = { width: 1100, height: 860 } as const;
const BASE_ARGS = ['--disable-blink-features=AutomationControlled', '--no-default-browser-check'];

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface BrowserShape {
  /**
   * Run `use` with a fresh page from `profile`'s hidden context, then close the page (also on
   * failure or interruption). At most MAX_CONCURRENT_PAGES run at once, across all profiles.
   */
  readonly withPage: <A, E, R>(
    profile: FbProfile,
    use: (page: Page) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AppError, R>;
  /**
   * A page from `profile`'s hidden context that lives as long as the surrounding Scope (not
   * counted against the withPage limit). To keep one across requests (e.g. a search session for
   * "load more"), provide a scope you own: `Scope.make()` + `Scope.provide(scope)`, then `Scope.close`.
   * The page dies if the context is reset or evicted (callers already handle dead pages).
   */
  readonly openPage: (profile: FbProfile) => Effect.Effect<Page, AppError, Scope.Scope>;
  /** True when the account has a saved session file. */
  readonly hasSession: (userId: FbUserId) => Effect.Effect<boolean>;
  /** facebook.com cookies currently in `profile`'s hidden context. */
  readonly getCookies: (profile: FbProfile) => Effect.Effect<readonly Cookie[], AppError>;
  /**
   * Write a context's cookies/localStorage to the account's session file (mode 0600). With a
   * `context` (e.g. a login context), the account's hidden context is then reset so it picks them
   * up (its open pages die). Without one, the account's hidden context itself is saved and nothing
   * is reset (it already carries those cookies). Used after a login (the login context's cookies
   * become the account's session).
   * NOT_LOGGED_IN when the context isn't logged in to that account (its c_user cookie is missing
   * or another account's): one account's cookies never land in another account's file.
   */
  readonly saveSession: (userId: FbUserId, context?: BrowserContext) => Effect.Effect<void, AppError>;
  /** Close `profile`'s hidden context; the next use reloads it from its session file. Its open pages die with it. */
  readonly resetContext: (profile: FbProfile) => Effect.Effect<void>;
  /** Forget an account's Facebook session (logout): delete its session file and reset its hidden context. */
  readonly clearSession: (userId: FbUserId) => Effect.Effect<void, AppError>;
  /**
   * A fresh hidden-style context with NO cookies, for driving facebook.com/login (password login).
   * Nothing is saved automatically: on success the caller saves it with `saveSession`. Closed
   * with the scope.
   */
  readonly loginContext: Effect.Effect<BrowserContext, AppError, Scope.Scope>;
  /**
   * A headless context for the remote view: no resource blocking, loaded with `profile`'s saved
   * session (anonymous: no cookies). When the scope closes, an ACCOUNT context whose c_user cookie
   * is still that account has its cookies saved back to the account's session file and the
   * account's hidden context is reset; anything else (anonymous contexts, a different or missing
   * c_user) is discarded. A login view's cookies are saved explicitly by Auth (saveSession).
   */
  readonly interactiveContext: (
    profile: FbProfile,
    options?: { readonly viewport?: Viewport },
  ) => Effect.Effect<BrowserContext, AppError, Scope.Scope>;
}

/** Limits of the account contexts. The defaults are the product's; tests shrink them. */
export interface BrowserOptions {
  readonly accountIdleMs?: number;
  readonly sweepIntervalMs?: number;
  readonly maxAccountContexts?: number;
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Wrap a Playwright promise; failures become AppError INTERNAL with a readable message. */
const attempt = <A>(what: string, run: () => Promise<A>): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AppError({ code: 'INTERNAL', message: `${what}: ${messageOf(cause)}` }),
  });

/** The cookie fields we look at (Playwright's Cookie, or a cookie from a session file). */
interface CookieLike {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
}

const isFacebookDomain = (domain: string): boolean => domain === 'facebook.com' || domain.endsWith('.facebook.com');

/** The Facebook account a set of cookies is logged in to (its facebook.com c_user cookie), or null. */
export function facebookUserOf(cookies: readonly CookieLike[]): FbUserId | null {
  return fbUserIdOf(cookies.find((cookie) => cookie.name === 'c_user' && isFacebookDomain(cookie.domain))?.value);
}

/** The part of a Playwright storageState file the legacy migration reads. */
const StoredSession = Schema.fromJsonString(
  Schema.Struct({ cookies: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String, domain: Schema.String })) }),
);
const decodeStoredSession = Schema.decodeUnknownOption(StoredSession);

/** The temp file name of a session file write in progress: `<c_user>.json.<uuid>.tmp`. */
const UNFINISHED_WRITE = /^\d+\.json\.[\da-f-]+\.tmp$/;

/**
 * The platform token Chrome itself reports (reduced user agent). It must match the real OS:
 * Chrome's client hints (Sec-CH-UA-Platform) and navigator.platform still say the real one, so a
 * macOS user agent from a Linux container would be an inconsistency Facebook can see.
 */
const UA_PLATFORM =
  process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';

/** A normal desktop Chrome user agent for the running version (headless Chrome advertises "HeadlessChrome"). */
function userAgentFor(version: string): string {
  const major = version.split('.')[0] ?? '141';
  return `Mozilla/5.0 (${UA_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Launch attempts in order. 'auto': the user's Google Chrome, then Playwright's Chromium, then the headless shell. */
function launchPlan(channel: ChromeChannel): readonly { readonly label: string; readonly channel: string | undefined }[] {
  const chrome = { label: 'Google Chrome', channel: 'chrome' };
  const chromiumFull = { label: "Playwright's Chromium", channel: 'chromium' };
  const shell = { label: 'chromium-headless-shell', channel: undefined };
  switch (channel) {
    case 'chrome':
      return [chrome];
    case 'chromium':
      return [chromiumFull];
    case 'headless-shell':
      return [shell];
    case 'auto':
      return [chrome, chromiumFull, shell];
  }
}

function launchOptions(config: AppConfigShape): LaunchOptions {
  const args = [...BASE_ARGS];
  if (config.docker) args.push('--disable-dev-shm-usage');
  args.push(...config.chrome.extraArgs);
  // Always headless: faceslop never opens windows on the user's screen.
  // Playwright's own signal handlers would kill Chrome on SIGINT/SIGTERM/SIGHUP before the runtime's
  // finalizers run, losing an open remote view's cookies; runtime.ts disposes everything instead.
  return {
    headless: true,
    args,
    // Playwright adds --no-sandbox unless this is true: Chrome renders seller-controlled content.
    chromiumSandbox: !config.chrome.noSandbox,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
}

const launch = Effect.fn('Browser.launch')(function* (config: AppConfigShape) {
  const options = launchOptions(config);
  const failures: string[] = [];
  for (const candidate of launchPlan(config.chrome.channel)) {
    const launched = yield* Effect.tryPromise(() =>
      chromium.launch(candidate.channel === undefined ? options : { ...options, channel: candidate.channel }),
    ).pipe(
      Effect.map((browser): PlaywrightBrowser | null => browser),
      Effect.catch((cause) => {
        failures.push(`${candidate.label}: ${messageOf(cause).split('\n')[0] ?? ''}`);
        return Effect.succeed(null);
      }),
    );
    if (launched) {
      yield* Effect.logInfo(`[browser] launched ${candidate.label} ${launched.version()} (headless)`);
      return launched;
    }
  }
  return yield* new AppError({
    code: 'INTERNAL',
    message: `Could not start Chrome or Chromium. Install Google Chrome, or run "npx playwright install chromium".${
      config.chrome.noSandbox ? '' : ' If Chrome cannot start its sandbox on this host, set FACESLOP_CHROME_NO_SANDBOX=1.'
    } (${failures.join('; ')})`,
  });
});

/** One hidden context. `users` and `lastUsedAt` are only changed synchronously (no await in between). */
interface Hidden {
  readonly context: BrowserContext;
  /** Leases held right now: withPage work, cookie/session reads, a page being opened. */
  users: number;
  lastUsedAt: number;
}

/** In use: leased, or a page (withPage or openPage) still open in it. */
const inUse = (hidden: Hidden): boolean => hidden.users > 0 || hidden.context.pages().length > 0;

const fileExists = (file: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    fs.access(file).then(
      () => true,
      () => false,
    ),
  );

const closeContext = (context: BrowserContext | undefined): Effect.Effect<void> =>
  Effect.promise(() => context?.close().catch(() => undefined) ?? Promise.resolve());

const closePage = (page: Page): Effect.Effect<void> => Effect.promise(() => page.close().catch(() => undefined));

const make = Effect.fnUntraced(function* (options: BrowserOptions = {}) {
  const config = yield* AppConfig;
  const accountIdleMs = options.accountIdleMs ?? ACCOUNT_IDLE_MS;
  const maxAccountContexts = options.maxAccountContexts ?? MAX_ACCOUNT_CONTEXTS;

  // Mutable handles to Playwright objects. Playwright reports disconnects/closes through
  // callbacks, so these are plain variables, only replaced while holding `lifecycle`.
  let browser: PlaywrightBrowser | null = null;
  let anonymous: Hidden | null = null;
  const accounts = new Map<FbUserId, Hidden>();
  const lifecycle = yield* Semaphore.make(1);
  const pages = yield* Semaphore.make(MAX_CONCURRENT_PAGES);

  // ----- session files -----

  /** `<sessionsDir>/<userId>.json`. The id is checked to be digits, so it can't name another path. */
  const sessionFileOf = (userId: FbUserId): Effect.Effect<string> =>
    fbUserIdOf(userId) === null
      ? Effect.die(new Error('Session files are named by Facebook user id (digits only).'))
      : Effect.succeed(path.join(config.sessionsDir, `${userId}.json`));

  /** Atomically replace a session file: a private temp file (0600) renamed over it, in a 0700 directory. */
  const writeSessionFile = (file: string, contents: string) =>
    attempt('Could not save the Facebook session', async () => {
      await fs.mkdir(config.sessionsDir, { recursive: true, mode: 0o700 });
      await fs.chmod(config.sessionsDir, 0o700);
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(tmp, contents, { mode: 0o600, flag: 'wx' });
        await fs.chmod(tmp, 0o600);
        await fs.rename(tmp, file);
      } catch (cause) {
        await fs.rm(tmp, { force: true });
        throw cause;
      }
    });

  /**
   * The single-user session file from before multi-user support becomes its c_user's session file
   * (unless that account already has one), then it is removed. An unreadable file is left alone.
   */
  const migrateLegacySession = Effect.gen(function* () {
    const legacy = config.legacySessionFile;
    if (!(yield* fileExists(legacy))) return;
    const text = yield* attempt('Could not read the old Facebook session file', () => fs.readFile(legacy, 'utf8'));
    const stored = decodeStoredSession(text);
    if (Option.isNone(stored)) {
      return yield* Effect.logWarning(`[browser] ${legacy} is not a Facebook session file; left in place.`);
    }
    const userId = facebookUserOf(stored.value.cookies);
    if (userId !== null) {
      const file = yield* sessionFileOf(userId);
      if (!(yield* fileExists(file))) yield* writeSessionFile(file, text);
    }
    yield* attempt('Could not remove the old Facebook session file', () => fs.rm(legacy, { force: true }));
    yield* Effect.logInfo(
      userId === null
        ? '[browser] removed the old Facebook session file (it was logged out).'
        : '[browser] moved the old Facebook session file to the per-account session files.',
    );
  }).pipe(Effect.catch((error) => Effect.logWarning(`[browser] ${error.message}`)));

  /**
   * A write interrupted between writeFile and rename (crash, SIGKILL, power loss) leaves its temp
   * file behind, and it holds that account's cookies: remove such files. Only safe while no write
   * is in flight, i.e. before this layer serves anything (a replaced runtime is disposed first).
   */
  const removeUnfinishedWrites = Effect.gen(function* () {
    if (!(yield* fileExists(config.sessionsDir))) return;
    const names = yield* attempt('Could not list the Facebook session files', () => fs.readdir(config.sessionsDir));
    const unfinished = names.filter((name) => UNFINISHED_WRITE.test(name));
    yield* Effect.forEach(
      unfinished,
      (name) => attempt('Could not remove an unfinished session file', () => fs.rm(path.join(config.sessionsDir, name), { force: true })),
      { discard: true },
    );
    if (unfinished.length > 0) yield* Effect.logInfo(`[browser] removed ${unfinished.length} unfinished session file write(s).`);
  }).pipe(Effect.catch((error) => Effect.logWarning(`[browser] ${error.message}`)));

  // Once, before anything reads or writes a session file.
  yield* removeUnfinishedWrites;
  yield* migrateLegacySession;

  // ----- Chrome and the hidden contexts -----
  // ensureBrowser, newHiddenContext, makeRoom, anonymousHidden and hiddenFor run while holding
  // `lifecycle`; withLease, resetAccount and the sweeper take it themselves.

  const ensureBrowser = Effect.gen(function* () {
    if (browser?.isConnected()) return browser;
    const launched = yield* launch(config);
    launched.on('disconnected', () => {
      if (browser === launched) {
        browser = null;
        anonymous = null;
        accounts.clear();
      }
    });
    browser = launched;
    return launched;
  });

  /** A context with our user agent and locale, optionally loaded from a session file. */
  const newContext = (target: PlaywrightBrowser, viewport: Viewport, storageState: string | undefined) =>
    attempt('Could not open a browser context', () =>
      target.newContext({
        userAgent: userAgentFor(target.version()),
        locale: 'en-US',
        viewport,
        ...(storageState === undefined ? {} : { storageState }),
      }),
    );

  /** A context for background work: data comes from embedded JSON and GraphQL, so heavy assets are skipped. */
  const newHiddenContext = Effect.fnUntraced(function* (storageState: string | undefined) {
    const context = yield* newContext(yield* ensureBrowser, HIDDEN_VIEWPORT, storageState);
    yield* attempt('Could not configure the hidden browser', () =>
      context.route('**/*', (route) =>
        BLOCKED_RESOURCE_TYPES.has(route.request().resourceType()) ? route.abort() : route.fallback(),
      ),
    ).pipe(Effect.onError(() => closeContext(context)));
    return context;
  });

  /** Close the least recently used account contexts not in use until there is room for one more. */
  const makeRoom = Effect.suspend(() => {
    const evicted: Hidden[] = [];
    while (accounts.size >= maxAccountContexts) {
      let oldest: readonly [FbUserId, Hidden] | null = null;
      for (const entry of accounts) {
        if (!inUse(entry[1]) && (oldest === null || entry[1].lastUsedAt < oldest[1].lastUsedAt)) oldest = entry;
      }
      if (oldest === null) break;
      accounts.delete(oldest[0]);
      evicted.push(oldest[1]);
    }
    return Effect.forEach(evicted, (hidden) => closeContext(hidden.context), { discard: true });
  });

  const anonymousHidden = Effect.gen(function* () {
    if (anonymous) return anonymous;
    const context = yield* newHiddenContext(undefined);
    const hidden: Hidden = { context, users: 0, lastUsedAt: yield* Clock.currentTimeMillis };
    context.on('close', () => {
      if (anonymous === hidden) anonymous = null;
    });
    anonymous = hidden;
    return hidden;
  });

  /** The hidden context serving `profile`: its account's (opened from its file), else the anonymous one. */
  const hiddenFor = Effect.fnUntraced(function* (profile: FbProfile) {
    if (profile.kind === 'anonymous') return yield* anonymousHidden;
    const userId = profile.userId;
    const existing = accounts.get(userId);
    if (existing) return existing;
    const file = yield* sessionFileOf(userId);
    if (!(yield* fileExists(file))) return yield* anonymousHidden;
    yield* makeRoom;
    const context = yield* newHiddenContext(file);
    const hidden: Hidden = { context, users: 0, lastUsedAt: yield* Clock.currentTimeMillis };
    context.on('close', () => {
      if (accounts.get(userId) === hidden) accounts.delete(userId);
    });
    accounts.set(userId, hidden);
    return hidden;
  });

  /** Mark a hidden context used now, adding `users` to its lease count. */
  const touch = (hidden: Hidden, users: number) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      hidden.users += users;
      hidden.lastUsedAt = now;
    });

  /** Use `profile`'s hidden context; it can't be closed as idle (or evicted) while `use` runs. */
  const withLease = <A, E, R>(profile: FbProfile, use: (hidden: Hidden) => Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      lifecycle.withPermits(1)(
        Effect.map(hiddenFor(profile), (hidden) => {
          hidden.users++;
          return hidden;
        }),
      ),
      use,
      (hidden) => touch(hidden, -1),
    );

  /** Take an account's hidden context out of service and close it (its pages die). */
  const resetAccount = (userId: FbUserId) =>
    lifecycle.withPermits(1)(
      Effect.suspend(() => {
        const hidden = accounts.get(userId);
        accounts.delete(userId);
        return closeContext(hidden?.context);
      }),
    );

  // Close account contexts idle for accountIdleMs. A context in use counts as used now.
  const sweep = lifecycle.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const idle: Hidden[] = [];
      for (const [userId, hidden] of accounts) {
        if (inUse(hidden)) hidden.lastUsedAt = now;
        else if (now - hidden.lastUsedAt >= accountIdleMs) {
          accounts.delete(userId);
          idle.push(hidden);
        }
      }
      yield* Effect.forEach(idle, (hidden) => closeContext(hidden.context), { discard: true });
    }),
  );
  // Interrupted when the runtime is disposed.
  yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(options.sweepIntervalMs ?? ACCOUNT_SWEEP_MS), sweep)));

  // ----- the service -----

  const newPageIn = (hidden: Hidden) => attempt('Could not open a page in the hidden browser', () => hidden.context.newPage());

  const withPage = <A, E, R>(profile: FbProfile, use: (page: Page) => Effect.Effect<A, E, R>): Effect.Effect<A, E | AppError, R> =>
    pages.withPermits(1)(withLease(profile, (hidden) => Effect.acquireUseRelease(newPageIn(hidden), use, closePage)));

  const openPage = (profile: FbProfile) =>
    Effect.map(
      Effect.acquireRelease(
        withLease(profile, (hidden) => Effect.map(newPageIn(hidden), (page) => ({ page, hidden }))),
        // The open page kept the context in use; its idle time starts when it closes.
        ({ page, hidden }) => Effect.andThen(closePage(page), touch(hidden, 0)),
      ),
      ({ page }) => page,
    );

  const hasSession = (userId: FbUserId) => Effect.flatMap(sessionFileOf(userId), fileExists);

  const getCookies = (profile: FbProfile) =>
    withLease(profile, (hidden) => attempt('Could not read cookies', () => hidden.context.cookies(FB_ORIGIN)));

  const readState = (context: BrowserContext) => attempt('Could not read the browser session', () => context.storageState());

  /** Store `context`'s state as the account's session when it is logged in to that account. False otherwise. */
  const saveIfOwnedBy = Effect.fnUntraced(function* (userId: FbUserId, context: BrowserContext) {
    const file = yield* sessionFileOf(userId);
    const state = yield* readState(context);
    if (facebookUserOf(state.cookies) !== userId) return false;
    yield* writeSessionFile(file, JSON.stringify(state));
    return true;
  });

  const saveSession = Effect.fn('Browser.saveSession')(function* (userId: FbUserId, context?: BrowserContext) {
    // The account's own hidden context already carries what it saves: no reset needed then.
    const saved =
      context === undefined
        ? yield* withLease(accountProfile(userId), (hidden) => saveIfOwnedBy(userId, hidden.context))
        : yield* saveIfOwnedBy(userId, context);
    if (!saved) {
      return yield* new AppError({ code: 'NOT_LOGGED_IN', message: 'That browser session is not logged in to this Facebook account.' });
    }
    if (context !== undefined) yield* resetAccount(userId);
  });

  const resetContext = (profile: FbProfile): Effect.Effect<void> =>
    profile.kind === 'account'
      ? resetAccount(profile.userId)
      : lifecycle.withPermits(1)(
          Effect.suspend(() => {
            const hidden = anonymous;
            anonymous = null;
            return closeContext(hidden?.context);
          }),
        );

  const clearSession = Effect.fn('Browser.clearSession')(function* (userId: FbUserId) {
    const file = yield* sessionFileOf(userId);
    // Under `lifecycle`, so no account context is being opened from the file while it goes away.
    yield* lifecycle.withPermits(1)(
      Effect.gen(function* () {
        yield* attempt('Could not delete the Facebook session', () => fs.rm(file, { force: true }));
        const hidden = accounts.get(userId);
        accounts.delete(userId);
        yield* closeContext(hidden?.context);
      }),
    );
  });

  const loginContext = Effect.acquireRelease(lifecycle.withPermits(1)(newHiddenContext(undefined)), closeContext);

  const interactiveContext = (profile: FbProfile, viewOptions?: { readonly viewport?: Viewport }) =>
    Effect.acquireRelease(
      lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const target = yield* ensureBrowser;
          const file = profile.kind === 'account' ? yield* sessionFileOf(profile.userId) : undefined;
          const storageState = file !== undefined && (yield* fileExists(file)) ? file : undefined;
          return yield* newContext(target, viewOptions?.viewport ?? DEFAULT_INTERACTIVE_VIEWPORT, storageState);
        }),
      ),
      (context) =>
        Effect.gen(function* () {
          // The user may have changed things in the remote view (or Facebook refreshed cookies):
          // keep them as the account's session, unless the view ended up in another account (or
          // logged out). The account's hidden context reloads from the file.
          if (profile.kind === 'account') {
            const saved = yield* saveIfOwnedBy(profile.userId, context).pipe(
              Effect.catch((error) => Effect.as(Effect.logWarning(`[browser] ${error.message}`), false)),
            );
            if (saved) yield* resetAccount(profile.userId);
          }
          yield* closeContext(context);
        }),
    );

  // Runtime disposal (SIGINT/SIGTERM, HMR teardown) closes Chrome.
  yield* Effect.addFinalizer(() =>
    lifecycle.withPermits(1)(
      Effect.gen(function* () {
        const contexts = [anonymous, ...accounts.values()];
        const current = browser;
        anonymous = null;
        accounts.clear();
        browser = null;
        yield* Effect.forEach(contexts, (hidden) => closeContext(hidden?.context), { discard: true });
        yield* Effect.promise(() => current?.close().catch(() => undefined) ?? Promise.resolve());
      }),
    ),
  );

  return Browser.of({
    withPage,
    openPage,
    hasSession,
    getCookies,
    saveSession,
    resetContext,
    clearSession,
    loginContext,
    interactiveContext,
  });
});

export class Browser extends Context.Service<Browser, BrowserShape>()('faceslop/server/Browser') {
  /** Requires AppConfig. Lazy: Chrome starts on first use, not when the layer is built. */
  static readonly layerNoDeps = Layer.effect(Browser, make());
  /** layerNoDeps with other limits (tests: short idle times, fewer account contexts). */
  static readonly layerNoDepsWith = (options: BrowserOptions) => Layer.effect(Browser, make(options));
  static readonly layer = Browser.layerNoDeps.pipe(Layer.provide(AppConfig.layer));
}
