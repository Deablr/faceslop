// Group watches end to end below Facebook: the GroupWatcher over a fake Groups service, the real
// repositories (in-memory SQLite), and the real Webhooks service over a fake transport. Time only
// passes when a test adjusts the TestClock.
import { describe, expect, it } from '@effect/vitest';
import { Clock, Duration, Effect, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { BackgroundLane } from '@/server/checker/BackgroundLane';
import { AppConfig } from '@/server/config';
import { RepositoriesLayerMemory } from '@/server/db/layers';
import { GroupWatchesRepo } from '@/server/db/repositories/GroupWatchesRepo';
import { WebhooksRepo } from '@/server/db/repositories/WebhooksRepo';
import { Groups } from '@/server/groups/Groups';
import { GroupWatcher, MAX_CHECK_PAGES, WatcherTiming, isDue } from '@/server/groups/GroupWatcher';
import { containsKeyword, foldText, matchPost } from '@/server/groups/keywords';
import { accountOwner, profileKey, type FbUserId } from '@/server/session/identity';
import { WebhookTiming, WebhookTransport, Webhooks, signWebhook, type WebhookRequest } from '@/server/webhooks/Webhooks';
import type { GroupPost, GroupPostWebhookPayload, GroupWatch, GroupWatchInput } from '@/shared/domain';
import { AppError } from '@/shared/errors';

const ALICE = '1001' as FbUserId;
const A = accountOwner(ALICE);
const BOB = '2002' as FbUserId;
const B = accountOwner(BOB);
const GROUP = '1000000000000001';
const MINUTE = 60_000;

const post = (id: string, text: string): GroupPost => ({
  id,
  groupId: GROUP,
  groupName: 'Test Puppy Group',
  author: { id: '77', name: 'Person 1', url: 'https://www.facebook.com/person.1', imageUrl: null },
  text,
  createdAt: 1_795_000_000_000,
  images: ['https://scontent.xx.fbcdn.net/v/photo_1.jpg'],
  hasVideo: false,
  commentCount: 0,
  url: `https://www.facebook.com/groups/${GROUP}/posts/${id}/`,
});

/** The group feed the fake Groups serves (newest first), and what it was asked. */
interface FeedScript {
  feed: GroupPost[];
  failWith: AppError | null;
  readonly calls: { readonly profile: string; readonly groupId: string; readonly maxPages: number; readonly returned: number }[];
}

/** Serves `feed` the way latestPosts reads it: the page's post, then three per page while `more` asks. */
const fakeGroups = (script: FeedScript) =>
  Layer.succeed(
    Groups,
    Groups.of({
      joinedGroups: () => Effect.die('unused'),
      resolveGroup: () => Effect.die('unused'),
      feed: () => Effect.die('background checks must not open feeds'),
      loadMore: () => Effect.die('unused'),
      closeFeed: () => Effect.void,
      closeAllFeeds: () => Effect.void,
      getPost: () => Effect.die('unused'),
      latestPosts: (profile, groupId, options) =>
        Effect.suspend(() => {
          if (script.failWith) return Effect.fail(script.failWith);
          const posts = script.feed.slice(0, 1);
          for (let page = 0; page < options.maxPages && posts.length < script.feed.length && options.more(posts); page++) {
            posts.push(...script.feed.slice(posts.length, posts.length + 3));
          }
          script.calls.push({ profile: profileKey(profile), groupId, maxPages: options.maxPages, returned: posts.length });
          return Effect.succeed({ group: { id: groupId, name: 'Test Puppy Group' }, posts, hasMore: posts.length < script.feed.length });
        }),
    }),
  );

interface Sent {
  readonly requests: WebhookRequest[];
  statuses: number[];
}

const fakeTransport = (sent: Sent, addresses: readonly string[] = ['192.168.1.20']) =>
  Layer.succeed(WebhookTransport, {
    resolve: () => Effect.succeed(addresses),
    post: (request) =>
      Effect.sync(() => {
        sent.requests.push(request);
        return sent.statuses.shift() ?? 200;
      }),
  });

const watcherLayer = (script: FeedScript, sent: Sent, addresses?: readonly string[]) =>
  GroupWatcher.layerNoDeps.pipe(
    Layer.provideMerge(Webhooks.layerNoDeps),
    Layer.provideMerge(RepositoriesLayerMemory),
    Layer.provide(fakeGroups(script)),
    Layer.provide(fakeTransport(sent, addresses)),
    // Deliveries are sent by the tests (deliverDue), not by the loop when the TestClock moves.
    Layer.provide(Layer.succeed(WebhookTiming, { pollInterval: Duration.days(365) })),
    Layer.provide(BackgroundLane.layer),
    Layer.provide(AppConfig.layerTest({ dataDir: '/nonexistent/faceslop-test' })),
    Layer.provide(
      Layer.succeed(WatcherTiming, {
        firstRunDelay: Duration.minutes(1),
        pollInterval: Duration.seconds(30),
        minBackoff: Duration.minutes(15),
        maxBackoff: Duration.hours(6),
        pause: Effect.void,
      }),
    ),
  );

const makeScript = (feed: GroupPost[] = []): FeedScript => ({ feed, failWith: null, calls: [] });
const makeSent = (): Sent => ({ requests: [], statuses: [] });

const input = (overrides: Partial<GroupWatchInput> = {}): GroupWatchInput => ({
  groupId: GROUP,
  groupName: 'Test Puppy Group',
  keywords: [],
  excludeKeywords: [],
  intervalMinutes: 15,
  enabled: true,
  ...overrides,
});

const createWatch = (overrides: Partial<GroupWatchInput> = {}, owner = A) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Effect.flatMap(GroupWatchesRepo.use((repo) => repo.create(owner, input(overrides), now)), (created) =>
      Effect.sync(() => Option.getOrThrow(created)),
    ),
  );

