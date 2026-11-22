// Group watches: checking a watched group for new posts, recording them, and sending the matches
// to the owner's webhooks.
//
// - checkWatch (one check): read the group's newest posts as the owner's account
//   (Groups.latestPosts), stopping once the feed reaches posts this watch has already seen (two of
//   them: a pinned post can sit on top), at most MAX_CHECK_PAGES requests (three posts each). The
//   first check of a watch records the baseline (one page, nothing is new). Later checks record the
//   posts not seen before; those that match (./keywords.ts) are stored and go to every enabled
//   webhook of the owner (Webhooks.notifyGroupPost). A failed check is recorded on the watch.
// - The real layer starts ONE background fiber (Effect.forkScoped, so runtime disposal stops it):
//   first look ~1 minute after boot, then every 30 s it checks each enabled watch whose own
//   interval has passed since its last check, most overdue first, one at a time, 3-8 s apart,
//   through the BackgroundLane (shared with the Checker, so background Facebook requests never
//   overlap). When Facebook blocks an account's check, that account's watches wait (exponential,
//   15 min up to 6 h). Hourly, old seen rows are pruned. AppConfig.disableChecker turns off the
//   loop and the post-create seeds.
// - "Check now" (checkNow) doesn't take the lane: the user is waiting. A per-watch lock keeps two
//   checks of the same watch from interleaving.
import '@tanstack/react-start/server-only';
import { Cause, Clock, Context, Duration, Effect, FiberSet, Layer, Option, Random, Result } from 'effect';
import { BackgroundLane } from '@/server/checker/BackgroundLane';
import { AppConfig } from '@/server/config';
import { GroupWatchesRepo } from '@/server/db/repositories/GroupWatchesRepo';
import { Groups } from '@/server/groups/Groups';
import { matchPost } from '@/server/groups/keywords';
import { makeKeyedLock } from '@/server/remote-view/keyed-lock';
import { accountOfOwner, accountProfile, type OwnerKey } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import { Webhooks } from '@/server/webhooks/Webhooks';
import type { GroupWatch, GroupWatchCheckResult, GroupWatchId } from '@/shared/domain';
import { AppError } from '@/shared/errors';

/** Most pagination requests one check makes (three posts each), after the page's own post. */
export const MAX_CHECK_PAGES = 6;
/** A check stops once it has met this many posts it saw before. */
const SEEN_TO_STOP = 2;
const MINUTE_MS = 60_000;
const PRUNE_EVERY_MS = 60 * MINUTE_MS;

export interface WatchCycleStats {
  readonly checked: number;
  readonly newPosts: number;
  readonly matches: number;
  readonly errors: number;
}

export interface GroupWatcherShape {
  /** Check the owner's watch now (NOT_FOUND when it isn't theirs). */
  readonly checkNow: (owner: OwnerKey, id: GroupWatchId) => Effect.Effect<GroupWatchCheckResult, AppError>;
  /** Record a new watch's baseline in the background (returns at once; the seed itself never fails). */
  readonly scheduleSeed: (owner: OwnerKey, id: GroupWatchId) => Effect.Effect<void>;
  /** Check every due watch once (the loop's work; exposed for tests). */
  readonly runCycle: Effect.Effect<WatchCycleStats>;
}

/** Pacing of the watch loop. A Reference, so tests can make it instant. */
export interface WatcherTimingShape {
  readonly firstRunDelay: Duration.Duration;
  readonly pollInterval: Duration.Duration;
  readonly minBackoff: Duration.Duration;
  readonly maxBackoff: Duration.Duration;
  /** The gap before every check of a cycle but the first (jittered 3-8 s). */
  readonly pause: Effect.Effect<void>;
}

export const WatcherTiming = Context.Reference<WatcherTimingShape>('faceslop/server/WatcherTiming', {
  defaultValue: () => ({
    firstRunDelay: Duration.minutes(1),
    pollInterval: Duration.seconds(30),
    minBackoff: Duration.minutes(15),
    maxBackoff: Duration.hours(6),
    pause: Effect.flatMap(Random.nextIntBetween(3_000, 8_000), (ms) => Effect.sleep(Duration.millis(ms))),
  }),
});

