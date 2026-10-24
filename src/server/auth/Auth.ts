// Facebook login / logout / session status, per browser session. OWNER: auth builder.
//
// Port of legacy/src/server/fb/auth.ts for several browsers and Facebook accounts (who is who:
// src/server/session/identity.ts). Two ways in:
// - loginWithPassword drives facebook.com/login in a fresh, cookie-less context
//   (Browser.loginContext) owned by THIS session's attempt, kept across a 2FA code or "approve
//   from another device" step (expires after 10 minutes). At most MAX_PASSWORD_LOGINS run at once
//   across all sessions (each one holds a Chrome context).
// - openLoginView opens this session's remote view on Facebook's login page (anonymous profile,
//   no cookies) and watches it for the c_user session cookie: one watcher per session (a newer one
//   supersedes it), for at most 15 minutes. Once Facebook has let the user through, the view's
//   cookies are saved and the view closes.
// On success (either way) the context's c_user cookie names the account. A session bound to a
// DIFFERENT account is unbound first, as logout does; then Browser.saveSession(uid, context),
// Sessions.bindAccount, and Marketplace.closeAllSessions + clearListingCache for that account.
// A Marketplace view of the same account this session already has open gets the new cookies too.
//
// `status` with `verify` asks Facebook (session-probe.ts). A session Facebook has ended is deleted
// (Browser.clearSession) and the binding kept; an open view of the account never writes it back
// when it closes (RemoteView drops a login that is no longer the saved one).
//
// A session's login steps (and its logout) run one at a time; different sessions never wait for
// each other. A failed or expired attempt keeps reporting its message to THAT session for 5
// minutes before status falls back to logged_out. Viewer names are fetched lazily (one probe of
// facebook.com per account, shared by concurrent callers) and cached per user id.
//
// Passwords are typed into Facebook's form and never logged, stored, or returned; Playwright's
// error messages (which can echo typed values) never reach the client.
import '@tanstack/react-start/server-only';
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Scope } from 'effect';
import type { BrowserContext, Page } from 'playwright';
import {
  type LoginOutcome,
  enterLoginCode,
  fillLoginForm,
  readLoginStep,
  waitForLoginOutcome,
} from '@/server/auth/auth-page';
import { USE_LOGIN_VIEW, isAuthUrl, userIdFromCookies } from '@/server/auth/auth-parse';
import { type Probe, UNKNOWN_PROBE, isSavedLogin, probeAccountSession } from '@/server/auth/session-probe';
import { Browser, FB_ORIGIN } from '@/server/browser/Browser';
import { Marketplace } from '@/server/marketplace/Marketplace';
import { RemoteView } from '@/server/remote-view/RemoteView';
import { makeKeyedLock } from '@/server/remote-view/keyed-lock';
import { LOGIN_URL } from '@/server/remote-view/targets';
import {
  ANONYMOUS_PROFILE,
  type ClientSession,
  type ClientSessionId,
  type FbProfile,
  type FbUserId,
  accountProfile,
  fbUserIdOf,
} from '@/server/session/identity';
import { Sessions } from '@/server/session/Sessions';
import { notImplemented } from '@/server/stub';
import type { AuthState, AuthStatus, LoginRequest } from '@/shared/domain';
import { AppError } from '@/shared/errors';

export interface AuthShape {
  /**
   * This browser's state. Cheap (its binding, the account's cookies, a login in progress here);
   * `verify` does a live check against Facebook. Not logged in: `logged_out`, or the state of a
   * login in progress in this session. `userId` is the account this browser is bound to in every
   * state (also after its Facebook session ended); null only while unbound.
   */
  readonly status: (session: ClientSession, options?: { readonly verify?: boolean }) => Effect.Effect<AuthStatus, AppError>;
  /** True when this browser is bound to an account whose Facebook session (c_user cookie) is present. */
  readonly isLoggedIn: (session: ClientSession) => Effect.Effect<boolean>;
  /**
   * Log in by driving facebook.com/login in a fresh, cookie-less context (Browser.loginContext)
   * for this session. Never stores or logs the password. On success: save the context's cookies
   * as the account's session (Browser.saveSession), bind this session (Sessions.bindAccount), and
   * reset the account's search sessions and listing cache.
   */
  readonly loginWithPassword: (session: ClientSession, request: LoginRequest) => Effect.Effect<AuthStatus, AppError>;
  /** Submit a 2FA / login code after loginWithPassword returned needs_code (this session's attempt). */
  readonly submitLoginCode: (session: ClientSession, code: string) => Effect.Effect<AuthStatus, AppError>;
  /**
   * Open this session's remote view on Facebook's login page (anonymous profile, no cookies) and
   * watch it for the c_user cookie; then save that context as the account's session, bind this
   * session, and close the view. Returns `window_open` (or logged_in if already).
   */
  readonly openLoginView: (session: ClientSession) => Effect.Effect<AuthStatus, AppError>;
  /**
   * Cancel this session's login in progress (a password attempt waiting for Facebook, a code or an
   * approval, or the login view), closing a login view. Any binding stays: the browser is still
   * linked to its account. Returns the status afterwards.
   */
  readonly cancelLogin: (session: ClientSession) => Effect.Effect<AuthStatus, AppError>;
  /**
   * Log out of Facebook on this device: cancel this session's login in progress, close its remote
   * view (BEFORE touching the session file: closing an account view saves its cookies back),
   * unbind it (Sessions.unbindAccount), reset the account's search sessions and listing cache, and
   * delete the account's Facebook session (Browser.clearSession) only when no other session in
   * use (seen within ACTIVE_SESSION_WINDOW_MS) is still bound to it.
   */
  readonly logout: (session: ClientSession) => Effect.Effect<AuthStatus, AppError>;
}

