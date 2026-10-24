// The browser behind the current server-function call (or /api route request). OWNER: contracts.
//
// The bridge (src/server/bridge.ts) reads the request (cookie, addresses) synchronously, before
// the Effect runs (Effect's scheduler may resume fibers outside the request's AsyncLocalStorage
// context, so request helpers like getCookie must not be called from inside an Effect), provides
// CurrentClient, and sets the session cookie after the Effect finishes, back in the request's
// context. Services never use CurrentClient: they take explicit ClientSession / FbProfile /
// OwnerKey arguments. Only src/server/functions/* and the /api routes read it.
import '@tanstack/react-start/server-only';
import { Context, Effect, Option, Semaphore } from 'effect';
import { AppConfig } from '@/server/config';
import {
  type ClientSession,
  type FbProfile,
  type FbUserId,
  type OwnerKey,
  ownerOf,
  profileOf,
} from '@/server/session/identity';
import { type IssuedSession, Sessions } from '@/server/session/Sessions';
import type { AppAuthStatus } from '@/shared/domain';
import { AppError } from '@/shared/errors';

/** What the bridge read from the request before running the Effect. All empty outside a request. */
export interface RequestInfo {
  /** The `faceslop_session` cookie's value (used over plain HTTP). */
  readonly token: string | undefined;
  /** The `__Host-faceslop_session` cookie's value (used over HTTPS; see SECURE_SESSION_COOKIE). */
  readonly secureToken: string | undefined;
  /** The TCP peer address. */
  readonly remoteAddress: string | null;
  /** Raw X-Forwarded-For / X-Forwarded-Proto (only trusted with FACESLOP_TRUST_PROXY=1). */
  readonly forwardedFor: string | null;
  readonly forwardedProto: string | null;
  /** "http" or "https", from the request URL. */
  readonly protocol: string | null;
  /** The HTTP method ("POST" for server-function writes). */
  readonly method: string | null;
}

export const EMPTY_REQUEST_INFO: RequestInfo = {
  token: undefined,
  secureToken: undefined,
  remoteAddress: null,
  forwardedFor: null,
  forwardedProto: null,
  protocol: null,
  method: null,
};

/** A cookie for the bridge to set when the Effect is done. */
export interface CookieToSet {
  readonly token: string;
  readonly secure: boolean;
}

export interface CurrentClientShape {
  readonly request: RequestInfo;
  /** The client's address, for throttling: the proxy's X-Forwarded-For (last hop) when trusted, else the peer. */
  readonly address: string | null;
  /** True when the browser reached faceslop over HTTPS (directly or through a trusted proxy). */
  readonly secure: boolean;
  /** The session token this request presented: the `__Host-` cookie over HTTPS, else the plain one. */
  readonly token: string | undefined;
  /**
   * This request's session, if its cookie names one (reflects sessions created or re-issued during
   * this call). On a POST, a known session's cookie is set again with a fresh Max-Age, so a browser
   * in use never reaches the 400-day cookie limit (unlocking never expires).
   */
  readonly session: Effect.Effect<Option.Option<ClientSession>>;
  /**
   * This request's session, created when there is none; the new cookie is set when the server
   * function returns. POST server functions only: GETs also run during SSR, where it is too late
   * to set a cookie.
   */
  readonly ensureSession: Effect.Effect<ClientSession>;
  /** Use this token from now on and set its cookie when the server function returns (unlock). */
  readonly issue: (issued: IssuedSession) => Effect.Effect<void>;
}

export class CurrentClient extends Context.Service<CurrentClient, CurrentClientShape>()('faceslop/server/CurrentClient') {}

/** The last X-Forwarded-For entry: the address the (single, trusted) proxy saw. */
const lastForwardedFor = (header: string | null): string | null => {
  const last = header?.split(',').at(-1)?.trim();
  return last === undefined || last === '' ? null : last;
};

