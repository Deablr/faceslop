// Reading Facebook groups: the account's groups, a group's newest posts with "load more"
// sessions, one post with its comments, and the one-shot "what's new" read the group watcher uses.
//
// Groups are always read as an ACCOUNT (private groups only show to members): every method fails
// with NOT_LOGGED_IN for the anonymous profile or an account without a saved Facebook session
// (Browser would otherwise quietly serve it logged out). Pages come from that account's hidden
// context. The parts:
//   feed.ts      the group page, pagination (capture + replay of Facebook's own request), sessions
//   extract.ts, conform.ts, urls.ts   pure (no Playwright), unit-tested against test/fixtures/group-*
//
// Caches (per account; failures are never cached): the groups list for JOINED_GROUPS_TTL, posts for
// POST_CACHE_TTL. Errors: FB_BLOCKED, FB_PARSE_FAILED, FB_TIMEOUT, NOT_FOUND (no such group or
// post), FORBIDDEN (not a member), SESSION_EXPIRED (loadMore on a gone feed), NOT_LOGGED_IN.
import '@tanstack/react-start/server-only';
import { Cache, Context, Duration, Effect, Equal, Exit, Hash, Layer } from 'effect';
import { Browser, type BrowserShape } from '@/server/browser/Browser';
import { extractGroupPostDetail, extractJoinedGroups } from '@/server/groups/extract';
import { makeGroupFeeds, type GroupFeedOptions, type LatestPosts } from '@/server/groups/feed';
import { groupPostUrl, JOINED_GROUPS_URL } from '@/server/groups/urls';
import { extractErrorRoute } from '@/server/marketplace/extract';
import { loadFacebookPage, looksLikeLoginWall } from '@/server/marketplace/fb-page';
import { profileKey, type FbProfile } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import type { GroupFeedPage, GroupInfo, GroupPost, GroupPostDetail, GroupSummary } from '@/shared/domain';
import { AppError } from '@/shared/errors';

export const JOINED_GROUPS_TTL = Duration.minutes(10);
export const POST_CACHE_TTL = Duration.minutes(2);
const POST_CACHE_MAX = 100;

export interface GroupsShape {
  /** The account's groups, most recently active first (cached briefly). */
  readonly joinedGroups: (profile: FbProfile) => Effect.Effect<readonly GroupSummary[], AppError>;
  /** Which group a pasted id or vanity name is (loads its page). FORBIDDEN when the account can't see its posts. */
  readonly resolveGroup: (profile: FbProfile, ref: string) => Effect.Effect<GroupInfo, AppError>;
  /** A group's newest posts; keeps the page open as a session (owned by `profile`) when there are more. */
  readonly feed: (profile: FbProfile, groupId: string) => Effect.Effect<GroupFeedPage, AppError>;
  /** The next posts of a feed session. SESSION_EXPIRED when it's gone or another profile's. */
  readonly loadMore: (profile: FbProfile, sessionId: string) => Effect.Effect<GroupFeedPage, AppError>;
  readonly closeFeed: (profile: FbProfile, sessionId: string) => Effect.Effect<void>;
  readonly closeAllFeeds: (profile: FbProfile) => Effect.Effect<void>;
  /** One post with its first comments (cached briefly). NOT_FOUND when it's gone. */
  readonly getPost: (profile: FbProfile, groupId: string, postId: string) => Effect.Effect<GroupPostDetail, AppError>;
  /**
   * Background checks: the newest posts in a one-shot page, reading further pages (three posts
   * each, at most `maxPages`) while `more(postsSoFar)` says so. Keeps no session.
   */
  readonly latestPosts: (
    profile: FbProfile,
    groupId: string,
    options: { readonly maxPages: number; readonly more: (posts: readonly GroupPost[]) => boolean },
  ) => Effect.Effect<LatestPosts, AppError>;
}

const notLoggedIn = () => new AppError({ code: 'NOT_LOGGED_IN', message: 'Connect your Facebook account first: groups are read as you.' });
const postGone = () => new AppError({ code: 'NOT_FOUND', message: 'This post is no longer available on Facebook.' });

class PostKey implements Equal.Equal {
  readonly owner: string;
  constructor(
    readonly profile: FbProfile,
    readonly groupId: string,
    readonly postId: string,
  ) {
    this.owner = profileKey(profile);
  }
  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof PostKey && that.owner === this.owner && that.groupId === this.groupId && that.postId === this.postId;
  }
  [Hash.symbol](): number {
    return Hash.string(`${this.owner}/${this.groupId}/${this.postId}`);
  }
}

class AccountKey implements Equal.Equal {
  readonly owner: string;
  constructor(readonly profile: FbProfile) {
    this.owner = profileKey(profile);
  }
  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof AccountKey && that.owner === this.owner;
  }
  [Hash.symbol](): number {
    return Hash.string(this.owner);
  }
}

const NUMERIC_ID = /^\d{1,25}$/;
const badId = (what: string) => new AppError({ code: 'BAD_REQUEST', message: `${what} must be numeric.` });