const createWebhook = (owner = A, url = 'https://hooks.example/puppies') =>
  Effect.flatMap(Clock.currentTimeMillis, (now) => WebhooksRepo.use((repo) => repo.create(owner, { name: 'Phone', url, enabled: true }, now)));

const checkNow = (watch: GroupWatch, owner = A) => GroupWatcher.use((watcher) => watcher.checkNow(owner, watch.id));
const deliverDue = Webhooks.use((webhooks) => webhooks.deliverDue);

describe('keywords', () => {
  it('match the start of a word, ignoring case and accents', () => {
    const text = foldText('GOLDENDOODLE puppies, Crème colored! Lab mix available');
    expect(containsKeyword(text, 'golden')).toBe(true);
    expect(containsKeyword(text, 'creme')).toBe(true);
    expect(containsKeyword(text, 'lab')).toBe(true);
    expect(containsKeyword(text, 'doodle')).toBe(false); // inside a word
    expect(containsKeyword(text, 'able')).toBe(false);
    expect(containsKeyword(text, 'lab mix')).toBe(true);
    expect(containsKeyword(text, '  ')).toBe(false);
    expect(containsKeyword(foldText('price $500 (firm)'), '$500')).toBe(true);
  });

  it('report the matched keywords; excluded ones win; no keywords match everything', () => {
    expect(matchPost({ text: 'Golden retriever pups' }, ['golden', 'corgi'], [])).toEqual(['golden']);
    expect(matchPost({ text: 'Corgi pups' }, ['golden'], [])).toBeNull();
    expect(matchPost({ text: 'ISO golden retriever' }, ['golden'], ['iso'])).toBeNull();
    expect(matchPost({ text: '' }, [], [])).toEqual([]);
    expect(matchPost({ text: 'Looking for a pup' }, [], ['looking for'])).toBeNull();
  });
});

