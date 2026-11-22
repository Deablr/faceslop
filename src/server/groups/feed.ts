// Reading a group's newest posts from inside a facebook.com page, with "load more" sessions.
//
// A group page embeds only its newest post; Facebook fetches the rest three at a time with
// GroupsCometFeedRegularStoriesPaginationQuery as the page scrolls. So, like Marketplace search
// (src/server/marketplace/search.ts):
//   1. the first next page: scroll until Facebook sends that request itself, keep it as a template,
//      and use its response (scrolling stops as soon as it goes out, so nothing is prefetched);
//   2. every later page: replay the template with the next cursor, from inside the page.
//
// readLatest (background checks) does this in a one-shot page (Browser.withPage). openFeed keeps
// the page open as a session for loadMore, owned by the profile that opened it, at most
// MAX_FEEDS_PER_PROFILE per profile and MAX_FEEDS overall (least recently used closed first), closed
// after FEED_IDLE_MS. One loadMore at a time per session.
import '@tanstack/react-start/server-only';
import { randomUUID } from 'node:crypto';
import { Clock, Effect, Exit, Fiber, Ref, Result, Scope, Semaphore } from 'effect';
import type { Page, Request } from 'playwright';
import type { BrowserShape } from '@/server/browser/Browser';
import { extractGroupFeedPageInfo, extractGroupInfo, findGroupPosts, hasGroupFeed } from '@/server/groups/extract';
import { groupFeedUrl } from '@/server/groups/urls';
import { graphqlErrors, parseGraphqlBody, type PageInfo } from '@/server/marketplace/extract';
import { bestEffort, GRAPHQL_TIMEOUT_MS, graphqlInPage, interactionError, loadFacebookPage, looksLikeLoginWall } from '@/server/marketplace/fb-page';
import { replayForm, requestedCursor, type CapturedRequest } from '@/server/marketplace/search';
import { profileKey, type FbProfile } from '@/server/session/identity';
import type { GroupFeedPage, GroupInfo, GroupPost } from '@/shared/domain';
import { AppError } from '@/shared/errors';

export const MAX_FEEDS = 6;
export const MAX_FEEDS_PER_PROFILE = 2;
export const FEED_IDLE_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 30_000;
const SCROLL_CAPTURE_MS = 12_000;
/** "Load more" keeps fetching (three posts a request) until it has this many new posts, at most MAX_FETCHES_PER_LOAD requests. */
export const MIN_NEW_PER_LOAD = 8;
export const MAX_FETCHES_PER_LOAD = 4;

export interface GroupFeedOptions {
  readonly maxFeeds?: number;
  readonly maxFeedsPerProfile?: number;
  readonly feedIdleMs?: number;
  readonly sweepIntervalMs?: number;
  readonly scrollCaptureMs?: number;
}

// ---------- pure ----------

/** Where a feed is: the posts it returned, the next cursor, and Facebook's request to replay. */
export interface FeedState {
  readonly seen: ReadonlySet<string>;
  readonly cursor: string | null;
  readonly hasMore: boolean;
  readonly template: CapturedRequest | null;
  readonly pagesFetched: number;
}

export interface FetchedPosts {
  readonly posts: readonly GroupPost[];
  readonly pageInfo: PageInfo | null;
}

/** Apply one fetched page: the posts not returned before, and the next state. */
export function advanceFeed(state: FeedState, page: FetchedPosts): { readonly state: FeedState; readonly fresh: GroupPost[] } {
  const seen = new Set(state.seen);
  const fresh: GroupPost[] = [];
  for (const post of page.posts) {
    if (seen.has(post.id)) continue;
    seen.add(post.id);
    fresh.push(post);
  }
  const cursor = page.pageInfo?.endCursor ?? null;
  // A cursor that didn't move means Facebook is serving the same page again.
  const advanced = cursor !== null && cursor !== state.cursor;
  return {
    state: { ...state, seen, cursor, hasMore: page.pageInfo?.hasNextPage === true && advanced, pagesFetched: state.pagesFetched + 1 },
    fresh,
  };
}

