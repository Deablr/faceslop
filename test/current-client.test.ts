// CurrentClient on its own (src/server/session/CurrentClient.ts): what the bridge builds for each
// server-function call from the request it read. Which address the throttle sees (the trusted
// proxy's last X-Forwarded-For hop, else the peer), when the browser counts as on HTTPS (Secure
// cookie, HSTS), lazy session creation (once per call, cookie recorded for the bridge), and the
// owner/profile helpers server functions use. Sessions is an in-memory fake here; the real one is
// tested in test/sessions.test.ts, and the whole path over HTTP in test/server-fn-http.test.ts.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { AppConfig, type AppConfigShape } from '@/server/config';
import {
  type CookieToSet,
  CurrentClient,
  EMPTY_REQUEST_INFO,
  type RequestInfo,
  currentOwner,
  currentProfile,
  currentSession,
  ensureOwner,
  makeCurrentClient,
  requireAccount,
} from '@/server/session/CurrentClient';
import { type ClientSession, type ClientSessionId, type FbUserId, ANONYMOUS_PROFILE, accountProfile } from '@/server/session/identity';
import { type IssuedSession, Sessions } from '@/server/session/Sessions';
import { appErrorOf } from '@/shared/errors';

const ALICE = '1001' as FbUserId;

/** An in-memory Sessions: `create` hands out tokens "t1", "t2", ...; `bound` sessions start bound to ALICE. */
function fakeSessions(options: { readonly bound?: readonly string[] } = {}) {
  const byToken = new Map<string, ClientSession>();
  for (const token of options.bound ?? []) {
    byToken.set(token, { id: `id-${token}` as ClientSessionId, unlocked: true, fbUserId: ALICE });
  }
  let created = 0;
  const create = Effect.sync((): IssuedSession => {
    created += 1;
    const token = `t${String(created)}`;
    const session: ClientSession = { id: `id-${token}` as ClientSessionId, unlocked: true, fbUserId: null };
    byToken.set(token, session);
    return { token, session };
  });
  const unused = () => Effect.die('not used by these tests');
  const layer = Layer.succeed(
    Sessions,
    Sessions.of({
      passwordRequired: false,
      resolve: (token) => Effect.sync(() => Option.fromNullishOr(token === undefined ? undefined : byToken.get(token))),
      get: unused,
      create,
      unlock: unused,
      lock: unused,
      bindAccount: unused,
      unbindAccount: unused,
    }),
  );
  return { layer, createdCount: () => created };
}

const request = (overrides: Partial<RequestInfo>): RequestInfo => ({ ...EMPTY_REQUEST_INFO, ...overrides });

/** Build a CurrentClient for `info` under `config`; returns it with the cookies it asked the bridge to set. */
const clientFor = (
  info: RequestInfo,
  config: Partial<AppConfigShape> = {},
  sessions: ReturnType<typeof fakeSessions> = fakeSessions(),
) => {
  const cookies: CookieToSet[] = [];
  return Effect.map(
    makeCurrentClient(info, (cookie) => cookies.push(cookie)).pipe(
      Effect.provide(Layer.mergeAll(AppConfig.layerTest({ dataDir: '/nonexistent/faceslop-test', ...config }), sessions.layer)),
    ),
    (client) => ({ client, cookies }),
  );
};

/** Run `effect` as a server function would, with CurrentClient for `info`. */
const asServerFn = <A, E>(
  effect: Effect.Effect<A, E, CurrentClient>,
  info: RequestInfo,
  sessions: ReturnType<typeof fakeSessions> = fakeSessions(),
) => Effect.flatMap(clientFor(info, {}, sessions), ({ client }) => Effect.provideService(effect, CurrentClient, client));