export const makeGroups = Effect.fn('Groups.make')(function* (browser: BrowserShape, options: GroupFeedOptions = {}) {
  const feeds = yield* makeGroupFeeds(browser, options);

  /** Fails unless `profile` is an account with a saved Facebook session. */
  const asAccount = (profile: FbProfile) =>
    profile.kind === 'account'
      ? Effect.flatMap(browser.hasSession(profile.userId), (has) => (has ? Effect.void : Effect.fail(notLoggedIn())))
      : Effect.fail(notLoggedIn());

  const fetchJoined = ({ profile }: AccountKey) =>
    browser.withPage(profile, (page) =>
      Effect.gen(function* () {
        const { html, blobs } = yield* loadFacebookPage(page, JOINED_GROUPS_URL);
        const groups = extractJoinedGroups(blobs);
        if (groups.length === 0 && looksLikeLoginWall(html)) {
          return yield* new AppError({ code: 'FB_BLOCKED', message: 'Facebook is asking to log in again before showing groups.' });
        }
        return groups;
      }),
    );
  const joinedCache = yield* Cache.makeWith(fetchJoined, {
    capacity: 50,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? JOINED_GROUPS_TTL : Duration.zero),
  });

  const fetchPost = ({ profile, groupId, postId }: PostKey) =>
    browser.withPage(profile, (page) =>
      Effect.gen(function* () {
        const { html, blobs } = yield* loadFacebookPage(page, groupPostUrl(groupId, postId), postGone);
        const detail = extractGroupPostDetail(blobs, groupId, postId);
        if (detail) return detail;
        if (looksLikeLoginWall(html)) {
          return yield* new AppError({ code: 'FB_BLOCKED', message: 'Facebook is asking to log in again before showing this post.' });
        }
        // Removed posts render Facebook's "This content isn't available" route (or another post).
        if (extractErrorRoute(blobs) !== null || !html.includes(postId)) return yield* postGone();
        return yield* new AppError({ code: 'FB_PARSE_FAILED', message: "The post's page loaded, but the post couldn't be read." });
      }),
    );
  const postCache = yield* Cache.makeWith(fetchPost, {
    capacity: POST_CACHE_MAX,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? POST_CACHE_TTL : Duration.zero),
  });

  const joinedGroups = Effect.fn('Groups.joinedGroups')(function* (profile: FbProfile) {
    yield* asAccount(profile);
    return structuredClone(yield* Cache.get(joinedCache, new AccountKey(profile)));
  });

  const resolveGroup = Effect.fn('Groups.resolveGroup')(function* (profile: FbProfile, ref: string) {
    yield* asAccount(profile);
    return yield* feeds.resolve(profile, ref.trim());
  });

  const feed = Effect.fn('Groups.feed')(function* (profile: FbProfile, groupId: string) {
    if (!NUMERIC_ID.test(groupId)) return yield* badId('Group id');
    yield* asAccount(profile);
    return yield* feeds.open(profile, groupId);
  });

  const loadMore = Effect.fn('Groups.loadMore')(function* (profile: FbProfile, sessionId: string) {
    yield* asAccount(profile);
    return yield* feeds.loadMore(profile, sessionId);
  });

  const getPost = Effect.fn('Groups.getPost')(function* (profile: FbProfile, groupId: string, postId: string) {
    if (!NUMERIC_ID.test(groupId)) return yield* badId('Group id');
    if (!NUMERIC_ID.test(postId)) return yield* badId('Post id');
    yield* asAccount(profile);
    return structuredClone(yield* Cache.get(postCache, new PostKey(profile, groupId, postId)));
  });

  const latestPosts = Effect.fn('Groups.latestPosts')(function* (
    profile: FbProfile,
    groupId: string,
    readOptions: { readonly maxPages: number; readonly more: (posts: readonly GroupPost[]) => boolean },
  ) {
    if (!NUMERIC_ID.test(groupId)) return yield* badId('Group id');
    yield* asAccount(profile);
    return yield* feeds.readLatest(profile, groupId, readOptions);
  });

  return Groups.of({
    joinedGroups,
    resolveGroup,
    feed,
    loadMore,
    closeFeed: feeds.close,
    closeAllFeeds: feeds.closeAll,
    getPost,
    latestPosts,
  });
});

export class Groups extends Context.Service<Groups, GroupsShape>()('faceslop/server/Groups') {
  static readonly layerStub = Layer.succeed(
    Groups,
    Groups.of({
      joinedGroups: () => notImplemented('Groups.joinedGroups'),
      resolveGroup: () => notImplemented('Groups.resolveGroup'),
      feed: () => notImplemented('Groups.feed'),
      loadMore: () => notImplemented('Groups.loadMore'),
      closeFeed: () => notImplemented('Groups.closeFeed'),
      closeAllFeeds: () => notImplemented('Groups.closeAllFeeds'),
      getPost: () => notImplemented('Groups.getPost'),
      latestPosts: () => notImplemented('Groups.latestPosts'),
    }),
  );

  /** Requires Browser (tests provide their own). */
  static readonly layerNoDeps = Layer.effect(Groups, Effect.flatMap(Browser, (browser) => makeGroups(browser)));

  /** The layer the app runs (Browser is shared: layers are memoized by reference). */
  static readonly layer = Groups.layerNoDeps.pipe(Layer.provide(Browser.layer));
}