export interface AuthOptions {
  /** How often the login view is checked for a finished login (default 1 second). */
  readonly viewPollMs?: number;
  /** How long the view must stay past the login pages before it closes (default 1.5 seconds). */
  readonly viewSettleMs?: number;
  /** How long a login view is watched before it is closed unfinished (default 15 minutes). */
  readonly viewWatchMs?: number;
}

/** Password logins in progress at once, across all sessions. */
export const MAX_PASSWORD_LOGINS = 2;
const FLOW_TTL_MS = 10 * 60_000;
/** Approval polling + expiry checks for pending password logins. */
const FLOW_TICK = '3 seconds';
/** How long a failed/expired login keeps reporting its message before status falls back to logged_out. */
const OUTCOME_TTL_MS = 5 * 60_000;
const NAME_WAIT = '4 seconds';
const NAME_RETRY_MS = 5 * 60_000;
const VIEW_POLL_MS = 1000;
const VIEW_SETTLE_MS = 1500;
const VIEW_WATCH_MS = 15 * 60_000;

const VIEW_MESSAGE = "Finish logging in on Facebook's page. It closes by itself once you're in.";
const BUSY_MESSAGE = 'Another login is in progress. Try again in a minute.';
const SESSION_ENDED = 'Your Facebook session has ended. Log in again.';

/** One session's password login. Mutable fields are only touched while holding that session's lock. */
interface PasswordAttempt {
  readonly sessionId: ClientSessionId;
  /** Who is logging in (not secret); a repeated submit for the same account doesn't restart the attempt. */
  readonly email: string;
  readonly context: BrowserContext;
  readonly page: Page;
  /** Owns the login context. */
  readonly scope: Scope.Closeable;
  readonly expiresAt: number;
  state: 'logging_in' | 'needs_code' | 'needs_approval';
  message: string | null;
}

/** One session's login view being watched. */
interface ViewWatch {
  readonly sessionId: ClientSessionId;
  fiber: Fiber.Fiber<void> | null;
}

/** How a session's last login attempt ended without a session (shown for a while). */
interface Outcome {
  readonly state: 'error' | 'logged_out';
  readonly message: string;
  readonly at: number;
}

function statusOf(state: AuthState, message: string | null = null, userId: string | null = null, userName: string | null = null): AuthStatus {
  return { state, userId, userName, message };
}

const WINDOW_OPEN = statusOf('window_open', VIEW_MESSAGE);

function attemptStatus(attempt: PasswordAttempt): AuthStatus {
  return statusOf(attempt.state, attempt.message ?? (attempt.state === 'logging_in' ? 'Logging in to Facebook…' : null));
}

/** Playwright's own error text can echo typed values: only ever say whether it was a timeout. */
const isTimeout = (cause: unknown): boolean => cause instanceof Error && cause.name === 'TimeoutError';

/** The account a context is logged in to (its c_user cookie), or null. */
const contextUserId = (context: BrowserContext): Effect.Effect<FbUserId | null> =>
  Effect.tryPromise(() => context.cookies(FB_ORIGIN)).pipe(
    Effect.map((cookies) => fbUserIdOf(userIdFromCookies(cookies))),
    Effect.orElseSucceed(() => null),
  );

/** A view page Facebook has let through: session cookie set, and no longer on a login/2FA page. */
async function pastLogin(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  const cookies = await page.context().cookies(FB_ORIGIN);
  return userIdFromCookies(cookies) !== null && !page.isClosed() && !isAuthUrl(page.url());
}