const friendlyNameOf = (request: Request): string =>
  request.headers()['x-fb-friendly-name'] ?? new URLSearchParams(request.postData() ?? '').get('fb_api_req_friendly_name') ?? '';

/** Facebook's own "more posts" request for a group feed. */
export const isGroupFeedPaginationRequest = (request: Request): boolean =>
  request.url().includes('/api/graphql') && /^GroupsCometFeed.*PaginationQuery$/.test(friendlyNameOf(request));

// ---------- errors ----------

const parseFailed = (message: string) => new AppError({ code: 'FB_PARSE_FAILED', message });
const feedExpired = () => new AppError({ code: 'SESSION_EXPIRED', message: 'This group page has expired. Open it again to see more posts.' });

function readFeedDocs(docs: readonly unknown[], groupId: string): Effect.Effect<FetchedPosts, AppError> {
  if (!hasGroupFeed(docs)) {
    const error = graphqlErrors(docs)[0];
    return Effect.fail(parseFailed(error ? `Facebook returned an error: ${error}` : "Facebook didn't return the group's posts."));
  }
  return Effect.succeed({ posts: findGroupPosts(docs, groupId), pageInfo: extractGroupFeedPageInfo(docs) });
}

// ---------- reading from a page ----------

/** A loaded group page: its group, newest post(s), and where the feed continues. */
interface OpenedGroup {
  readonly group: GroupInfo;
  readonly posts: readonly GroupPost[];
  readonly pageInfo: PageInfo | null;
}

/**
 * Load a group's page (newest posts first) and read it. FORBIDDEN when the account can't see the
 * group's posts (not a member of a private group), NOT_FOUND when Facebook has no such group.
 */
export const openGroupPage = Effect.fn('Groups.openGroupPage')(function* (page: Page, ref: string) {
  const { html, blobs } = yield* loadFacebookPage(page, groupFeedUrl(ref));
  const info = extractGroupInfo(blobs);
  if (!hasGroupFeed(blobs)) {
    if (info?.isMember === false) {
      return yield* new AppError({ code: 'FORBIDDEN', message: 'Join this group on Facebook first: its posts are for members only.' });
    }
    if (looksLikeLoginWall(html)) {
      return yield* new AppError({ code: 'FB_BLOCKED', message: 'Facebook is asking to log in again before showing groups.' });
    }
    if (info === null) return yield* new AppError({ code: 'NOT_FOUND', message: "Facebook couldn't find that group." });
    return yield* parseFailed("The group's page loaded, but its posts couldn't be read.");
  }
  if (info === null) return yield* parseFailed("The group's page loaded, but the group couldn't be read.");
  const posts = findGroupPosts(blobs, info.id);
  const group: GroupInfo = { id: info.id, name: info.name ?? posts.find((p) => p.groupName !== null)?.groupName ?? null };
  return { group, posts, pageInfo: extractGroupFeedPageInfo(blobs) } satisfies OpenedGroup;
});

