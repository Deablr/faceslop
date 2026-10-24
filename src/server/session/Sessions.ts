// Browser sessions (the `faceslop_session` cookie): the APP_PASSWORD gate and which Facebook
// account each browser is logged in with. Replaces the old AppAuth service. OWNER: data builder.
//
// - Tokens are random 32-byte values (base64url) in an HttpOnly cookie; only their SHA-256 is
//   stored (`client_sessions.token_hash`). All sessions are loaded into memory at startup, so
//   `resolve` is a map lookup (it runs on every server-function call).
// - Unlocking never expires. A session stores a fingerprint of the APP_PASSWORD it was unlocked
//   with (scrypt of the password with a random per-install salt kept in the `meta` table): when
//   APP_PASSWORD changes, every browser has to enter the new one. The fingerprint is computed once
//   when the layer is built. No password set: every session is unlocked.
// - Wrong passwords are throttled per client address (5 per minute) and globally (30 per minute,
//   a cap on guessing from many addresses). Throttled attempts are refused even with the right
//   password. The comparison is constant-time.
// - bindAccount moves the session's own data (owner "session:<id>") to the account
//   ("fb:<id>"); the first time ANY account binds, rows from before multi-user support
//   (UNCLAIMED_OWNER) go to that account too. See ClientSessionsRepo.reassignOwner.
// - last_seen_at is refreshed at most once a day per session, and only while it is unlocked: a
//   browser sitting on the password screen (e.g. after APP_PASSWORD changed) isn't using the app.
//   A session not seen for ACTIVE_SESSION_WINDOW_MS (30 days) no longer counts: the Checker skips
//   its owner, and unbindAccount doesn't count it as still using the account (a closed private
//   window or cleared cookies must not keep an account's Facebook cookies forever; if that
//   browser comes back, it is still bound but logged out of Facebook).
// - Changes are written to the database first, then to memory, one at a time (a semaphore), so
//   memory never shows something that isn't stored. Tokens and passwords are never logged.
import '@tanstack/react-start/server-only';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { Clock, Context, Effect, Layer, Option, Redacted, Ref, Semaphore } from 'effect';
import { AppConfig } from '@/server/config';
import {
  ACTIVE_SESSION_WINDOW_MS,
  ClientSessionsRepo,
  type ClientSessionRow,
} from '@/server/db/repositories/ClientSessionsRepo';
import {
  type ClientSession,
  type ClientSessionId,
  type FbUserId,
  UNCLAIMED_OWNER,
  accountOwner,
  sessionOwner,
} from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import { AppError } from '@/shared/errors';

/** HttpOnly, SameSite=Lax cookie carrying the session token over plain HTTP (loopback, LAN). */
export const SESSION_COOKIE = 'faceslop_session';
/**
 * The same cookie over HTTPS: the `__Host-` prefix makes browsers accept it only Secure, with
 * Path=/ and no Domain, so a sibling subdomain (another app on the same Dokploy domain) or a
 * plain-http response can't plant a token of its choosing (session fixation). Over HTTPS the
 * plain name is ignored.
 */
export const SECURE_SESSION_COOKIE = '__Host-faceslop_session';
/** Browsers cap cookie lifetimes at 400 days. The cookie is re-issued on unlock and Facebook login. */
export const SESSION_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

/** A session plus the raw token for its cookie (the token is never stored server-side). */
export interface IssuedSession {
  readonly token: string;
  readonly session: ClientSession;
}