/** Build CurrentClient for one call. `setCookie` records the cookie for the bridge to set afterwards. */
export const makeCurrentClient = (request: RequestInfo, setCookie: (cookie: CookieToSet) => void) =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const sessions = yield* Sessions;
    const lock = yield* Semaphore.make(1);

    const address = config.trustProxy ? (lastForwardedFor(request.forwardedFor) ?? request.remoteAddress) : request.remoteAddress;
    const viaHttps = config.trustProxy
      ? request.forwardedProto?.split(',')[0]?.trim() === 'https'
      : request.protocol === 'https';
    const secure = viaHttps || Option.exists(config.publicUrl, (url) => url.protocol === 'https:');
    // Over HTTPS only the __Host- cookie counts: a plain one may have been planted (see Sessions).
    let token = secure ? request.secureToken : request.token;

    // Only POSTs renew: GETs also run during SSR, where it is too late to set a cookie.
    let renewed = request.method?.toUpperCase() !== 'POST';
    const session = Effect.suspend(() => sessions.resolve(token)).pipe(
      Effect.tap((found) =>
        Effect.sync(() => {
          if (renewed || Option.isNone(found) || token === undefined) return;
          renewed = true;
          setCookie({ token, secure });
        }),
      ),
    );

    const issue = (issued: IssuedSession) =>
      Effect.sync(() => {
        token = issued.token;
        renewed = true;
        setCookie({ token: issued.token, secure });
      });

    const ensureSession = lock.withPermits(1)(
      Effect.flatMap(session, (current) =>
        Option.isSome(current)
          ? Effect.succeed(current.value)
          : Effect.map(Effect.tap(sessions.create, issue), (issued) => issued.session),
      ),
    );

    return CurrentClient.of({ request, address, secure, token, session, ensureSession, issue });
  });

// ---------- helpers for server functions ----------

/** This request's session, or None. */
export const currentSession: Effect.Effect<Option.Option<ClientSession>, never, CurrentClient> = CurrentClient.use(
  (client) => client.session,
);

/** Whose Facebook cookies this request's Facebook work uses (no session or not logged in: anonymous). */
export const currentProfile: Effect.Effect<FbProfile, never, CurrentClient> = Effect.map(currentSession, (session) =>
  profileOf(Option.getOrNull(session)),
);

/** Owner of this request's local data, for reads. None without a session: show empty lists. */
export const currentOwner: Effect.Effect<Option.Option<OwnerKey>, never, CurrentClient> = Effect.map(
  currentSession,
  Option.map(ownerOf),
);

/** Owner of this request's local data, for writes (creates the session when needed; POST only). */
export const ensureOwner: Effect.Effect<OwnerKey, never, CurrentClient> = Effect.map(
  CurrentClient.use((client) => client.ensureSession),
  ownerOf,
);

/** The session and its Facebook account; NOT_LOGGED_IN when this browser isn't logged in to Facebook. */
export const requireAccount: Effect.Effect<
  { readonly session: ClientSession; readonly userId: FbUserId },
  AppError,
  CurrentClient
> = Effect.flatMap(currentSession, (session) =>
  Option.isSome(session) && session.value.fbUserId !== null
    ? Effect.succeed({ session: session.value, userId: session.value.fbUserId })
    : Effect.fail(new AppError({ code: 'NOT_LOGGED_IN', message: 'Connect your Facebook account first.' })),
);

/** This request's session, created when there is none (POST only; see CurrentClientShape.ensureSession). */
export const ensureSession: Effect.Effect<ClientSession, never, CurrentClient> = CurrentClient.use(
  (client) => client.ensureSession,
);

/** The app-password gate's state for this browser (the UI's lock screen). */
export const appAuthStatus: Effect.Effect<AppAuthStatus, never, CurrentClient | Sessions> = Effect.gen(function* () {
  const { passwordRequired } = yield* Sessions;
  const session = yield* currentSession;
  return {
    required: passwordRequired,
    authenticated: Option.match(session, { onNone: () => !passwordRequired, onSome: (found) => found.unlocked }),
  } satisfies AppAuthStatus;
});
