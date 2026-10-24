// Marketplace search with "load more" sessions. Port of legacy/src/server/fb/search.ts.
//
// search() loads the results page in a hidden page and reads page 1 from its embedded JSON. When
// Facebook has more pages, the page stays open as a session (its own Scope, a child of the layer's)
// so loadMore() can fetch the next page from inside it:
//   1. replay Facebook's own pagination request (captured once) with the next cursor;
//   2. before any capture: scroll the page so Facebook fires that request itself, and capture it;
//   3. fallback: replay the page's preloaded feed query with the next cursor, using the page's tokens.
// Logged out, Facebook blocks scrolling after page 2 with a "See more on Facebook" login wall, so
// replay is the main path.
//
// Sessions belong to the Facebook profile they were opened for (their page comes from that
// profile's hidden context): another profile's loadMore/closeSession treats them as unknown, so
// one person can never page through (or close) someone else's search. At most
// MAX_SESSIONS_PER_PROFILE per profile and MAX_SESSIONS in total (the least recently used one, of
// the profile or overall, is closed to make room), closed after SESSION_IDLE_MS without use (a
// sweeper fiber forked into the layer scope), closed when the feed runs out, and dropped when
// their page died (the profile's browser context was reset after login/logout, or evicted).
// loadMore calls on one session run one at a time (a per-session Semaphore). A gone session is
// SESSION_EXPIRED; the UI offers to run the search again.
//
// searchFirstPage reads page 1 in a one-shot page (Browser.withPage) and keeps no session:
// background checks must not evict the sessions people are paging through.
import '@tanstack/react-start/server-only';
import { randomUUID } from 'node:crypto';
import { Clock, Effect, Exit, Fiber, Option, Ref, Result, Schema, Scope, Semaphore } from 'effect';
import type { Page, Request } from 'playwright';
import type { BrowserShape } from '@/server/browser/Browser';
import {
  detectFeedKind,
  extractPageInfo,
  extractPageTokens,
  extractPreloadedQueries,
  extractSearchLocation,
  findFeedQuery,
  findListings,
  graphqlErrors,
  parseGraphqlBody,
  type PageInfo,
  type PageTokens,
  type PreloadedQuery,
} from '@/server/marketplace/extract';
import {
  bestEffort,
  dismissLoginModal,
  GRAPHQL_TIMEOUT_MS,
  graphqlInPage,
  graphqlRequest,
  interactionError,
  loadFacebookPage,
  looksLikeLoginWall,
} from '@/server/marketplace/fb-page';
import type { SearchPage } from '@/server/marketplace/Marketplace';
import { marketplaceUrl } from '@/server/marketplace/urls';
import { profileKey, type FbProfile } from '@/server/session/identity';
import type { ListingSummary, SearchLocationInfo, SearchParams } from '@/shared/domain';
import { AppError } from '@/shared/errors';

/** Open search sessions across all profiles. */
export const MAX_SESSIONS = 8;
/** Open search sessions of one profile. */
export const MAX_SESSIONS_PER_PROFILE = 3;
export const SESSION_IDLE_MS = 10 * 60_000;
/** How often idle sessions are looked for (so a session lives 10 to 10.5 minutes after its last use). */
const SWEEP_INTERVAL_MS = 30_000;
const SCROLL_CAPTURE_MS = 12_000;
/** Keep fetching (up to MAX_FETCHES_PER_LOAD pages) until a load has at least this many new listings. */
export const MIN_NEW_PER_LOAD = 10;
export const MAX_FETCHES_PER_LOAD = 3;

/** Limits of the session pool. The defaults are the product's; tests shrink them. */
export interface SearchEngineOptions {
  readonly maxSessions?: number;
  readonly maxSessionsPerProfile?: number;
  readonly sessionIdleMs?: number;
  readonly sweepIntervalMs?: number;
  /** How long to scroll and wait for Facebook's own pagination request (strategy 2). */
  readonly scrollCaptureMs?: number;
}

// ---------- pure pagination logic (unit-tested) ----------