export interface SessionsShape {
  /** True when APP_PASSWORD is set. */
  readonly passwordRequired: boolean;
  /** The session a cookie token names; None for a missing or unknown token. */
  readonly resolve: (token: string | undefined) => Effect.Effect<Option.Option<ClientSession>>;
  /** A session by id (fresh state, e.g. for background work that only kept the id). */
  readonly get: (id: ClientSessionId) => Effect.Effect<Option.Option<ClientSession>>;
  /** A new session: unlocked when no password is set, else locked. The caller sets the cookie. */
  readonly create: Effect.Effect<IssuedSession>;
  /**
   * Check APP_PASSWORD and mark the token's session unlocked (a new session when the token names
   * none; its new token is returned either way, so the cookie can be re-issued). FORBIDDEN on a
   * wrong password or while throttled; BAD_REQUEST when no password is set. `clientAddress` keys
   * the per-address throttle (null: unknown, shares one bucket).
   */
  readonly unlock: (
    token: string | undefined,
    password: Redacted.Redacted,
    clientAddress: string | null,
  ) => Effect.Effect<IssuedSession, AppError>;
  /** Lock this browser again (keeps the session and its Facebook binding). No-op for unknown ids. */
  readonly lock: (id: ClientSessionId) => Effect.Effect<void>;
  /** Bind a session to the Facebook account it just logged in with, moving its data (see header). */
  readonly bindAccount: (id: ClientSessionId, userId: FbUserId) => Effect.Effect<void>;
  /**
   * Unbind (Facebook logout on this device). Returns the account it was bound to and how many
   * OTHER sessions in use (seen within ACTIVE_SESSION_WINDOW_MS) are still bound to it (0: the
   * account's Facebook cookies can be deleted).
   */
  readonly unbindAccount: (
    id: ClientSessionId,
  ) => Effect.Effect<{ readonly userId: FbUserId | null; readonly remaining: number }>;
}

const THROTTLE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_ADDRESS = 5;
const MAX_FAILURES_GLOBAL = 30;
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;
/** `meta` key of the per-install salt for the APP_PASSWORD fingerprint. */
const UNLOCK_SALT_KEY = 'unlock_salt';

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
/** What is stored for a session token (hex SHA-256). */
export const hashToken = (token: string): string => sha256(token).toString('hex');
const newToken = (): string => randomBytes(32).toString('base64url');
const newSessionId = (): ClientSessionId => randomBytes(16).toString('base64url') as ClientSessionId;

/** scrypt(APP_PASSWORD, salt) as hex: what `unlocked_with` holds for sessions unlocked with it. */
const fingerprintOf = (password: Redacted.Redacted, salt: string) =>
  Effect.callback<string>((resume) => {
    scrypt(Redacted.value(password), salt, 32, (error, key) => {
      resume(error === null ? Effect.succeed(key.toString('hex')) : Effect.die(error));
    });
  });

/** Recent wrong passwords (times, oldest first): everywhere, and per client address (null: unknown). */
interface Failures {
  readonly global: readonly number[];
  readonly byAddress: ReadonlyMap<string | null, readonly number[]>;
}

/** How long until `failures` (all within the window) drop below `max`; 0 when they already are. */
const waitFor = (failures: readonly number[], max: number, now: number): number => {
  const oldest = failures[0];
  return failures.length >= max && oldest !== undefined ? oldest + THROTTLE_WINDOW_MS - now : 0;
};

/**
 * Throttle check, verdict and failure bookkeeping in one step: the refusal message (null: let the
 * attempt through) and the next state. A success clears that address's failures (not the global
 * ones: someone else's success must not reset a guesser's cap).
 */
function judgeAttempt(
  state: Failures,
  address: string | null,
  matches: boolean,
  now: number,
): readonly [string | null, Failures] {
  const recent = (times: readonly number[]) => times.filter((t) => now - t < THROTTLE_WINDOW_MS);
  const global = recent(state.global);
  // Only addresses with recent failures are kept (at most MAX_FAILURES_GLOBAL of them).
  const byAddress = new Map<string | null, readonly number[]>();
  for (const [key, times] of state.byAddress) {
    const kept = recent(times);
    if (kept.length > 0) byAddress.set(key, kept);
  }
  const mine = byAddress.get(address) ?? [];
  const waitMs = Math.max(waitFor(mine, MAX_FAILURES_PER_ADDRESS, now), waitFor(global, MAX_FAILURES_GLOBAL, now));
  if (waitMs > 0) {
    return [`Too many wrong passwords. Try again in ${String(Math.ceil(waitMs / 1000))}s.`, { global, byAddress }];
  }
  if (matches) {
    byAddress.delete(address);
    return [null, { global, byAddress }];
  }
  byAddress.set(address, [...mine, now]);
  return ['Wrong password.', { global: [...global, now], byAddress }];
}