describe('CurrentClient: address and transport', () => {
  it.effect("uses the peer address unless a proxy is trusted; then the proxy's last X-Forwarded-For hop", () =>
    Effect.gen(function* () {
      const info = request({ remoteAddress: '172.18.0.2', forwardedFor: '198.51.100.9, 203.0.113.7' });
      expect((yield* clientFor(info)).client.address).toBe('172.18.0.2');
      expect((yield* clientFor(info, { trustProxy: true })).client.address).toBe('203.0.113.7');
      expect((yield* clientFor(request({ remoteAddress: '172.18.0.2' }), { trustProxy: true })).client.address).toBe('172.18.0.2');
      expect((yield* clientFor(request({ remoteAddress: '172.18.0.2', forwardedFor: ' , ' }), { trustProxy: true })).client.address).toBe(
        '172.18.0.2',
      );
      expect((yield* clientFor(EMPTY_REQUEST_INFO)).client.address).toBeNull();
    }),
  );

  it.effect('is secure over HTTPS: the request URL, or the trusted proxy, or an https FACESLOP_PUBLIC_URL', () =>
    Effect.gen(function* () {
      const secure = (info: RequestInfo, config: Partial<AppConfigShape> = {}) =>
        Effect.map(clientFor(info, config), ({ client }) => client.secure);
      expect(yield* secure(request({ protocol: 'http' }))).toBe(false);
      expect(yield* secure(request({ protocol: 'https' }))).toBe(true);
      // X-Forwarded-Proto counts only from a trusted proxy.
      expect(yield* secure(request({ protocol: 'http', forwardedProto: 'https' }))).toBe(false);
      expect(yield* secure(request({ protocol: 'http', forwardedProto: 'https' }), { trustProxy: true })).toBe(true);
      expect(yield* secure(request({ protocol: 'http', forwardedProto: 'http' }), { trustProxy: true })).toBe(false);
      expect(yield* secure(request({ protocol: 'http' }), { publicUrl: Option.some(new URL('https://faceslop.example.com')) })).toBe(true);
      expect(yield* secure(request({ protocol: 'http' }), { publicUrl: Option.some(new URL('http://faceslop.lan')) })).toBe(false);
    }),
  );
});

describe('CurrentClient: sessions', () => {
  it.effect('reads the cookie; creates a session only when asked, once per call, and records its cookie', () =>
    Effect.gen(function* () {
      const sessions = fakeSessions();
      const { client, cookies } = yield* clientFor(request({ protocol: 'https' }), {}, sessions);
      expect(yield* client.session).toEqual(Option.none());
      expect(sessions.createdCount()).toBe(0);

      const [first, second] = yield* Effect.all([client.ensureSession, client.ensureSession], { concurrency: 'unbounded' });
      expect(first).toEqual(second);
      expect(sessions.createdCount()).toBe(1);
      expect(cookies).toEqual([{ token: 't1', secure: true }]);
      // The new session is this call's session from now on.
      expect(yield* client.session).toEqual(Option.some(first));
      yield* client.ensureSession;
      expect(cookies).toHaveLength(1);
    }),
  );

  it.effect('an existing cookie is used as is (no new session, no cookie)', () =>
    Effect.gen(function* () {
      const sessions = fakeSessions({ bound: ['alice-token'] });
      const { client, cookies } = yield* clientFor(request({ token: 'alice-token' }), {}, sessions);
      expect(Option.getOrNull(yield* client.session)?.fbUserId).toBe(ALICE);
      yield* client.ensureSession;
      expect(sessions.createdCount()).toBe(0);
      expect(cookies).toEqual([]);
    }),
  );

  it.effect('issue switches the call to a re-issued token and records its cookie', () =>
    Effect.gen(function* () {
      const sessions = fakeSessions({ bound: ['alice-token'] });
      const { client, cookies } = yield* clientFor(request({ token: 'unknown' }), {}, sessions);
      expect(yield* client.session).toEqual(Option.none());
      yield* client.issue({ token: 'alice-token', session: { id: 'id-alice-token' as ClientSessionId, unlocked: true, fbUserId: ALICE } });
      expect(cookies).toEqual([{ token: 'alice-token', secure: false }]);
      expect(Option.getOrNull(yield* client.session)?.id).toBe('id-alice-token');
    }),
  );
});