describe('isDue', () => {
  const watch = { enabled: true, lastCheckedAt: 1000, intervalMinutes: 15 } as GroupWatch;
  it('is due once its interval has passed, and never when disabled', () => {
    expect(isDue({ ...watch, lastCheckedAt: null }, 0)).toBe(true);
    expect(isDue(watch, 1000 + 15 * MINUTE - 1)).toBe(false);
    expect(isDue(watch, 1000 + 15 * MINUTE)).toBe(true);
    expect(isDue({ ...watch, enabled: false }, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

describe('checkNow', () => {
  it.effect('the first check records the baseline: nothing is new, nothing is sent', () => {
    const script = makeScript([post('3', 'Golden pups'), post('2', 'Corgi'), post('1', 'Pugs')]);
    const sent = makeSent();
    return Effect.gen(function* () {
      yield* TestClock.setTime(10_000);
      yield* createWebhook();
      const watch = yield* createWatch({ keywords: ['golden'] });
      const result = yield* checkNow(watch);
      expect(result.newPosts).toBe(0);
      expect(result.matches).toEqual([]);
      expect(result.watch).toMatchObject({ seeded: true, lastCheckedAt: 10_000, lastError: null, newMatchCount: 0 });
      // The baseline reads one page only, as Alice.
      expect(script.calls).toEqual([{ profile: A, groupId: GROUP, maxPages: 1, returned: 3 }]);
      expect(yield* deliverDue).toBe(0);
      expect(sent.requests).toEqual([]);
    }).pipe(Effect.provide(watcherLayer(script, sent)));
  });

  it.effect('later checks record new posts, store the matches, and send each match to every enabled webhook, signed', () => {
    const script = makeScript([post('2', 'Corgi'), post('1', 'Pugs')]);
    const sent = makeSent();
    return Effect.gen(function* () {
      yield* TestClock.setTime(10_000);
      const hook = yield* createWebhook();
      yield* WebhooksRepo.use((repo) => repo.create(A, { name: 'Off', url: 'https://hooks.example/off', enabled: false }, 1));
      yield* createWebhook(B, 'https://hooks.example/bob'); // Bob's webhook never hears about Alice's watch
      const watch = yield* createWatch({ keywords: ['golden', 'doodle'], excludeKeywords: ['iso'] });
      yield* checkNow(watch);

      script.feed = [post('6', 'Mini goldendoodle litter'), post('5', 'ISO golden retriever'), post('4', 'Beagles'), post('3', 'Doodle pups'), ...script.feed];
      yield* TestClock.setTime(20_000);
      const result = yield* checkNow(watch);
      expect(result.newPosts).toBe(4);
      expect(result.matches.map((m) => [m.post.id, m.matchedKeywords])).toEqual([
        ['6', ['golden']],
        ['3', ['doodle']],
      ]);
      expect(result.watch.newMatchCount).toBe(2);
      expect(script.calls[1]?.maxPages).toBe(MAX_CHECK_PAGES);

      expect(yield* deliverDue).toBe(2);
      expect(sent.requests.map((r) => r.url)).toEqual(['https://hooks.example/puppies', 'https://hooks.example/puppies']);
      // Oldest match first.
      const bodies = sent.requests.map((r) => JSON.parse(r.body) as GroupPostWebhookPayload);
      expect(bodies.map((b) => b.post.id)).toEqual(['3', '6']);
      const [first] = sent.requests;
      const body = bodies[0];
      expect(body).toMatchObject({
        version: 1,
        event: 'group.post',
        watch: { id: watch.id, groupId: GROUP, groupName: 'Test Puppy Group', matchedKeywords: ['doodle'] },
        post: { id: '3', text: 'Doodle pups', url: `https://www.facebook.com/groups/${GROUP}/posts/3/`, author: { name: 'Person 1' } },
      });
      expect(first?.headers['x-faceslop-event']).toBe('group.post');
      expect(first?.headers['x-faceslop-delivery']).toBe(body?.deliveryId);
      const timestamp = Number(first?.headers['x-faceslop-timestamp']);
      expect(first?.headers['x-faceslop-signature']).toBe(signWebhook(hook.secret, timestamp, first?.body ?? ''));

      // Delivered: nothing more to send; the log says so.
      expect(yield* deliverDue).toBe(0);
      const log = yield* WebhooksRepo.use((repo) => repo.deliveries(A, hook.id, 10));
      expect(log.map((d) => d.status)).toEqual(['delivered', 'delivered']);
      expect(log[0]?.summary).toContain('Test Puppy Group');

      // Matches are listed newest first, and viewing them clears the count...
      const matches = yield* GroupWatchesRepo.use((repo) => repo.matches(A, watch.id, 10));
      expect(matches.map((m) => m.post.id).sort()).toEqual(['3', '6']);
      const shownUpTo = matches[0]?.matchedAt ?? 0;
      // ...but only up to what was shown: a match found meanwhile stays new.
      script.feed = [post('7', 'Golden pups, 2 left'), ...script.feed];
      yield* TestClock.setTime(30_000);
      yield* checkNow(watch);
      expect(yield* GroupWatchesRepo.use((repo) => repo.viewMatches(A, watch.id, shownUpTo))).toBe(true);
      expect(Option.getOrThrow(yield* GroupWatchesRepo.use((repo) => repo.get(A, watch.id))).newMatchCount).toBe(1);
      expect(yield* GroupWatchesRepo.use((repo) => repo.viewMatches(B, watch.id, 30_000))).toBe(false);
    }).pipe(Effect.provide(watcherLayer(script, sent)));
  });

  it.effect('stops reading once it meets posts it has seen', () => {
    const older = Array.from({ length: 12 }, (_, i) => post(String(100 - i), 'old'));
    const script = makeScript(older);
    const sent = makeSent();
    return Effect.gen(function* () {
      const watch = yield* createWatch();
      yield* checkNow(watch); // baseline: the first 4 (page + one page of three)
      script.feed = [post('200', 'new'), ...older];
      const result = yield* checkNow(watch);
      expect(result.newPosts).toBe(1);
      // The page's post + one page: it already contains two seen posts.
      expect(script.calls[1]?.returned).toBe(4);
    }).pipe(Effect.provide(watcherLayer(script, sent)));
  });

  it.effect('a burst of new posts bigger than one check can read is flagged on the watch', () => {
    const script = makeScript([post('1', 'old'), post('2', 'old')]);
    const sent = makeSent();
    return Effect.gen(function* () {
      const watch = yield* createWatch();
      yield* checkNow(watch);
      const burst = Array.from({ length: 3 * MAX_CHECK_PAGES + 10 }, (_, i) => post(String(1000 - i), 'new'));
      script.feed = [...burst, ...script.feed];
      const result = yield* checkNow(watch);
      expect(result.newPosts).toBe(1 + 3 * MAX_CHECK_PAGES);
      expect(result.watch.lastError).toContain('More new posts than one check reads');
      // The next check catches up with the rest and clears it.
      expect((yield* checkNow(watch)).watch.lastError).toBeNull();
    }).pipe(Effect.provide(watcherLayer(script, sent)));
  });

  it.effect('a failed check is recorded on the watch, and the next good one clears it', () => {
    const script = makeScript([post('1', 'Pugs')]);
    const sent = makeSent();
    return Effect.gen(function* () {
      const watch = yield* createWatch();
      script.failWith = new AppError({ code: 'FB_TIMEOUT', message: 'Facebook took too long to respond.' });
      const failed = yield* Effect.flip(checkNow(watch));
      expect(failed.code).toBe('FB_TIMEOUT');
      const after = Option.getOrThrow(yield* GroupWatchesRepo.use((repo) => repo.get(A, watch.id)));
      expect(after).toMatchObject({ lastError: 'Facebook took too long to respond.', seeded: false });
      script.failWith = null;
      expect((yield* checkNow(watch)).watch.lastError).toBeNull();
    }).pipe(Effect.provide(watcherLayer(script, sent)));
  });

  it.effect("another owner's watch is not found", () => {
    const script = makeScript();
    const sent = makeSent();
    return Effect.gen(function* () {
      const watch = yield* createWatch();
      expect((yield* Effect.flip(checkNow(watch, B))).code).toBe('NOT_FOUND');
      expect(script.calls).toEqual([]);
    }).pipe(Effect.provide(watcherLayer(script, sent)));
  });
});

describe('GroupWatchesRepo', () => {
  it.effect('records nothing when queueing the matches fails (one transaction)', () =>
    Effect.gen(function* () {
      const watch = yield* createWatch();
      const repo = yield* GroupWatchesRepo;
      yield* repo.recordCheck(watch.id, [post('1', 'a')], () => null, () => Effect.void); // baseline
      const exit = yield* Effect.exit(repo.recordCheck(watch.id, [post('2', 'b')], () => [], () => Effect.die('queue failed')));
      expect(exit._tag).toBe('Failure');
      expect([...(yield* repo.recentSeenIds(watch.id))]).toEqual(['1']);
      expect((yield* repo.matches(A, watch.id, 10)).length).toBe(0);
    }).pipe(Effect.provide(watcherLayer(makeScript(), makeSent()))),
  );

  it.effect('pruning keeps seen posts for 180 days and turns old matches into plain seen rows', () =>
    Effect.gen(function* () {
      const watch = yield* createWatch();
      const repo = yield* GroupWatchesRepo;
      yield* TestClock.setTime(1);
      yield* repo.recordCheck(watch.id, [post('1', 'a')], () => null, () => Effect.void);
      const many = Array.from({ length: 205 }, (_, i) => post(String(100 + i), 'x'));
      yield* TestClock.setTime(2);
      yield* repo.recordCheck(watch.id, many, () => [], () => Effect.void);
      yield* repo.prune(100 * 24 * 60 * MINUTE);
      expect((yield* repo.matches(A, watch.id, 1000)).length).toBe(200);
      // Demoted, not forgotten: still seen, so never "new" again.
      expect((yield* repo.recentSeenIds(watch.id)).size).toBe(206);
      yield* repo.prune(181 * 24 * 60 * MINUTE);
      expect((yield* repo.recentSeenIds(watch.id)).size).toBe(0);
    }).pipe(Effect.provide(watcherLayer(makeScript(), makeSent()))),
  );
});

describe('runCycle', () => {
  it.effect('checks enabled watches whose interval has passed, as their own accounts', () => {
    const script = makeScript([post('1', 'Pugs')]);
    const sent = makeSent();
    return Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const alices = yield* createWatch();
      yield* createWatch({ groupId: '42', enabled: false });
      yield* createWatch({}, B);
      const runCycle = GroupWatcher.use((watcher) => watcher.runCycle);
      expect(yield* runCycle).toMatchObject({ checked: 2, errors: 0 });
      expect(script.calls.map((c) => c.profile).sort()).toEqual([A, B].sort());
      // Nothing is due again before the interval.
      yield* TestClock.setTime(14 * MINUTE);
      expect((yield* runCycle).checked).toBe(0);
      yield* TestClock.setTime(16 * MINUTE);
      expect((yield* runCycle).checked).toBe(2);
      expect(Option.getOrThrow(yield* GroupWatchesRepo.use((repo) => repo.get(A, alices.id))).lastCheckedAt).toBe(16 * MINUTE);
    }).pipe(Effect.provide(watcherLayer(script, sent)));
  });

  it.effect("backs off an account Facebook blocked, without stopping other accounts' watches", () => {
    const script = makeScript([post('1', 'Pugs')]);
    const sent = makeSent();
    return Effect.gen(function* () {
      yield* TestClock.setTime(0);
      yield* createWatch();
      yield* createWatch({ groupId: '42' });
      script.failWith = new AppError({ code: 'FB_BLOCKED', message: 'checkpoint' });
      const runCycle = GroupWatcher.use((watcher) => watcher.runCycle);
      // Alice's first watch is blocked; her second is skipped this cycle.
      expect(yield* runCycle).toMatchObject({ checked: 0, errors: 1 });
      script.failWith = null;
      // Her watches' interval (15 min) has passed, but the backoff (15 min after the block) hasn't... yet.
      yield* TestClock.setTime(15 * MINUTE - 1);
      expect((yield* runCycle).checked).toBe(0);
      yield* TestClock.setTime(16 * MINUTE);
      expect((yield* runCycle).checked).toBe(2);
    }).pipe(Effect.provide(watcherLayer(script, sent)));
  });
});

describe('webhook deliveries', () => {
  it.effect('retry server errors with backoff, and give up on client errors', () => {
    const script = makeScript([post('1', 'old')]);
    const sent = makeSent();
    return Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const hook = yield* createWebhook();
      const watch = yield* createWatch();
      yield* checkNow(watch);
      script.feed = [post('3', 'a'), post('2', 'b'), ...script.feed];
      yield* checkNow(watch);
      sent.statuses = [503, 404];
      expect(yield* deliverDue).toBe(2);
      const log = () => WebhooksRepo.use((repo) => repo.deliveries(A, hook.id, 10));
      const byStatus = (yield* log()).map((d) => [d.status, d.httpStatus, d.attempts]);
      expect(byStatus).toEqual(expect.arrayContaining([['pending', 503, 1], ['failed', 404, 1]]));
      // Not due again until a minute later.
      expect(yield* deliverDue).toBe(0);
      yield* TestClock.setTime(MINUTE);
      expect(yield* deliverDue).toBe(1);
      expect((yield* log()).filter((d) => d.status === 'delivered')).toHaveLength(1);
    }).pipe(Effect.provide(watcherLayer(script, sent)));
  });

  it.effect('"Send test" posts a signed test event now, even to a turned-off webhook, and never retries', () => {
    const sent = makeSent();
    return Effect.gen(function* () {
      const hook = yield* createWebhook();
      yield* WebhooksRepo.use((repo) => repo.update(A, hook.id, { enabled: false }));
      const ok = yield* Webhooks.use((webhooks) => webhooks.sendTest(A, hook.id));
      expect(ok).toEqual({ ok: true, httpStatus: 200, error: null });
      expect(sent.requests[0]?.headers['x-faceslop-event']).toBe('test');
      sent.statuses = [500];
      const failed = yield* Webhooks.use((webhooks) => webhooks.sendTest(A, hook.id));
      expect(failed).toMatchObject({ ok: false, httpStatus: 500 });
      expect(yield* deliverDue).toBe(0);
      expect((yield* Effect.flip(Webhooks.use((webhooks) => webhooks.sendTest(B, hook.id)))).code).toBe('NOT_FOUND');
    }).pipe(Effect.provide(watcherLayer(makeScript(), sent)));
  });

  it.effect('refuse link-local targets (cloud metadata)', () => {
    const sent = makeSent();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Webhooks.use((webhooks) => webhooks.checkTarget('http://169.254.169.254/latest/meta-data')));
      expect(error).toMatchObject({ code: 'BAD_REQUEST' });
      const hook = yield* createWebhook();
      const result = yield* Webhooks.use((webhooks) => webhooks.sendTest(A, hook.id));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not allowed');
      expect(sent.requests).toEqual([]);
    }).pipe(Effect.provide(watcherLayer(makeScript(), sent, ['169.254.169.254'])));
  });
});