const make = Effect.gen(function* () {
  const config = yield* AppConfig;
  const repo = yield* ClientSessionsRepo;
  const passwordRequired = Option.isSome(config.appPassword);
  const passwordDigest = Option.map(config.appPassword, (password) => sha256(Redacted.value(password)));
  /** The current APP_PASSWORD's fingerprint (None: no password, every session is unlocked). */
  const fingerprint = Option.isSome(config.appPassword)
    ? Option.some(
        yield* fingerprintOf(
          config.appPassword.value,
          yield* repo.getOrInsertMeta(UNLOCK_SALT_KEY, randomBytes(16).toString('hex')),
        ),
      )
    : Option.none<string>();

  // Every session, in memory (loaded once; changes are written through to the repository).
  const rows = new Map<ClientSessionId, ClientSessionRow>();
  const idByTokenHash = new Map<string, ClientSessionId>();
  const remember = (row: ClientSessionRow): ClientSessionRow => {
    const previous = rows.get(row.id);
    if (previous !== undefined && previous.tokenHash !== row.tokenHash) idByTokenHash.delete(previous.tokenHash);
    rows.set(row.id, row);
    idByTokenHash.set(row.tokenHash, row.id);
    return row;
  };
  /**
   * Change a remembered row. The row is re-read now (a copy read before a yield may be stale), so
   * concurrent changes to other fields aren't lost and an old token hash never comes back.
   */
  const amend = (
    row: ClientSessionRow,
    change: Partial<Pick<ClientSessionRow, 'tokenHash' | 'unlockedWith' | 'fbUserId' | 'lastSeenAt'>>,
  ) => remember({ ...(rows.get(row.id) ?? row), ...change });
  const byToken = (token: string | undefined): ClientSessionRow | undefined => {
    if (token === undefined || token === '') return undefined;
    const id = idByTokenHash.get(hashToken(token));
    return id === undefined ? undefined : rows.get(id);
  };
  for (const row of yield* repo.list) remember(row);

  /** Database + memory changes to existing sessions run one at a time. */
  const writes = yield* Semaphore.make(1);
  const failures = yield* Ref.make<Failures>({ global: [], byAddress: new Map() });

  const toSession = (row: ClientSessionRow): ClientSession => ({
    id: row.id,
    unlocked: Option.match(fingerprint, { onNone: () => true, onSome: (current) => row.unlockedWith === current }),
    fbUserId: row.fbUserId,
  });

  /** A new session (stored, remembered) and its raw token. */
  const insertSession = Effect.fnUntraced(function* (unlockedWith: string | null) {
    const now = yield* Clock.currentTimeMillis;
    const token = newToken();
    const row: ClientSessionRow = {
      id: newSessionId(),
      tokenHash: hashToken(token),
      unlockedWith,
      fbUserId: null,
      createdAt: now,
      lastSeenAt: now,
    };
    yield* repo.insert(row);
    return { token, session: toSession(remember(row)) } satisfies IssuedSession;
  });

  const resolve = Effect.fn('Sessions.resolve')(function* (token: string | undefined) {
    const now = yield* Clock.currentTimeMillis;
    const row = byToken(token);
    if (row === undefined) return Option.none<ClientSession>();
    const session = toSession(row);
    // Only an unlocked browser is using the app (see header).
    if (session.unlocked && now - row.lastSeenAt > TOUCH_AFTER_MS) {
      // Remembered first (before yielding), so concurrent requests don't all write it.
      amend(row, { lastSeenAt: now });
      yield* repo.touch(row.id, now);
    }
    return Option.some(session);
  });

  const get = Effect.fn('Sessions.get')((id: ClientSessionId) =>
    Effect.sync(() => Option.map(Option.fromUndefinedOr(rows.get(id)), toSession)),
  );

  const create = insertSession(null).pipe(Effect.withSpan('Sessions.create'));

  const unlock = Effect.fn('Sessions.unlock')(function* (
    token: string | undefined,
    password: Redacted.Redacted,
    clientAddress: string | null,
  ) {
    if (Option.isNone(passwordDigest) || Option.isNone(fingerprint)) {
      return yield* new AppError({ code: 'BAD_REQUEST', message: 'No app password is set.' });
    }
    const now = yield* Clock.currentTimeMillis;
    const matches = timingSafeEqual(sha256(Redacted.value(password)), passwordDigest.value);
    const refusal = yield* Ref.modify(failures, (state) => judgeAttempt(state, clientAddress, matches, now));
    if (refusal !== null) return yield* new AppError({ code: 'FORBIDDEN', message: refusal });

    return yield* writes.withPermit(
      Effect.gen(function* () {
        const existing = byToken(token);
        if (existing === undefined) return yield* insertSession(fingerprint.value);
        // A new token for the unlocked session: whoever held the old one doesn't inherit the unlock.
        const issued = newToken();
        const tokenHash = hashToken(issued);
        yield* repo.setTokenHash(existing.id, tokenHash);
        yield* repo.setUnlockedWith(existing.id, fingerprint.value);
        const row = amend(existing, { tokenHash, unlockedWith: fingerprint.value });
        return { token: issued, session: toSession(row) } satisfies IssuedSession;
      }),
    );
  });

  const lock = Effect.fn('Sessions.lock')((id: ClientSessionId) =>
    writes.withPermit(
      Effect.gen(function* () {
        const row = rows.get(id);
        if (row === undefined || row.unlockedWith === null) return;
        yield* repo.setUnlockedWith(id, null);
        amend(row, { unlockedWith: null });
      }),
    ),
  );

  const bindAccount = Effect.fn('Sessions.bindAccount')((id: ClientSessionId, userId: FbUserId) =>
    writes.withPermit(
      Effect.gen(function* () {
        const row = rows.get(id);
        if (row === undefined) return;
        // Bound first: from now on this browser's requests read and write the account's data, and
        // whatever it wrote as itself until now moves over.
        if (row.fbUserId !== userId) {
          yield* repo.setAccount(id, userId);
          amend(row, { fbUserId: userId });
        }
        const account = accountOwner(userId);
        yield* repo.reassignOwner(sessionOwner(id), account);
        // The first account to log in inherits the data from before multi-user support.
        if (yield* repo.hasUnclaimedData) yield* repo.reassignOwner(UNCLAIMED_OWNER, account);
      }),
    ),
  );

  const unbindAccount = Effect.fn('Sessions.unbindAccount')((id: ClientSessionId) =>
    writes.withPermit(
      Effect.gen(function* () {
        const row = rows.get(id);
        if (row === undefined || row.fbUserId === null) return { userId: null, remaining: 0 };
        const userId = row.fbUserId;
        const now = yield* Clock.currentTimeMillis;
        yield* repo.setAccount(id, null);
        amend(row, { fbUserId: null });
        // Browsers not seen for a month don't keep the account's Facebook cookies (see header).
        const since = now - ACTIVE_SESSION_WINDOW_MS;
        let remaining = 0;
        for (const other of rows.values()) if (other.fbUserId === userId && other.lastSeenAt >= since) remaining++;
        return { userId, remaining };
      }),
    ),
  );

  return Sessions.of({ passwordRequired, resolve, get, create, unlock, lock, bindAccount, unbindAccount });
});

export class Sessions extends Context.Service<Sessions, SessionsShape>()('faceslop/server/Sessions') {
  static readonly layerStub = Layer.succeed(
    Sessions,
    Sessions.of({
      passwordRequired: false,
      resolve: () => notImplemented('Sessions.resolve'),
      get: () => notImplemented('Sessions.get'),
      create: notImplemented('Sessions.create'),
      unlock: () => notImplemented('Sessions.unlock'),
      lock: () => notImplemented('Sessions.lock'),
      bindAccount: () => notImplemented('Sessions.bindAccount'),
      unbindAccount: () => notImplemented('Sessions.unbindAccount'),
    }),
  );

  /** Needs AppConfig and ClientSessionsRepo (tests provide their own). */
  static readonly layerNoDeps: Layer.Layer<Sessions, never, AppConfig | ClientSessionsRepo> = Layer.effect(Sessions, make);

  /** The layer the app runs. */
  static readonly layer = Sessions.layerNoDeps.pipe(Layer.provide([AppConfig.layer, ClientSessionsRepo.layer]));
}