/** Pages through one open group page. Only used while holding the feed's lock (or in a one-shot page). */
const makePager = (page: Page, groupId: string, state: Ref.Ref<FeedState>, scrollCaptureMs: number) => {
  /** Facebook's own pagination request with our cursor. */
  const replay = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (current.template === null) return yield* parseFailed('No captured group feed request to replay.');
    const form = replayForm(current.template.form, current.cursor, current.pagesFetched);
    if (form === null) return yield* parseFailed("Couldn't read Facebook's group feed request.");
    return yield* readFeedDocs(yield* graphqlInPage(page, { form, headers: current.template.headers }), groupId);
  });

  /** Scroll until Facebook asks for more posts itself; keep that request, use its response. */
  const scrollAndCapture = Effect.gen(function* () {
    const capture = yield* Effect.forkChild(
      Effect.tryPromise({
        try: () => page.waitForRequest(isGroupFeedPaginationRequest, { timeout: scrollCaptureMs }),
        catch: (cause) => interactionError(cause, "Couldn't capture Facebook's group feed request", 'Facebook took too long to load more posts.'),
      }),
      { startImmediately: true },
    );
    const sent = () => capture.pollUnsafe() !== undefined;
    yield* bestEffort(() => page.mouse.move(640, 500));
    for (let i = 0; i < 8 && !sent(); i++) {
      yield* bestEffort(() => page.mouse.wheel(0, 4000));
      for (let t = 0; t < 6 && !sent(); t++) yield* Effect.sleep('250 millis');
    }
    const request = yield* Fiber.join(capture);
    const form = request.postData() ?? '';
    const cursor = requestedCursor(form);
    if (cursor === null) return yield* parseFailed("Facebook's group feed request had no cursor.");
    const sentHeaders = request.headers();
    const headers: Record<string, string> = {};
    for (const name of ['x-fb-friendly-name', 'x-fb-lsd', 'x-asbd-id']) {
      const value = sentHeaders[name];
      if (value) headers[name] = value;
    }
    const current = yield* Ref.updateAndGet(state, (s) => ({ ...s, template: { form, headers } }));
    if (cursor === current.cursor) {
      const text = yield* Effect.tryPromise(async () => {
        const response = await request.response();
        return response?.ok() ? await response.text() : '';
      }).pipe(
        Effect.orElseSucceed(() => ''),
        Effect.timeoutOrElse({ duration: GRAPHQL_TIMEOUT_MS, orElse: () => Effect.succeed('') }),
      );
      if (text) return yield* readFeedDocs(parseGraphqlBody(text), groupId);
    }
    return yield* replay;
  });

  /** The next page's posts that weren't returned yet (and the state moves on). */
  const next = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    const fetched = yield* current.template === null ? scrollAndCapture : replay;
    return yield* Ref.modify(state, (s) => {
      const step = advanceFeed(s, fetched);
      return [step.fresh, step.state] as const;
    });
  });

  return { next };
};

const initialState = (opened: OpenedGroup): FeedState => ({
  seen: new Set(opened.posts.map((p) => p.id)),
  cursor: opened.pageInfo?.endCursor ?? null,
  hasMore: opened.pageInfo?.hasNextPage === true,
  template: null,
  pagesFetched: 0,
});

// ---------- sessions ----------

interface Feed {
  readonly id: string;
  readonly owner: string;
  readonly scope: Scope.Closeable;
  readonly page: Page;
  readonly group: GroupInfo;
  readonly lock: Semaphore.Semaphore;
  readonly state: Ref.Ref<FeedState>;
  readonly next: Effect.Effect<GroupPost[], AppError>;
  lastUsedAt: number;
}

export interface LatestPosts {
  readonly group: GroupInfo;
  /** Newest first, as the feed lists them. */
  readonly posts: readonly GroupPost[];
  /** True when the feed has older posts than these. */
  readonly hasMore: boolean;
  /** Why reading stopped early: a next page failed (the posts before it are still here). */
  readonly stoppedBy: AppError | null;
}

export interface GroupFeeds {
  readonly open: (profile: FbProfile, ref: string) => Effect.Effect<GroupFeedPage, AppError>;
  readonly loadMore: (profile: FbProfile, sessionId: string) => Effect.Effect<GroupFeedPage, AppError>;
  readonly close: (profile: FbProfile, sessionId: string) => Effect.Effect<void>;
  readonly closeAll: (profile: FbProfile) => Effect.Effect<void>;
  /**
   * The newest posts in a one-shot page: the page's own, then next pages while `more(postsSoFar)`
   * says so, at most `maxPages` requests. For background checks (no session is kept).
   */
  readonly readLatest: (
    profile: FbProfile,
    groupId: string,
    options: { readonly maxPages: number; readonly more: (posts: readonly GroupPost[]) => boolean },
  ) => Effect.Effect<LatestPosts, AppError>;
  /** The group a reference (id or vanity name) is, as its page says. */
  readonly resolve: (profile: FbProfile, ref: string) => Effect.Effect<GroupInfo, AppError>;
  readonly feedCount: (profile?: FbProfile) => Effect.Effect<number>;
}