const watchNotFound = () => new AppError({ code: 'NOT_FOUND', message: 'That group watch no longer exists.' });

const errorOf = (cause: Cause.Cause<AppError>): AppError | null => Option.getOrNull(Cause.findErrorOption(cause));

/** True when the watch is due at `now`. */
export const isDue = (watch: GroupWatch, now: number): boolean =>
  watch.enabled && (watch.lastCheckedAt === null || now >= watch.lastCheckedAt + watch.intervalMinutes * MINUTE_MS);

const make = Effect.gen(function* () {
  const config = yield* AppConfig;
  const groups = yield* Groups;
  const repo = yield* GroupWatchesRepo;
  const webhooks = yield* Webhooks;
  const lane = yield* BackgroundLane;
  const timing = yield* WatcherTiming;
  const locks = makeKeyedLock<GroupWatchId>();
  const seeds = yield* FiberSet.make();
  /** Accounts Facebook blocked: no checks of theirs before `until`. */
  const backoff = new Map<string, { until: number; ms: number }>();

  /** One check of `watch` (holding its lock). */
  const checkWatch = Effect.fnUntraced(function* (owner: OwnerKey, watch: GroupWatch) {
    const userId = accountOfOwner(owner);
    if (userId === null) {
      return yield* new AppError({ code: 'NOT_LOGGED_IN', message: 'Group watches need a Facebook account.' });
    }
    const seen = yield* repo.recentSeenIds(watch.id);
    const latest = yield* groups.latestPosts(accountProfile(userId), watch.groupId, {
      maxPages: watch.seeded ? MAX_CHECK_PAGES : 1,
      more: (posts) => posts.filter((post) => seen.has(post.id)).length < SEEN_TO_STOP,
    });
    const recorded = yield* repo.recordCheck(watch.id, latest.posts, (post) => matchPost(post, watch.keywords, watch.excludeKeywords));
    if (Option.isNone(recorded)) return yield* watchNotFound();
    const current = yield* repo.get(owner, watch.id);
    if (Option.isNone(current)) return yield* watchNotFound();
    // Oldest first, so a webhook receiver sees them in posting order.
    for (const match of [...recorded.value.matches].reverse()) yield* webhooks.notifyGroupPost(owner, current.value, match);
    return { watch: current.value, newPosts: recorded.value.added.length, matches: recorded.value.matches } satisfies GroupWatchCheckResult;
  });

  /** checkWatch under the watch's lock (re-reading it there), with failures recorded on the watch. */
  const checkLocked = (owner: OwnerKey, id: GroupWatchId) =>
    locks.withLock(
      id,
      Effect.gen(function* () {
        const found = yield* repo.get(owner, id);
        if (Option.isNone(found)) return yield* watchNotFound();
        // (A watch deleted meanwhile has no row left to mark.)
        return yield* checkWatch(owner, found.value).pipe(
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.flatMap(Clock.currentTimeMillis, (now) =>
                  repo.markFailed(id, now, errorOf(cause)?.message ?? 'Something went wrong on the faceslop server.'),
                ),
          ),
        );
      }),
    );

  const checkNow = Effect.fn('GroupWatcher.checkNow')((owner: OwnerKey, id: GroupWatchId) => checkLocked(owner, id));

  const seed = Effect.fn('GroupWatcher.seed')(function* (owner: OwnerKey, id: GroupWatchId) {
    const found = yield* repo.get(owner, id);
    if (Option.isNone(found) || found.value.seeded) return;
    yield* checkLocked(owner, id).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning(`[group-watches] couldn't record a baseline for watch ${String(id)}: ${errorOf(cause)?.message ?? Cause.pretty(cause)}`),
      ),
    );
  });

  const scheduleSeed = (owner: OwnerKey, id: GroupWatchId): Effect.Effect<void> =>
    config.disableChecker ? Effect.void : FiberSet.run(seeds, lane.withPermit(seed(owner, id))).pipe(Effect.asVoid);

  const runCycle = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const due = (yield* repo.listAll)
      .filter(({ owner, watch }) => isDue(watch, now) && (backoff.get(owner)?.until ?? 0) <= now)
      .sort((a, b) => (a.watch.lastCheckedAt ?? 0) - (b.watch.lastCheckedAt ?? 0));
    const stats = { checked: 0, newPosts: 0, matches: 0, errors: 0 };
    const blocked = new Set<OwnerKey>();
    for (const { owner, watch } of due) {
      if (blocked.has(owner)) continue;
      if (stats.checked + stats.errors > 0) yield* timing.pause;
      const result = yield* Effect.result(lane.withPermit(checkLocked(owner, watch.id)));
      if (Result.isSuccess(result)) {
        stats.checked++;
        stats.newPosts += result.success.newPosts;
        stats.matches += result.success.matches.length;
        backoff.delete(owner);
        continue;
      }
      stats.errors++;
      const error = result.failure;
      if (error.code === 'FB_BLOCKED') {
        blocked.add(owner);
        const ended = yield* Clock.currentTimeMillis;
        const previous = backoff.get(owner)?.ms ?? 0;
        const ms = Math.min(Math.max(previous * 2, Duration.toMillis(timing.minBackoff)), Duration.toMillis(timing.maxBackoff));
        backoff.set(owner, { until: ended + ms, ms });
        yield* Effect.logWarning(`[group-watches] Facebook blocked a group check; that account's watches wait ${String(Math.round(ms / MINUTE_MS))} min.`);
      } else if (error.code !== 'NOT_LOGGED_IN') {
        yield* Effect.logWarning(`[group-watches] watch ${String(watch.id)}: ${error.message}`);
      }
    }
    if (due.length > 0) {
      yield* Effect.logInfo(
        `[group-watches] checked ${String(stats.checked)} of ${String(due.length)} due watch(es): ${String(stats.newPosts)} new post(s), ${String(stats.matches)} match(es)${stats.errors > 0 ? `, ${String(stats.errors)} error(s)` : ''}`,
      );
    }
    return stats satisfies WatchCycleStats;
  }).pipe(Effect.withSpan('GroupWatcher.runCycle'));

  const loop = Effect.gen(function* () {
    yield* Effect.sleep(timing.firstRunDelay);
    let lastPrune = 0;
    for (;;) {
      yield* Effect.gen(function* () {
        yield* runCycle;
        const now = yield* Clock.currentTimeMillis;
        if (now - lastPrune >= PRUNE_EVERY_MS) {
          lastPrune = now;
          yield* repo.prune(now);
        }
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logError(`[group-watches] check failed:\n${Cause.pretty(cause)}`),
        ),
      );
      yield* Effect.sleep(timing.pollInterval);
    }
  });

  if (!config.disableChecker) yield* Effect.forkScoped(loop);

  return GroupWatcher.of({ checkNow, scheduleSeed, runCycle });
});

export class GroupWatcher extends Context.Service<GroupWatcher, GroupWatcherShape>()('faceslop/server/GroupWatcher') {
  static readonly layerStub = Layer.succeed(
    GroupWatcher,
    GroupWatcher.of({
      checkNow: () => notImplemented('GroupWatcher.checkNow'),
      scheduleSeed: () => notImplemented('GroupWatcher.scheduleSeed'),
      runCycle: notImplemented('GroupWatcher.runCycle'),
    }),
  );

  /** Needs Groups, GroupWatchesRepo, Webhooks, BackgroundLane and AppConfig (tests provide their own). */
  static readonly layerNoDeps = Layer.effect(GroupWatcher, make);

  /** The layer the app runs: starts the watch loop unless AppConfig.disableChecker. */
  static readonly layer = GroupWatcher.layerNoDeps.pipe(
    Layer.provide([Groups.layer, GroupWatchesRepo.layer, Webhooks.layer, BackgroundLane.layer, AppConfig.layer]),
  );
}