/** Facebook's own pagination request, captured from the page; replayed with new cursors. */
export interface CapturedRequest {
  readonly form: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Where a session is in the feed. Only changed while holding the session's lock. */
export interface Pagination {
  /** Every listing id already returned by this session. */
  readonly seen: ReadonlySet<string>;
  readonly cursor: string | null;
  readonly hasMore: boolean;
  readonly template: CapturedRequest | null;
  readonly pagesFetched: number;
}

export interface FetchedPage {
  readonly listings: readonly ListingSummary[];
  readonly pageInfo: PageInfo | null;
}

/** Apply one fetched page: the listings this session hasn't returned yet, and the next state. */
export function advance(state: Pagination, page: FetchedPage): { readonly state: Pagination; readonly fresh: ListingSummary[] } {
  const seen = new Set(state.seen);
  const fresh: ListingSummary[] = [];
  for (const listing of page.listings) {
    if (seen.has(listing.id)) continue;
    seen.add(listing.id);
    fresh.push(listing);
  }
  const cursor = page.pageInfo?.endCursor ?? null;
  // A cursor that didn't move means Facebook is serving the same page again.
  const advanced = cursor !== null && cursor !== state.cursor;
  return {
    state: { ...state, seen, cursor, hasMore: page.pageInfo?.hasNextPage === true && advanced, pagesFetched: state.pagesFetched + 1 },
    fresh,
  };
}

const PaginationVariables = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const CursorVariables = Schema.fromJsonString(Schema.Struct({ cursor: Schema.String }));
const decodeVariables = Schema.decodeUnknownOption(PaginationVariables);
const decodeCursor = Schema.decodeUnknownOption(CursorVariables);

/** A captured pagination request's form with our cursor (null when its variables aren't JSON). */
export function replayForm(template: string, cursor: string | null, pagesFetched: number): URLSearchParams | null {
  const form = new URLSearchParams(template);
  const variables = decodeVariables(form.get('variables') ?? '{}');
  if (Option.isNone(variables)) return null;
  form.set('variables', JSON.stringify({ ...variables.value, cursor }));
  // __req is the client's base-36 request counter; keep it moving like the real client does.
  const req = parseInt(form.get('__req') ?? '', 36);
  if (Number.isFinite(req)) form.set('__req', (req + pagesFetched).toString(36));
  return form;
}

/** The cursor a captured pagination request asked for, or null. */
export function requestedCursor(form: string): string | null {
  return Option.getOrNull(Option.map(decodeCursor(new URLSearchParams(form).get('variables') ?? ''), (v) => v.cursor));
}

const friendlyNameOf = (request: Request): string =>
  request.headers()['x-fb-friendly-name'] ?? new URLSearchParams(request.postData() ?? '').get('fb_api_req_friendly_name') ?? '';

/** Facebook's own "next page" request (search: CometMarketplaceSearchContentPaginationQuery). */
export const isPaginationRequest = (request: Request): boolean =>
  request.url().includes('/api/graphql') && /Marketplace.*PaginationQuery$/.test(friendlyNameOf(request));

// ---------- errors ----------

const sessionExpired = () =>
  new AppError({ code: 'SESSION_EXPIRED', message: 'This search has expired. Run it again to see more results.' });

const parseFailed = (message: string) => new AppError({ code: 'FB_PARSE_FAILED', message });

/** The listings feed in GraphQL documents, or why there isn't one. */
function readFeedPage(docs: readonly unknown[]): Effect.Effect<FetchedPage, AppError> {
  if (detectFeedKind(docs) === null) {
    const error = graphqlErrors(docs)[0];
    return Effect.fail(parseFailed(error ? `Facebook returned an error: ${error}` : 'Facebook returned no results feed.'));
  }
  return Effect.succeed({ listings: findListings(docs), pageInfo: extractPageInfo(docs) });
}

/** The most useful of several strategy failures: a block or timeout says more than a parse failure. */
const mostRelevant = (errors: readonly AppError[]): AppError =>
  errors.find((e) => e.code === 'FB_BLOCKED') ??
  errors.find((e) => e.code === 'FB_TIMEOUT') ??
  errors[0] ??
  parseFailed("Couldn't load more results from Facebook.");

// ---------- sessions ----------

interface Session {
  readonly id: string;
  /** profileKey of the profile it was opened for; only that profile can use or close it. */
  readonly owner: string;
  /** Owns the page; closing it closes the page. */
  readonly scope: Scope.Closeable;
  readonly page: Page;
  readonly location: SearchLocationInfo | null;
  /** The page's preloaded feed query (fallback replay). */
  readonly feedQuery: PreloadedQuery | null;
  readonly tokens: PageTokens;
  /** Serializes loadMore calls on this session. */
  readonly lock: Semaphore.Semaphore;
  readonly pagination: Ref.Ref<Pagination>;
}

interface PoolEntry {
  readonly session: Session;
  readonly lastUsedAt: number;
}

/** Open sessions in least-recently-used-first order (Map insertion order). */
type Pool = ReadonlyMap<string, PoolEntry>;

export interface SearchEngine {
  readonly search: (profile: FbProfile, params: SearchParams) => Effect.Effect<SearchPage, AppError>;
  readonly searchFirstPage: (profile: FbProfile, params: SearchParams) => Effect.Effect<SearchPage, AppError>;
  readonly loadMore: (profile: FbProfile, sessionId: string) => Effect.Effect<SearchPage, AppError>;
  readonly closeSession: (profile: FbProfile, sessionId: string) => Effect.Effect<void>;
  readonly closeAllSessions: (profile: FbProfile) => Effect.Effect<void>;
  /** Open sessions, of one profile or in total (diagnostics and tests). */
  readonly sessionCount: (profile?: FbProfile) => Effect.Effect<number>;
}

/** The search engine. Requires the layer's Scope: sessions are child scopes, the idle sweeper a scoped fiber. */
export const makeSearchEngine = Effect.fn('Marketplace.makeSearchEngine')(function* (
  browser: BrowserShape,
  options: SearchEngineOptions = {},
) {
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const maxSessionsPerProfile = options.maxSessionsPerProfile ?? MAX_SESSIONS_PER_PROFILE;
  const sessionIdleMs = options.sessionIdleMs ?? SESSION_IDLE_MS;
  const scrollCaptureMs = options.scrollCaptureMs ?? SCROLL_CAPTURE_MS;
  const layerScope = yield* Effect.scope;
  const pool = yield* Ref.make<Pool>(new Map());

  const closeAll = (sessions: Iterable<Session>) =>
    Effect.forEach(sessions, (session) => Scope.close(session.scope, Exit.void), { discard: true });

  /** Remove `owner`'s session from the pool (without closing). Null when it wasn't there (or isn't theirs). */
  const take = (owner: string, sessionId: string) =>
    Ref.modify(pool, (current): readonly [Session | null, Pool] => {
      const entry = current.get(sessionId);
      if (entry?.session.owner !== owner) return [null, current];
      const next = new Map(current);
      next.delete(sessionId);
      return [entry.session, next];
    });

  const closeSession = (owner: string, sessionId: string): Effect.Effect<void> =>
    Effect.flatMap(take(owner, sessionId), (session) => (session ? Scope.close(session.scope, Exit.void) : Effect.void));

  const closeAllSessions = (profile: FbProfile): Effect.Effect<void> => {
    const owner = profileKey(profile);
    return Effect.flatMap(
      Ref.modify(pool, (current): readonly [Session[], Pool] => {
        const next = new Map(current);
        const out: Session[] = [];
        for (const [id, entry] of current) {
          if (entry.session.owner !== owner) continue;
          out.push(entry.session);
          next.delete(id);
        }
        return [out, next];
      }),
      closeAll,
    ).pipe(Effect.withSpan('Marketplace.closeAllSessions'));
  };

  /** Mark as most recently used (moves it to the end of the pool) and restart its idle time. */
  const touch = (sessionId: string) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Ref.update(pool, (current) => {
        const entry = current.get(sessionId);
        if (!entry) return current;
        const next = new Map(current);
        next.delete(sessionId);
        next.set(sessionId, { session: entry.session, lastUsedAt: now });
        return next;
      }),
    );

  /**
   * Add a session, closing dead ones, then the profile's least recently used until it has room,
   * then the least recently used overall until the pool has room.
   */
  const register = (session: Session) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const evicted = yield* Ref.modify(pool, (current): readonly [Session[], Pool] => {
        const next = new Map(current);
        const out: Session[] = [];
        const evict = (id: string, entry: PoolEntry) => {
          out.push(entry.session);
          next.delete(id);
        };
        for (const [id, entry] of current) if (entry.session.page.isClosed()) evict(id, entry);
        let own = 0;
        for (const entry of next.values()) if (entry.session.owner === session.owner) own++;
        for (const [id, entry] of current) {
          if (own < maxSessionsPerProfile) break;
          if (next.has(id) && entry.session.owner === session.owner) {
            evict(id, entry);
            own--;
          }
        }
        for (const [id, entry] of current) {
          if (next.size < maxSessions) break;
          if (next.has(id)) evict(id, entry);
        }
        next.set(session.id, { session, lastUsedAt: now });
        return [out, next];
      });
      yield* closeAll(evicted);
    });

  /** Close sessions idle for SESSION_IDLE_MS, and forget ones whose page died. */
  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const expired = yield* Ref.modify(pool, (current): readonly [Session[], Pool] => {
      const out: Session[] = [];
      const next = new Map(current);
      for (const [id, entry] of current) {
        if (entry.session.page.isClosed() || now - entry.lastUsedAt >= sessionIdleMs) {
          out.push(entry.session);
          next.delete(id);
        }
      }
      return out.length === 0 ? [out, current] : [out, next];
    });
    yield* closeAll(expired);
  });
  // Interrupted when the runtime is disposed (which also closes every session scope).
  yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(options.sweepIntervalMs ?? SWEEP_INTERVAL_MS), sweep)));

  /** Still registered under its id and its page is open. */
  const isLive = (session: Session) =>
    Effect.map(Ref.get(pool), (current) => current.get(session.id)?.session === session && !session.page.isClosed());

  // ----- strategies for the next page -----

  /** Strategy 1: Facebook's own pagination request with our cursor. */
  const replayCaptured = Effect.fnUntraced(function* (session: Session) {
    const state = yield* Ref.get(session.pagination);
    if (state.template === null) return yield* parseFailed('No captured pagination request to replay.');
    const form = replayForm(state.template.form, state.cursor, state.pagesFetched);
    if (form === null) return yield* parseFailed("Couldn't read Facebook's pagination request.");
    const docs = yield* graphqlInPage(session.page, { form, headers: state.template.headers });
    return yield* readFeedPage(docs);
  });

  /**
   * Strategy 2: scroll until Facebook requests page 2 itself, keep that request as the replay
   * template, and use its response when it's for our cursor (else replay the template).
   * Scrolling stops as soon as the request goes out, so Facebook doesn't prefetch further pages.
   */
  const scrollAndCapture = Effect.fnUntraced(function* (session: Session) {
    const page = session.page;
    const capture = yield* Effect.forkChild(
      Effect.tryPromise({
        try: () => page.waitForRequest(isPaginationRequest, { timeout: scrollCaptureMs }),
        catch: (cause) =>
          interactionError(cause, "Couldn't capture Facebook's pagination request", 'Facebook took too long to load more results.'),
      }),
      { startImmediately: true },
    );
    const sent = () => capture.pollUnsafe() !== undefined;
    yield* dismissLoginModal(page);
    yield* bestEffort(() => page.mouse.move(640, 500));
    for (let i = 0; i < 8 && !sent(); i++) {
      yield* bestEffort(() => page.mouse.wheel(0, 4000));
      for (let t = 0; t < 6 && !sent(); t++) yield* Effect.sleep('250 millis');
    }
    const request = yield* Fiber.join(capture);

    const form = request.postData() ?? '';
    const cursor = requestedCursor(form);
    if (cursor === null) return yield* parseFailed("Facebook's pagination request had no cursor.");
    const sentHeaders = request.headers();
    const headers: Record<string, string> = {};
    for (const name of ['x-fb-friendly-name', 'x-fb-lsd', 'x-asbd-id']) {
      const value = sentHeaders[name];
      if (value) headers[name] = value;
    }
    const state = yield* Ref.updateAndGet(session.pagination, (s) => ({ ...s, template: { form, headers } }));

    if (cursor === state.cursor) {
      // Facebook already answered it: use that response instead of asking again.
      // (Playwright waits for it without a timeout; past ours, replay the request instead.)
      const text = yield* Effect.tryPromise(async () => {
        const response = await request.response();
        return response?.ok() ? await response.text() : '';
      }).pipe(
        Effect.orElseSucceed(() => ''),
        Effect.timeoutOrElse({ duration: GRAPHQL_TIMEOUT_MS, orElse: () => Effect.succeed('') }),
      );
      if (text) return yield* readFeedPage(parseGraphqlBody(text));
    }
    return yield* replayCaptured(session);
  });

  /** Strategy 3: the page's preloaded feed query (doc id + variables from the HTML) with our cursor. */
  const replayPreloaded = Effect.fnUntraced(function* (session: Session, query: PreloadedQuery) {
    const { cursor } = yield* Ref.get(session.pagination);
    const docs = yield* graphqlInPage(
      session.page,
      graphqlRequest(session.tokens, query.queryName, query.queryID, { ...query.variables, cursor }),
    );
    return yield* readFeedPage(docs);
  });

  /** One next page via the first strategy that works. */
  const fetchNextPage = Effect.fnUntraced(function* (session: Session) {
    const state = yield* Ref.get(session.pagination);
    const strategies: Effect.Effect<FetchedPage, AppError>[] = [];
    if (state.template) strategies.push(replayCaptured(session));
    // Facebook's client still sits on page 1 only until we've fetched anything ourselves.
    if (!state.template && state.pagesFetched === 0) strategies.push(scrollAndCapture(session));
    if (session.feedQuery && session.tokens.lsd) strategies.push(replayPreloaded(session, session.feedQuery));

    const errors: AppError[] = [];
    for (const strategy of strategies) {
      if (session.page.isClosed()) break;
      const result = yield* Effect.result(strategy);
      if (Result.isSuccess(result)) return result.success;
      errors.push(result.failure);
    }
    if (session.page.isClosed()) return yield* sessionExpired();
    return yield* mostRelevant(errors);
  });

  /** One loadMore, holding the session's lock. */
  const loadMoreNow = Effect.fnUntraced(function* (session: Session) {
    if (!(yield* isLive(session))) return yield* sessionExpired();
    const fresh: ListingSummary[] = [];
    for (let i = 0; i < MAX_FETCHES_PER_LOAD; i++) {
      const { hasMore } = yield* Ref.get(session.pagination);
      if (!hasMore || fresh.length >= MIN_NEW_PER_LOAD) break;
      const next = yield* Effect.result(fetchNextPage(session));
      if (Result.isFailure(next)) {
        // Keep what we already have; the next loadMore retries from the last good cursor.
        if (fresh.length > 0) break;
        return yield* (yield* isLive(session)) ? next.failure : sessionExpired();
      }
      const added = yield* Ref.modify(session.pagination, (state) => {
        const step = advance(state, next.success);
        return [step.fresh, step.state] as const;
      });
      fresh.push(...added);
    }
    // Several pages in a row with nothing new: treat the feed as exhausted.
    const { hasMore } = yield* Ref.updateAndGet(session.pagination, (state) =>
      fresh.length === 0 ? { ...state, hasMore: false } : state,
    );
    if (hasMore) yield* touch(session.id);
    else yield* closeSession(session.owner, session.id);
    return { sessionId: hasMore ? session.id : null, listings: fresh, hasMore, location: session.location } satisfies SearchPage;
  });

  /** Load the results page and read page 1 (typed errors for walls, blocks, unknown categories). */
  const readFirstPage = Effect.fnUntraced(function* (page: Page, params: SearchParams) {
    const { html, blobs } = yield* loadFacebookPage(page, marketplaceUrl(params));
    const kind = detectFeedKind(blobs);
    if (kind === null) {
      if (looksLikeLoginWall(html)) {
        return yield* new AppError({ code: 'FB_BLOCKED', message: 'Facebook is asking to log in before showing Marketplace.' });
      }
      return yield* parseFailed("Facebook's Marketplace page loaded, but its results couldn't be read.");
    }
    const category = params.category?.trim();
    if (category && kind === 'home') {
      // Facebook sends unknown category slugs to the nearby feed instead of a 404.
      return yield* new AppError({ code: 'BAD_REQUEST', message: `Unknown Marketplace category "${category}".` });
    }

    const listings = findListings(blobs);
    const pageInfo = extractPageInfo(blobs);
    // An empty first page means no results, even though Facebook still reports a next page.
    const cursor = listings.length > 0 && pageInfo?.hasNextPage === true ? pageInfo.endCursor : null;
    return { html, blobs, listings, cursor, location: extractSearchLocation(blobs) };
  });

  /** Read page 1 as `profile` in a page owned by `scope`; registers a session when there are more pages. */
  const openSearch = Effect.fnUntraced(function* (scope: Scope.Closeable, profile: FbProfile, params: SearchParams) {
    const page = yield* browser.openPage(profile).pipe(Scope.provide(scope));
    const { html, blobs, listings, cursor, location } = yield* readFirstPage(page, params);
    if (cursor === null) return { sessionId: null, listings, hasMore: false, location } satisfies SearchPage;

    const session: Session = {
      id: randomUUID(),
      owner: profileKey(profile),
      scope,
      page,
      location,
      feedQuery: findFeedQuery(extractPreloadedQueries(blobs)),
      tokens: extractPageTokens(html),
      lock: yield* Semaphore.make(1),
      pagination: yield* Ref.make<Pagination>({
        seen: new Set(listings.map((l) => l.id)),
        cursor,
        hasMore: true,
        template: null,
        pagesFetched: 0,
      }),
    };
    yield* register(session);
    return { sessionId: session.id, listings, hasMore: true, location } satisfies SearchPage;
  });

  const search = Effect.fn('Marketplace.search')((profile: FbProfile, params: SearchParams) =>
    Effect.acquireUseRelease(
      // A child of the layer scope: runtime disposal closes every session page.
      Scope.fork(layerScope),
      (scope) => openSearch(scope, profile, params),
      // The page outlives this call only when it became a session.
      (scope, exit) => (Exit.isSuccess(exit) && exit.value.sessionId !== null ? Effect.void : Scope.close(scope, Exit.void)),
    ),
  );

  const searchFirstPage = Effect.fn('Marketplace.searchFirstPage')((profile: FbProfile, params: SearchParams) =>
    browser.withPage(profile, (page) =>
      Effect.map(
        readFirstPage(page, params),
        // Nothing to load more from: the page closes with this call.
        ({ listings, location }): SearchPage => ({ sessionId: null, listings, hasMore: false, location }),
      ),
    ),
  );

  const loadMore = Effect.fn('Marketplace.loadMore')(function* (profile: FbProfile, sessionId: string) {
    const owner = profileKey(profile);
    const entry = (yield* Ref.get(pool)).get(sessionId);
    // Another profile's session is as good as unknown (and stays open for its owner).
    if (entry?.session.owner !== owner) return yield* sessionExpired();
    if (entry.session.page.isClosed()) {
      yield* closeSession(owner, sessionId);
      return yield* sessionExpired();
    }
    yield* touch(sessionId);
    return yield* entry.session.lock.withPermits(1)(loadMoreNow(entry.session));
  });

  return {
    search,
    searchFirstPage,
    loadMore,
    closeSession: (profile: FbProfile, sessionId: string) =>
      closeSession(profileKey(profile), sessionId).pipe(Effect.withSpan('Marketplace.closeSession')),
    closeAllSessions,
    sessionCount: (profile?: FbProfile) =>
      Effect.map(Ref.get(pool), (current) => {
        if (profile === undefined) return current.size;
        const owner = profileKey(profile);
        let count = 0;
        for (const entry of current.values()) if (entry.session.owner === owner) count++;
        return count;
      }),
  } satisfies SearchEngine;
});