/** The group feed engine. Requires the layer's Scope (feeds are child scopes, the sweeper a scoped fiber). */
export const makeGroupFeeds = Effect.fn('Groups.makeGroupFeeds')(function* (browser: BrowserShape, options: GroupFeedOptions = {}) {
  const maxFeeds = options.maxFeeds ?? MAX_FEEDS;
  const maxPerProfile = options.maxFeedsPerProfile ?? MAX_FEEDS_PER_PROFILE;
  const idleMs = options.feedIdleMs ?? FEED_IDLE_MS;
  const scrollCaptureMs = options.scrollCaptureMs ?? SCROLL_CAPTURE_MS;
  const layerScope = yield* Effect.scope;
  /** Least recently used first (Map insertion order); only changed synchronously. */
  const feeds = new Map<string, Feed>();

  const closeFeeds = (list: readonly Feed[]) => Effect.forEach(list, (feed) => Scope.close(feed.scope, Exit.void), { discard: true });

  const take = (predicate: (feed: Feed) => boolean): Feed[] => {
    const out: Feed[] = [];
    for (const [id, feed] of feeds) {
      if (!predicate(feed)) continue;
      feeds.delete(id);
      out.push(feed);
    }
    return out;
  };

  const register = (feed: Feed) =>
    Effect.suspend(() => {
      const evicted = take((f) => f.page.isClosed());
      let own = [...feeds.values()].filter((f) => f.owner === feed.owner);
      while (own.length >= maxPerProfile) {
        const oldest = own[0];
        if (!oldest) break;
        feeds.delete(oldest.id);
        evicted.push(oldest);
        own = own.slice(1);
      }
      while (feeds.size >= maxFeeds) {
        const oldest = feeds.values().next().value;
        if (!oldest) break;
        feeds.delete(oldest.id);
        evicted.push(oldest);
      }
      feeds.set(feed.id, feed);
      return closeFeeds(evicted);
    });

  const sweep = Effect.flatMap(Clock.currentTimeMillis, (now) => closeFeeds(take((f) => f.page.isClosed() || now - f.lastUsedAt >= idleMs)));
  yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(options.sweepIntervalMs ?? SWEEP_INTERVAL_MS), sweep)));

  const pageOf = (feed: Feed, posts: readonly GroupPost[], hasMore: boolean): GroupFeedPage => ({
    sessionId: hasMore ? feed.id : null,
    group: feed.group,
    posts,
    hasMore,
  });

  /** Fetch until there are MIN_NEW_PER_LOAD new posts (at most MAX_FETCHES_PER_LOAD requests). Holding the feed's lock. */
  const fill = Effect.fnUntraced(function* (feed: Feed, fresh: GroupPost[], minNew: number) {
    for (let i = 0; i < MAX_FETCHES_PER_LOAD; i++) {
      const { hasMore } = yield* Ref.get(feed.state);
      if (!hasMore || fresh.length >= minNew || feed.page.isClosed()) break;
      const next = yield* Effect.result(feed.next);
      if (Result.isFailure(next)) {
        // Keep what there is; the next "load more" retries from the last good cursor.
        if (fresh.length > 0) break;
        return yield* feed.page.isClosed() ? feedExpired() : next.failure;
      }
      fresh.push(...next.success);
    }
    const { hasMore } = yield* Ref.updateAndGet(feed.state, (s) => (fresh.length === 0 ? { ...s, hasMore: false } : s));
    return { fresh, hasMore };
  });

  const openNow = Effect.fnUntraced(function* (scope: Scope.Closeable, profile: FbProfile, ref: string) {
    const page = yield* browser.openPage(profile).pipe(Scope.provide(scope));
    const opened = yield* openGroupPage(page, ref);
    const state = yield* Ref.make(initialState(opened));
    const feed: Feed = {
      id: randomUUID(),
      owner: profileKey(profile),
      scope,
      page,
      group: opened.group,
      lock: yield* Semaphore.make(1),
      state,
      next: makePager(page, opened.group.id, state, scrollCaptureMs).next,
      lastUsedAt: yield* Clock.currentTimeMillis,
    };
    // The page embeds one post: fetch the next page right away so the first screen isn't nearly empty.
    const { fresh, hasMore } = yield* fill(feed, [...opened.posts], 4);
    if (hasMore) yield* register(feed);
    return { feed, page: pageOf(feed, fresh, hasMore) };
  });

  const open = Effect.fn('Groups.openFeed')((profile: FbProfile, ref: string) =>
    Effect.acquireUseRelease(
      Scope.fork(layerScope),
      (scope) => Effect.map(openNow(scope, profile, ref), (r) => r.page),
      (scope, exit) => (Exit.isSuccess(exit) && exit.value.sessionId !== null ? Effect.void : Scope.close(scope, Exit.void)),
    ),
  );

  const closeOne = (owner: string, sessionId: string) => closeFeeds(take((f) => f.id === sessionId && f.owner === owner));

  const loadMore = Effect.fn('Groups.loadMore')(function* (profile: FbProfile, sessionId: string) {
    const owner = profileKey(profile);
    const feed = feeds.get(sessionId);
    if (feed?.owner !== owner) return yield* feedExpired();
    if (feed.page.isClosed()) {
      yield* closeOne(owner, sessionId);
      return yield* feedExpired();
    }
    return yield* feed.lock.withPermits(1)(
      Effect.gen(function* () {
        if (feeds.get(sessionId) !== feed) return yield* feedExpired();
        feed.lastUsedAt = yield* Clock.currentTimeMillis;
        // Touch: most recently used goes last.
        feeds.delete(feed.id);
        feeds.set(feed.id, feed);
        const { fresh, hasMore } = yield* fill(feed, [], MIN_NEW_PER_LOAD);
        if (!hasMore) yield* closeOne(owner, sessionId);
        return pageOf(feed, fresh, hasMore);
      }),
    );
  });

  const readLatest = Effect.fn('Groups.readLatest')(function* (
    profile: FbProfile,
    groupId: string,
    readOptions: { readonly maxPages: number; readonly more: (posts: readonly GroupPost[]) => boolean },
  ) {
    return yield* browser.withPage(profile, (page) =>
      Effect.gen(function* () {
        const opened = yield* openGroupPage(page, groupId);
        if (opened.group.id !== groupId) return yield* new AppError({ code: 'NOT_FOUND', message: "Facebook couldn't find that group." });
        const state = yield* Ref.make(initialState(opened));
        const { next } = makePager(page, groupId, state, scrollCaptureMs);
        const posts: GroupPost[] = [...opened.posts];
        let stoppedBy: AppError | null = null;
        for (let i = 0; i < readOptions.maxPages; i++) {
          if (!(yield* Ref.get(state)).hasMore || !readOptions.more(posts)) break;
          const fetched = yield* Effect.result(next);
          if (Result.isFailure(fetched)) {
            // The caller decides whether what was read is enough (see LatestPosts.stoppedBy).
            stoppedBy = fetched.failure;
            break;
          }
          if (fetched.success.length === 0) break;
          posts.push(...fetched.success);
        }
        return { group: opened.group, posts, hasMore: (yield* Ref.get(state)).hasMore, stoppedBy } satisfies LatestPosts;
      }),
    );
  });

  const resolve = Effect.fn('Groups.resolve')((profile: FbProfile, ref: string) =>
    browser.withPage(profile, (page) => Effect.map(openGroupPage(page, ref), (opened) => opened.group)),
  );

  return {
    open,
    loadMore,
    close: (profile: FbProfile, sessionId: string) => closeOne(profileKey(profile), sessionId),
    closeAll: (profile: FbProfile) =>
      Effect.suspend(() => {
        const owner = profileKey(profile);
        return closeFeeds(take((f) => f.owner === owner));
      }),
    readLatest,
    resolve,
    feedCount: (profile?: FbProfile) =>
      Effect.sync(() => (profile === undefined ? feeds.size : [...feeds.values()].filter((f) => f.owner === profileKey(profile)).length)),
  } satisfies GroupFeeds;
});