const make = Effect.fnUntraced(function* (options: AuthOptions = {}) {
  const browser = yield* Browser;
  const remoteView = yield* RemoteView;
  const marketplace = yield* Marketplace;
  const sessions = yield* Sessions;
  const layerScope = yield* Effect.scope;
  const viewPollMs = options.viewPollMs ?? VIEW_POLL_MS;
  const viewSettleMs = options.viewSettleMs ?? VIEW_SETTLE_MS;
  const viewWatchMs = options.viewWatchMs ?? VIEW_WATCH_MS;

  /** A session's login steps and logout run one at a time. */
  const locks = makeKeyedLock<ClientSessionId>();
  const attempts = new Map<ClientSessionId, PasswordAttempt>();
  /** Sessions whose password attempt is being set up (counted against MAX_PASSWORD_LOGINS). */
  const starting = new Set<ClientSessionId>();
  const watches = new Map<ClientSessionId, ViewWatch>();
  const outcomes = new Map<ClientSessionId, Outcome>();
  /** Viewer names per account (null: Facebook didn't say). */
  const names = new Map<FbUserId, string | null>();
  const nameFailedAt = new Map<FbUserId, number>();
  const probing = new Map<FbUserId, Deferred.Deferred<Probe>>();

  const exclusive = <A, E, R>(sessionId: ClientSessionId, effect: Effect.Effect<A, E, R>) => locks.withLock(sessionId, effect);

  const remember = (sessionId: ClientSessionId, state: 'error' | 'logged_out', message: string) =>
    Effect.map(Clock.currentTimeMillis, (at) => {
      outcomes.set(sessionId, { state, message, at });
      return statusOf(state, message);
    });

  /** The session's remembered outcome while it is fresh, else logged_out. */
  const rememberedOrLoggedOut = (sessionId: ClientSessionId) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const outcome = outcomes.get(sessionId);
      if (outcome && now - outcome.at < OUTCOME_TTL_MS) return statusOf(outcome.state, outcome.message);
      outcomes.delete(sessionId);
      return statusOf('logged_out');
    });

  /** The account's cookies changed: its search pages and cached listing details are stale. */
  const accountChanged = (profile: FbProfile) =>
    Effect.andThen(marketplace.closeAllSessions(profile), marketplace.clearListingCache(profile)).pipe(
      Effect.catchCause((cause) => Effect.logWarning('[auth] could not reset Marketplace sessions', cause)),
    );

  /** Forget a password attempt (if it is still the session's) and close its login context. */
  const dropAttempt = (attempt: PasswordAttempt) =>
    Effect.suspend(() => {
      if (attempts.get(attempt.sessionId) === attempt) attempts.delete(attempt.sessionId);
      return Scope.close(attempt.scope, Exit.void);
    });

  /** Cancel the session's logins in progress (closes its login context / stops watching its view). */
  const endFlows = (sessionId: ClientSessionId) =>
    Effect.suspend(() => {
      const attempt = attempts.get(sessionId);
      const watch = watches.get(sessionId);
      watches.delete(sessionId);
      return Effect.andThen(
        attempt ? dropAttempt(attempt) : Effect.void,
        // Callers hold the session's lock, and the watcher finishes under that lock, so this never
        // interrupts a login half saved (nor the watcher itself).
        watch?.fiber ? Fiber.interrupt(watch.fiber) : Effect.void,
      );
    });

  // ---------- session ----------

  /** The account has a saved session whose c_user cookie is still that account. */
  const accountLoggedIn = (userId: FbUserId) =>
    Effect.gen(function* () {
      if (!(yield* browser.hasSession(userId))) return false;
      return userIdFromCookies(yield* browser.getCookies(accountProfile(userId))) === userId;
    });

  const isLoggedIn = (session: ClientSession) =>
    session.fbUserId === null ? Effect.succeed(false) : accountLoggedIn(session.fbUserId).pipe(Effect.orElseSucceed(() => false));

  /** One probe per account at a time; concurrent callers share it. It runs in the service scope, so callers may stop waiting. */
  const probeOnce = (userId: FbUserId): Effect.Effect<Probe> =>
    Effect.suspend(() => {
      const running = probing.get(userId);
      if (running) return Deferred.await(running);
      const deferred = Deferred.makeUnsafe<Probe>();
      probing.set(userId, deferred);
      return probeAccountSession(browser, userId).pipe(
        Effect.tap(({ check }) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.sync(() => {
              if (check.kind === 'alive' && check.userId === userId) names.set(userId, check.name);
              else nameFailedAt.set(userId, now);
            }),
          ),
        ),
        Effect.onExit((exit) =>
          Effect.andThen(
            Effect.sync(() => {
              if (probing.get(userId) === deferred) probing.delete(userId);
            }),
            Deferred.done(deferred, Exit.isSuccess(exit) ? exit : Exit.succeed(UNKNOWN_PROBE)),
          ),
        ),
        Effect.forkIn(layerScope),
        Effect.andThen(Deferred.await(deferred)),
      );
    });

  /** The account's display name, fetched once per account (waits briefly; null until known). */
  const userNameFor = (userId: FbUserId) =>
    Effect.gen(function* () {
      if (names.has(userId)) return names.get(userId) ?? null;
      const now = yield* Clock.currentTimeMillis;
      if (now - (nameFailedAt.get(userId) ?? 0) < NAME_RETRY_MS) return null;
      yield* probeOnce(userId).pipe(Effect.timeoutOption(NAME_WAIT));
      return names.get(userId) ?? null;
    });

  /** Status of a bound session whose account has a saved session; `verify` asks Facebook. */
  const accountStatus = (sessionId: ClientSessionId, userId: FbUserId, verify: boolean) =>
    Effect.gen(function* () {
      if (verify) {
        const { check, token } = yield* probeOnce(userId);
        // (A login that replaced the session while the probe ran is not the one Facebook ended.)
        if (check.kind === 'logged_out' && (yield* isSavedLogin(browser, userId, token))) {
          // The binding stays: the session's data still belongs to the account. An open view of
          // the account doesn't write the dead login back when it closes (RemoteView drops it).
          yield* browser.clearSession(userId).pipe(Effect.ignore);
          names.delete(userId);
          yield* accountChanged(accountProfile(userId));
          return yield* remember(sessionId, 'logged_out', SESSION_ENDED);
        }
        if (check.kind === 'checkpoint') {
          return statusOf(
            'error',
            `Facebook wants you to confirm something about your account. ${USE_LOGIN_VIEW}`,
            userId,
            names.get(userId) ?? null,
          );
        }
        // The probe checked the session as it was. Meanwhile another browser's check may have
        // deleted it (or the probe's context was closed under it, an unknown result): only a
        // session that is still saved counts as logged in.
        if (!(yield* accountLoggedIn(userId).pipe(Effect.orElseSucceed(() => false)))) {
          return check.kind === 'logged_out' ? yield* remember(sessionId, 'logged_out', SESSION_ENDED) : yield* rememberedOrLoggedOut(sessionId);
        }
      }
      return statusOf('logged_in', null, userId, yield* userNameFor(userId));
    });

  /** Notice a login of this session that ended on its own (view closed, login page gone, attempt expired). */
  const reconcile = (sessionId: ClientSessionId) =>
    Effect.gen(function* () {
      const watch = watches.get(sessionId);
      if (watch) {
        const view = yield* remoteView.state(sessionId);
        // Closed by the user (an anonymous view: nothing is saved) or moved to another page. The
        // watcher notices on its next tick and stops.
        if ((!view.open || view.target !== 'login') && watches.get(sessionId) === watch) watches.delete(sessionId);
      }
      const attempt = attempts.get(sessionId);
      if (!attempt) return;
      if (attempt.page.isClosed()) {
        yield* dropAttempt(attempt);
        yield* remember(sessionId, 'error', 'The login was interrupted. Start again.');
        return;
      }
      if ((yield* Clock.currentTimeMillis) >= attempt.expiresAt) {
        yield* dropAttempt(attempt);
        yield* remember(sessionId, 'error', 'The login attempt expired. Start again.');
      }
    });

  const statusNow = Effect.fnUntraced(function* (session: ClientSession, statusOptions?: { readonly verify?: boolean }) {
    yield* reconcile(session.id);
    const attempt = attempts.get(session.id);
    if (attempt) return attemptStatus(attempt);
    if (watches.has(session.id)) return WINDOW_OPEN;

    const userId = session.fbUserId;
    if (userId !== null) {
      const found = yield* Effect.result(accountLoggedIn(userId));
      if (found._tag === 'Failure') return statusOf('error', found.failure.message);
      if (found.success) {
        outcomes.delete(session.id);
        return yield* accountStatus(session.id, userId, statusOptions?.verify === true);
      }
    }
    return yield* rememberedOrLoggedOut(session.id);
  });

  /**
   * Every status names the account this browser is bound to (null only while unbound), also after
   * its Facebook session ended or while another login runs, so the UI can still offer "Log out on
   * this device" and keep showing the account's data.
   */
  const status = Effect.fn('Auth.status')(function* (session: ClientSession, statusOptions?: { readonly verify?: boolean }) {
    const current = yield* statusNow(session, statusOptions);
    return current.userId === null && session.fbUserId !== null ? { ...current, userId: session.fbUserId } : current;
  });

  /** The session's status as it is now (fresh binding from Sessions). */
  const currentStatus = (sessionId: ClientSessionId) =>
    Effect.flatMap(sessions.get(sessionId), (found) =>
      Option.isSome(found) ? status(found.value) : rememberedOrLoggedOut(sessionId),
    );

  /** Already logged in? Double-check with Facebook before starting another login. */
  const liveSession = (session: ClientSession) =>
    Effect.gen(function* () {
      if (!(yield* isLoggedIn(session))) return null;
      const current = yield* status(session, { verify: true });
      return current.state === 'logged_in' ? current : null;
    });

  // ---------- finishing a login (both ways) ----------

  /**
   * Log this session out of its account (logout, or before binding it to another account):
   * optionally close its view first (an account view saves its cookies back when it closes, so
   * that must happen BEFORE the session file goes), unbind, reset the account's Marketplace
   * state, and delete the account's Facebook session when no other session in use is bound to it.
   */
  const unbind = (sessionId: ClientSessionId, closeView: boolean) =>
    Effect.gen(function* () {
      if (closeView) yield* remoteView.close(sessionId);
      const { userId, remaining } = yield* sessions.unbindAccount(sessionId);
      if (userId === null) return;
      yield* accountChanged(accountProfile(userId));
      if (remaining === 0) {
        yield* browser.clearSession(userId);
        names.delete(userId);
        nameFailedAt.delete(userId);
      }
    });

  /**
   * The session's open Marketplace view still has the account's old login (or none: it was opened
   * while the session was gone, or Facebook logged it out), and opening it again reuses it as is:
   * give it the new session. Not a view logged in to another account, nor a login view.
   */
  const shareSessionWithView = (sessionId: ClientSessionId, userId: FbUserId, source: BrowserContext) =>
    Effect.gen(function* () {
      const page = yield* remoteView.page(sessionId);
      if (Option.isNone(page) || (yield* remoteView.state(sessionId)).target === 'login') return;
      const target = page.value.context();
      const viewUser = yield* contextUserId(target);
      if (target === source || (viewUser !== null && viewUser !== userId)) return;
      const cookies = yield* Effect.tryPromise(() => source.cookies(FB_ORIGIN));
      yield* Effect.tryPromise(() => target.addCookies(cookies));
    }).pipe(Effect.ignore);

  /**
   * `context` is logged in to `userId`: make that this session's account. A session bound to
   * another account is unbound first (`closeView`: its view may carry that account's cookies; a
   * login view is anonymous and is the source of the new cookies, so it stays open). Then save,
   * bind, and reset the account's Marketplace state. Uninterruptible: half a login (saved but
   * not bound) helps nobody.
   */
  const finishLogin = (sessionId: ClientSessionId, userId: FbUserId, context: BrowserContext, closeView: boolean) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const found = yield* sessions.get(sessionId);
        const previous = Option.isSome(found) ? found.value.fbUserId : null;
        if (previous !== null && previous !== userId) yield* unbind(sessionId, closeView);
        yield* browser.saveSession(userId, context);
        if (previous === userId) yield* shareSessionWithView(sessionId, userId, context);
        yield* sessions.bindAccount(sessionId, userId);
        outcomes.delete(sessionId);
        yield* accountChanged(accountProfile(userId));
      }),
    );

  // ---------- password login ----------

  const failAttempt = (attempt: PasswordAttempt, message: string) =>
    Effect.gen(function* () {
      if (attempts.get(attempt.sessionId) !== attempt) return yield* currentStatus(attempt.sessionId);
      yield* dropAttempt(attempt);
      return yield* remember(attempt.sessionId, 'error', message);
    });

  const completeLogin = (attempt: PasswordAttempt) =>
    Effect.gen(function* () {
      const userId = yield* contextUserId(attempt.context);
      if (userId === null) return yield* failAttempt(attempt, `Facebook didn't confirm the login. ${USE_LOGIN_VIEW}`);
      const finished = yield* Effect.result(finishLogin(attempt.sessionId, userId, attempt.context, true));
      if (finished._tag === 'Failure') return yield* failAttempt(attempt, finished.failure.message);
      yield* dropAttempt(attempt);
      yield* Effect.logInfo('[auth] logged in with a password');
      yield* probeOnce(userId); // so the response carries the user's name
      return statusOf('logged_in', null, userId, yield* userNameFor(userId));
    });

  const applyOutcome = (attempt: PasswordAttempt, outcome: LoginOutcome) =>
    Effect.gen(function* () {
      if (attempts.get(attempt.sessionId) !== attempt) return yield* currentStatus(attempt.sessionId);
      yield* Effect.logInfo(`[auth] login step: ${outcome.kind}`);
      switch (outcome.kind) {
        case 'success':
          return yield* completeLogin(attempt);
        case 'failed':
          return yield* failAttempt(attempt, outcome.message);
        case 'needs_code':
        case 'needs_approval':
          // needs_approval: the ticker polls the page until Facebook lets us in.
          attempt.state = outcome.kind;
          attempt.message = outcome.message;
          return attemptStatus(attempt);
      }
    });

  /** Run one step against the login page. A thrown Playwright error ends the attempt with `fallback`. */
  const step = (attempt: PasswordAttempt, run: () => Promise<LoginOutcome>, fallback: string) =>
    Effect.tryPromise({ try: run, catch: (cause) => (isTimeout(cause) ? ('timeout' as const) : ('error' as const)) }).pipe(
      Effect.matchEffect({
        onSuccess: (outcome) => applyOutcome(attempt, outcome),
        onFailure: (failure) =>
          failAttempt(attempt, failure === 'timeout' ? `Facebook took too long to respond. ${USE_LOGIN_VIEW}` : fallback),
      }),
    );

  /**
   * A fresh login context and page for the session's attempt, registered as its attempt. Counted
   * against MAX_PASSWORD_LOGINS from the start (the caller checked there was room).
   */
  const startAttempt = (sessionId: ClientSessionId, email: string) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        starting.add(sessionId);
        const scope = yield* Scope.make();
        const { context, page } = yield* restore(
          Effect.gen(function* () {
            const opened = yield* browser.loginContext.pipe(Scope.provide(scope));
            const loginPage = yield* Effect.tryPromise({
              try: () => opened.newPage(),
              catch: () => new AppError({ code: 'INTERNAL', message: 'Could not open a page.' }),
            });
            return { context: opened, page: loginPage };
          }),
        ).pipe(
          Effect.onExit((exit) =>
            Effect.andThen(
              Effect.sync(() => {
                starting.delete(sessionId);
              }),
              Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, Exit.void),
            ),
          ),
        );
        const attempt: PasswordAttempt = {
          sessionId,
          email,
          context,
          page,
          scope,
          expiresAt: (yield* Clock.currentTimeMillis) + FLOW_TTL_MS,
          state: 'logging_in',
          message: null,
        };
        attempts.set(sessionId, attempt);
        return attempt;
      }),
    );

  const loginWithPassword = Effect.fn('Auth.loginWithPassword')(function* (session: ClientSession, request: LoginRequest) {
    const email = request.email.trim();
    const { password } = request;
    if (email === '' || password === '') {
      return yield* new AppError({ code: 'BAD_REQUEST', message: 'Enter your Facebook email (or phone) and password.' });
    }
    return yield* exclusive(
      session.id,
      Effect.gen(function* () {
        const existing = yield* liveSession(session);
        if (existing) return existing;
        yield* reconcile(session.id);
        // A repeated submit while Facebook waits for a code/approval shouldn't start over (logout() cancels).
        const pending = attempts.get(session.id);
        if (pending?.email.toLowerCase() === email.toLowerCase()) return attemptStatus(pending);
        yield* endFlows(session.id);
        if (attempts.size + starting.size >= MAX_PASSWORD_LOGINS) {
          return yield* new AppError({ code: 'BAD_REQUEST', message: BUSY_MESSAGE });
        }
        outcomes.delete(session.id);

        const started = yield* Effect.result(startAttempt(session.id, email));
        if (started._tag === 'Failure') return yield* remember(session.id, 'error', `Couldn't start Chrome: ${started.failure.message}`);
        const attempt = started.success;
        const { page } = attempt;
        return yield* step(
          attempt,
          async () => {
            await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            const filled = await fillLoginForm(page, email, password);
            if (!filled.ok) return { kind: 'failed', message: filled.message };
            return waitForLoginOutcome(page);
          },
          `Something went wrong while logging in. ${USE_LOGIN_VIEW}`,
        );
      }),
    );
  });

  const submitLoginCode = Effect.fn('Auth.submitLoginCode')(function* (session: ClientSession, code: string) {
    const clean = code.replace(/[\s-]/g, '');
    if (!/^[0-9a-z]{4,12}$/i.test(clean)) {
      return yield* new AppError({ code: 'BAD_REQUEST', message: 'Enter the code Facebook sent you.' });
    }
    return yield* exclusive(
      session.id,
      Effect.gen(function* () {
        yield* reconcile(session.id);
        const attempt = attempts.get(session.id);
        if (attempt?.state !== 'needs_code') {
          // e.g. a repeated submit after the login already went through
          if (attempt === undefined) {
            const current = yield* currentStatus(session.id);
            if (current.state === 'logged_in') return current;
          }
          return yield* new AppError({ code: 'BAD_REQUEST', message: 'No login is waiting for a code. Start the login again.' });
        }
        attempt.state = 'logging_in';
        attempt.message = 'Checking the code…';
        return yield* step(
          attempt,
          async () => {
            const { signature } = await readLoginStep(attempt.page);
            const typed = await enterLoginCode(attempt.page, clean);
            if (!typed.ok) return { kind: 'failed', message: typed.message };
            return waitForLoginOutcome(attempt.page, { before: signature });
          },
          `Something went wrong while sending the code. ${USE_LOGIN_VIEW}`,
        );
      }),
    );
  });

  /** While Facebook waits for approval on another device, watch the page and finish the login when it happens. */
  const pollApproval = (attempt: PasswordAttempt) =>
    Effect.gen(function* () {
      const { step: current } = yield* Effect.tryPromise(() => readLoginStep(attempt.page)).pipe(
        Effect.orElseSucceed(() => ({ step: { kind: 'pending' as const }, signature: null })),
      );
      if (current.kind === 'success' || current.kind === 'failed' || current.kind === 'needs_code') {
        yield* applyOutcome(attempt, current);
      } else if (current.kind === 'save_device') {
        // waitForLoginOutcome answers the prompt and carries on to the result.
        yield* step(
          attempt,
          () => waitForLoginOutcome(attempt.page, { timeoutMs: 30_000 }),
          `Something went wrong while logging in. ${USE_LOGIN_VIEW}`,
        );
      }
    });

  /**
   * Expiry and approval polling for every pending password login, and forgetting old outcomes.
   * Skips a session while a request of its own holds (or waits for) its lock.
   */
  const flowTick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [sessionId, outcome] of outcomes) {
      if (now - outcome.at >= OUTCOME_TTL_MS) outcomes.delete(sessionId);
    }
    for (const attempt of [...attempts.values()]) {
      if (locks.isBusy(attempt.sessionId)) continue;
      yield* exclusive(
        attempt.sessionId,
        Effect.gen(function* () {
          if (attempts.get(attempt.sessionId) !== attempt) return;
          yield* reconcile(attempt.sessionId);
          if (attempts.get(attempt.sessionId) === attempt && attempt.state === 'needs_approval') yield* pollApproval(attempt);
        }),
      );
    }
  });

  yield* Effect.forkScoped(
    Effect.forever(
      Effect.sleep(FLOW_TICK).pipe(
        Effect.andThen(flowTick),
        Effect.catchCause((cause) => Effect.logWarning('[auth] login check failed', cause)),
      ),
    ),
  );

  // ---------- login view ----------

  /** The view is past the login pages: save its cookies as the account's session and bind the session. Holding the lock. */
  const finishViewLogin = (sessionId: ClientSessionId, page: Page) =>
    Effect.gen(function* () {
      const context = page.context();
      const userId = yield* contextUserId(context);
      const finished =
        userId === null
          ? null
          : yield* Effect.result(finishLogin(sessionId, userId, context, false));
      // The login view is anonymous: closing it discards its context (the cookies are saved by now).
      yield* remoteView.close(sessionId);
      if (userId === null || finished === null) {
        yield* remember(sessionId, 'error', `Facebook didn't confirm the login. Start again.`);
        return null;
      }
      if (finished._tag === 'Failure') {
        yield* remember(sessionId, 'error', finished.failure.message);
        return null;
      }
      return userId;
    });

  /**
   * Watch the session's login view until Facebook lets the user in (then save, bind, close it),
   * until the view is gone, or until `deadline` (then close it unfinished). Stops as soon as the
   * session's watch is no longer `watch` (superseded, cancelled, or the view went away).
   */
  const watchLoginView = (watch: ViewWatch, deadline: number) =>
    Effect.gen(function* () {
      const { sessionId } = watch;
      const current = () => watches.get(sessionId) === watch;
      let readySince = 0;
      for (;;) {
        yield* Effect.sleep(viewPollMs);
        if (!current()) return;
        const view = yield* remoteView.state(sessionId);
        if (!view.open || view.target !== 'login') {
          // The user closed it (nothing is saved from an anonymous view) or moved on.
          if (current()) watches.delete(sessionId);
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        if (now >= deadline) {
          yield* exclusive(
            sessionId,
            Effect.gen(function* () {
              if (!current()) return;
              watches.delete(sessionId);
              yield* remoteView.close(sessionId);
              yield* remember(sessionId, 'error', 'The login page was open too long. Start again.');
            }),
          );
          return;
        }
        const page = yield* remoteView.page(sessionId);
        // A c_user cookie can exist mid-2FA; wait until Facebook has let the user through.
        if (Option.isNone(page) || !(yield* Effect.promise(() => pastLogin(page.value).catch(() => false)))) {
          readySince = 0;
          continue;
        }
        if (readySince === 0) readySince = now;
        // Let the post-login redirect finish before closing.
        if (now - readySince < viewSettleMs) continue;

        const viewPage = page.value;
        const userId = yield* exclusive(
          sessionId,
          Effect.gen(function* () {
            if (!current()) return null;
            watches.delete(sessionId);
            return yield* finishViewLogin(sessionId, viewPage);
          }),
        );
        if (userId !== null) {
          yield* Effect.logInfo('[auth] logged in through the login view');
          // Fetch the name now, so the next status has it.
          yield* probeOnce(userId);
        }
        return;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning('[auth] watching the login view failed', cause),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (watches.get(watch.sessionId) === watch) watches.delete(watch.sessionId);
        }),
      ),
    );

  const openLoginView = Effect.fn('Auth.openLoginView')(function* (session: ClientSession) {
    return yield* exclusive(
      session.id,
      Effect.gen(function* () {
        const existing = yield* liveSession(session);
        if (existing) return existing;
        yield* reconcile(session.id);
        if (watches.has(session.id)) return WINDOW_OPEN;
        yield* endFlows(session.id);
        outcomes.delete(session.id);

        const opened = yield* Effect.result(remoteView.open(session.id, ANONYMOUS_PROFILE, { target: 'login' }));
        if (opened._tag === 'Failure') {
          // Every view slot is taken: say so as is (nothing to remember).
          if (opened.failure.code === 'BAD_REQUEST') return yield* opened.failure;
          return yield* remember(session.id, 'error', `Couldn't open Facebook's login page: ${opened.failure.message}`);
        }
        const watch: ViewWatch = { sessionId: session.id, fiber: null };
        watches.set(session.id, watch);
        const deadline = (yield* Clock.currentTimeMillis) + viewWatchMs;
        watch.fiber = yield* Effect.forkIn(watchLoginView(watch, deadline), layerScope);
        return WINDOW_OPEN;
      }),
    );
  });

  const logout = Effect.fn('Auth.logout')(function* (session: ClientSession) {
    return yield* exclusive(
      session.id,
      Effect.gen(function* () {
        yield* endFlows(session.id);
        outcomes.delete(session.id);
        // First: closing an account view writes its cookies back to the account's session file.
        yield* unbind(session.id, true);
        return statusOf('logged_out');
      }),
    );
  });

  const cancelLogin = Effect.fn('Auth.cancelLogin')(function* (session: ClientSession) {
    yield* exclusive(
      session.id,
      Effect.gen(function* () {
        yield* endFlows(session.id);
        outcomes.delete(session.id);
        // A login view is cookie-less: closing it discards it (an account view stays open).
        const view = yield* remoteView.state(session.id);
        if (view.open && view.target === 'login') yield* remoteView.close(session.id);
      }),
    );
    return yield* status(session);
  });

  // Runtime disposal: close pending logins' contexts (the watchers live in the layer scope).
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...attempts.values()], dropAttempt, { discard: true }),
  );

  return Auth.of({ status, isLoggedIn, loginWithPassword, submitLoginCode, openLoginView, cancelLogin, logout });
});

export class Auth extends Context.Service<Auth, AuthShape>()('faceslop/server/Auth') {
  static readonly layerStub = Layer.succeed(
    Auth,
    Auth.of({
      status: () => notImplemented('Auth.status'),
      cancelLogin: () => notImplemented('Auth.cancelLogin'),
      isLoggedIn: () => notImplemented('Auth.isLoggedIn'),
      loginWithPassword: () => notImplemented('Auth.loginWithPassword'),
      submitLoginCode: () => notImplemented('Auth.submitLoginCode'),
      openLoginView: () => notImplemented('Auth.openLoginView'),
      logout: () => notImplemented('Auth.logout'),
    }),
  );

  /** Requires Browser, RemoteView, Marketplace and Sessions. Options are for tests (faster view polling). */
  static readonly layerNoDeps = (options?: AuthOptions) => Layer.effect(Auth, make(options));

  /** The layer the app runs. */
  static readonly layer = Layer.effect(Auth, make()).pipe(
    Layer.provide([Browser.layer, RemoteView.layer, Marketplace.layer, Sessions.layer]),
  );
}