describe('CurrentClient: helpers for server functions', () => {
  it.effect('without a session: anonymous profile, no owner for reads, NOT_LOGGED_IN for account work', () =>
    Effect.gen(function* () {
      expect(yield* asServerFn(currentSession, EMPTY_REQUEST_INFO)).toEqual(Option.none());
      expect(yield* asServerFn(currentProfile, EMPTY_REQUEST_INFO)).toEqual(ANONYMOUS_PROFILE);
      expect(yield* asServerFn(currentOwner, EMPTY_REQUEST_INFO)).toEqual(Option.none());
      const error = yield* Effect.flip(asServerFn(requireAccount, EMPTY_REQUEST_INFO));
      expect(appErrorOf(error)?.code).toBe('NOT_LOGGED_IN');
    }),
  );

  it.effect("ensureOwner creates the browser's session: its data belongs to the session", () =>
    Effect.gen(function* () {
      const sessions = fakeSessions();
      expect(yield* asServerFn(ensureOwner, EMPTY_REQUEST_INFO, sessions)).toBe('session:id-t1');
      expect(yield* asServerFn(ensureOwner, request({ token: 't1' }), sessions)).toBe('session:id-t1');
      expect(sessions.createdCount()).toBe(1);
      const error = yield* Effect.flip(asServerFn(requireAccount, request({ token: 't1' }), sessions));
      expect(appErrorOf(error)?.code).toBe('NOT_LOGGED_IN');
    }),
  );

  it.effect("a browser bound to a Facebook account: the account's profile and data", () =>
    Effect.gen(function* () {
      const sessions = fakeSessions({ bound: ['alice-token'] });
      const info = request({ token: 'alice-token' });
      expect(yield* asServerFn(currentProfile, info, sessions)).toEqual(accountProfile(ALICE));
      expect(yield* asServerFn(currentOwner, info, sessions)).toEqual(Option.some('fb:1001'));
      expect(yield* asServerFn(ensureOwner, info, sessions)).toBe('fb:1001');
      expect((yield* asServerFn(requireAccount, info, sessions)).userId).toBe(ALICE);
    }),
  );
});

describe('CurrentClient: cookie renewal', () => {
  it.effect("a POST from a known session sets the same cookie again (once per call); GETs and unknown tokens don't", () =>
    Effect.gen(function* () {
      const sessions = fakeSessions({ bound: ['known'] });
      const post = yield* clientFor(request({ token: 'known', method: 'POST' }), {}, sessions);
      yield* post.client.session;
      yield* post.client.session;
      expect(post.cookies).toEqual([{ token: 'known', secure: false }]);

      const get = yield* clientFor(request({ token: 'known', method: 'GET' }), {}, sessions);
      yield* get.client.session;
      expect(get.cookies).toEqual([]);

      const unknown = yield* clientFor(request({ token: 'stale', method: 'POST' }), {}, sessions);
      yield* unknown.client.session;
      expect(unknown.cookies).toEqual([]);
    }),
  );

  it.effect('a session created during a POST sets its cookie once, without a second renewal', () =>
    Effect.gen(function* () {
      const { client, cookies } = yield* clientFor(request({ method: 'POST' }));
      yield* client.ensureSession;
      yield* client.session;
      expect(cookies).toEqual([{ token: 't1', secure: false }]);
    }),
  );
});

describe('CurrentClient: cookie names', () => {
  it.effect('over HTTPS only the __Host- cookie names the session', () =>
    Effect.gen(function* () {
      const sessions = fakeSessions({ bound: ['known'] });
      const plain = yield* clientFor(request({ token: 'known', forwardedProto: 'https' }), { trustProxy: true }, sessions);
      expect(Option.isNone(yield* plain.client.session)).toBe(true);
      const prefixed = yield* clientFor(request({ secureToken: 'known', forwardedProto: 'https' }), { trustProxy: true }, sessions);
      expect(Option.isSome(yield* prefixed.client.session)).toBe(true);
      const overHttp = yield* clientFor(request({ secureToken: 'known' }), {}, sessions);
      expect(Option.isNone(yield* overHttp.client.session)).toBe(true);
    }),
  );
});
