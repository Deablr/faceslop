// Background checker + saved-search runs. OWNER: server builder.
//
// Port of legacy/src/server/jobs/{checker,saved-search-check}.ts, per owner (see
// src/server/session/identity.ts):
// - checkSavedSearch: one run of an owner's saved search (first page only, recorded into
//   saved_search_seen), as that owner's Facebook profile; shared by the "run now" server function,
//   the post-create seed, and the background loop. The stored params are searched as they are (no
//   default location: see src/server/filters.ts). It uses Marketplace.searchFirstPage, so no search
//   session is kept (background work must not evict the pages people are paging through).
// - The real layer starts ONE sequential, non-overlapping background fiber (Effect.forkScoped in
//   the layer, so runtime disposal stops it): first cycle ~1 minute after boot, wakes every 30s.
//   Each wake-up looks at the ACTIVE owners (a browser of theirs was used, unlocked, in the last
//   30 days: ClientSessionsRepo.activeOwners) and re-reads each one's Settings.checkIntervalMinutes
//   (0 = off for that owner); an owner is due when its own interval has passed since its last
//   cycle (kept in memory, so everyone is due again after a restart). A cycle covers every due
//   owner: their auto-check saved searches, then their favorites (price/status; NOT_FOUND =>
//   sold), each listing fetched once however many owners saved it, then merged into each due
//   owner's OWN stored copy (stored copies come from that owner's browser, so one owner's copy is
//   never written into another's). 3-8s jittered gaps between Facebook calls. When Facebook blocks an anonymous check, it
//   is blocking the server: the cycle stops and everyone backs off (exponential, max 6h). When it
//   blocks one ACCOUNT's check (its checkpoint, its ended session), only that account's remaining
//   work is skipped this cycle. AppConfig.disableChecker turns
//   off all background Facebook work: the loop and the post-create seeds.
// - Background Facebook work (cycle calls and seeds) goes through one permit, so it never runs two
//   Facebook requests at once. "Run now" doesn't wait for it: the user is waiting.
import '@tanstack/react-start/server-only';
import { Cause, Clock, Context, Duration, Effect, Exit, FiberSet, Layer, Option, Random, Semaphore } from 'effect';
import { AppConfig } from '@/server/config';
import { ACTIVE_SESSION_WINDOW_MS, ClientSessionsRepo } from '@/server/db/repositories/ClientSessionsRepo';
import { FavoritesRepo } from '@/server/db/repositories/FavoritesRepo';
import { SavedSearchesRepo, sameSearchParams } from '@/server/db/repositories/SavedSearchesRepo';
import { SettingsRepo } from '@/server/db/repositories/SettingsRepo';
import { Marketplace } from '@/server/marketplace/Marketplace';
import { type FbProfile, type OwnerKey, accountOfOwner, profileKey, profileOfOwner } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import { applyLocalFilters, loadLocalFilters } from '@/server/filters';
import type {
  ListingDetail,
  ListingId,
  ListingSummary,
  SavedSearch,
  SavedSearchId,
  SavedSearchInput,
  SavedSearchPatch,
  SavedSearchRunResult,
} from '@/shared/domain';
import { AppError } from '@/shared/errors';

export interface CheckOutcome {
  /** Listings recorded for the first time this run. */
  readonly added: number;
  /** True when this run recorded the search's baseline (nothing counts as new). */
  readonly seeded: boolean;
  /** When the results were recorded (first_seen_at of the added rows). */
  readonly at: number;
}

export interface CycleStats {
  readonly searches: number;
  readonly newListings: number;
  readonly favorites: number;
  readonly priceDrops: number;
  readonly errors: number;
  /** Facebook blocked us; the cycle stopped early. */
  readonly blocked: boolean;
}

export interface CheckerShape {
  /**
   * Run the owner's saved search now (first page, Marketplace.searchFirstPage) and record what it
   * saw. Runs as profileOfOwner(owner) when that account has a saved Facebook session, else anonymously.
   */
  readonly checkSavedSearch: (owner: OwnerKey, savedSearch: SavedSearch) => Effect.Effect<CheckOutcome, AppError>;
  /**
   * Record a new (or re-parameterized) search's current results as already seen, in the
   * background: fork into the checker's own scope (e.g. a FiberSet built in the layer, so runtime
   * disposal interrupts it) and return immediately. The seed itself never fails (it logs).
   */
  readonly scheduleSeed: (owner: OwnerKey, id: SavedSearchId) => Effect.Effect<void>;
  /**
   * One pass over every ACTIVE owner (ClientSessionsRepo.activeOwners: used in the last 30 days)
   * whose own Settings.checkIntervalMinutes says a check is due: their auto-check saved searches,
   * then favorites (de-duplicated by listing id across owners). Exposed for tests.
   */
  readonly runCycle: Effect.Effect<CycleStats>;
}

const MINUTE_MS = 60_000;

/** Pacing of the background loop. A Reference, so tests can make it instant. */
export interface CheckerTimingShape {
  /** Delay before the first cycle can run. */
  readonly firstRunDelay: Duration.Duration;
  /** How often the loop wakes to re-read settings and see whether a cycle is due. */
  readonly pollInterval: Duration.Duration;
  /** Longest wait after Facebook blocked a cycle. */
  readonly maxBackoff: Duration.Duration;
  /** The gap before every Facebook call of a cycle but the first (jittered 3-8 s). */
  readonly pause: Effect.Effect<void>;
}

export const CheckerTiming = Context.Reference<CheckerTimingShape>('faceslop/server/CheckerTiming', {
  defaultValue: () => ({
    firstRunDelay: Duration.minutes(1),
    pollInterval: Duration.seconds(30),
    maxBackoff: Duration.hours(6),
    pause: Effect.flatMap(Random.nextIntBetween(3_000, 8_000), (ms) => Effect.sleep(Duration.millis(ms))),
  }),
});

/**
 * Fresh detail data over the stored summary: fields the detail page lacks (null or empty) keep
 * their stored values; the status always comes from the detail. Detail-only fields are dropped
 * (the literal below lists every ListingSummary key; the compiler rejects a missing one).
 */
export function mergeListing(stored: ListingSummary, detail: ListingDetail): ListingSummary {
  const fresh = <K extends keyof ListingSummary>(key: K): ListingSummary[K] => {
    const value = detail[key];
    return value === null || (Array.isArray(value) && value.length === 0) ? stored[key] : value;
  };
  return {
    id: fresh('id'),
    title: fresh('title'),
    price: fresh('price'),
    previousPrice: fresh('previousPrice'),
    imageUrl: fresh('imageUrl'),
    location: fresh('location'),
    createdAt: fresh('createdAt'),
    status: detail.status,
    sellerId: fresh('sellerId'),
    sellerName: fresh('sellerName'),
    deliveryTypes: fresh('deliveryTypes'),
    categoryId: fresh('categoryId'),
    url: fresh('url'),
  };
}

const plural = (n: number, word: string, suffix = 's') => `${String(n)} ${word}${n === 1 ? '' : suffix}`;

function describeStats(stats: CycleStats, owners: number, ms: number): string {
  const searches = `${plural(stats.searches, 'saved search', 'es')} (${String(stats.newListings)} new)`;
  const favorites = `${plural(stats.favorites, 'favorite')} (${plural(stats.priceDrops, 'price drop')})`;
  const errors = stats.errors > 0 ? `, ${plural(stats.errors, 'error')}` : '';
  return `checked ${searches}, ${favorites}${errors} for ${plural(owners, 'owner')} in ${String(Math.round(ms / 1000))}s`;
}

/** An AppError's message, or the pretty-printed cause of anything else. */
const describeCause = (cause: Cause.Cause<AppError>): string =>
  Option.match(Cause.findErrorOption(cause), { onSome: (error) => error.message, onNone: () => Cause.pretty(cause) });

const isNotInterruption = <E>(cause: Cause.Cause<E>) => !Cause.hasInterruptsOnly(cause);

/** How one Facebook call of a cycle ended. Interruption is not captured: it stops the cycle. */
type Attempt<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly code: AppError['code'] | null; readonly cause: Cause.Cause<AppError> };

const attempt = <A>(effect: Effect.Effect<A, AppError>): Effect.Effect<Attempt<A>> =>
  Effect.matchCauseEffect(effect, {
    onSuccess: (value) => Effect.succeed<Attempt<A>>({ ok: true, value }),
    onFailure: (cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.succeed<Attempt<A>>({
            ok: false,
            code: Option.getOrNull(Option.map(Cause.findErrorOption(cause), (error) => error.code)),
            cause,
          }),
  });

/** An owner a cycle covers, and its check interval. */
interface DueOwner {
  readonly owner: OwnerKey;
  readonly intervalMs: number;
}

/** What one cycle did (the loop logs it and backs off on a block). */
interface CycleRun {
  readonly stats: CycleStats;
  readonly owners: number;
  /** The shortest check interval among the owners it covered. */
  readonly shortestIntervalMs: number;
  readonly startedAt: number;
  readonly endedAt: number;
}

/** A favorited listing to refresh once for every owner who saved it. */
interface FavoriteToRefresh {
  readonly id: ListingId;
  /** Whose Facebook profile fetches it: an account owner when one saved it (sees what a logged-in user sees). */
  as: OwnerKey;
  /** Every due owner who saved it. Each one's own copy is refreshed (stored copies come from that owner's browser). */
  readonly owners: OwnerKey[];
}

const NOTHING_CHECKED: CycleStats = { searches: 0, newListings: 0, favorites: 0, priceDrops: 0, errors: 0, blocked: false };

const make = Effect.gen(function* () {
  const config = yield* AppConfig;
  const marketplace = yield* Marketplace;
  const savedSearches = yield* SavedSearchesRepo;
  const favorites = yield* FavoritesRepo;
  const settings = yield* SettingsRepo;
  const clientSessions = yield* ClientSessionsRepo;
  const timing = yield* CheckerTiming;

  /** One permit for background Facebook work: the cycle's calls and seeds never overlap. */
  const backgroundLane = yield* Semaphore.make(1);
  /** Seeds run here; closing the layer's scope interrupts them. */
  const seeds = yield* FiberSet.make();
  /** When each active owner's last cycle ended. */
  const lastCycleEndedAt = new Map<OwnerKey, number>();

  const checkSavedSearch = Effect.fn('Checker.checkSavedSearch')(function* (owner: OwnerKey, savedSearch: SavedSearch) {
    // Only the first page matters here, and no search session is kept for "load more".
    const page = yield* marketplace.searchFirstPage(profileOfOwner(owner), savedSearch.params);
    const recorded = yield* savedSearches.recordCheck(savedSearch, page.listings);
    if (Option.isSome(recorded)) return recorded.value satisfies CheckOutcome;
    // Deleted (or its params changed) while Facebook answered: nothing recorded.
    return { added: 0, seeded: false, at: yield* Clock.currentTimeMillis } satisfies CheckOutcome;
  });

  const seed = Effect.fn('Checker.seed')(function* (owner: OwnerKey, id: SavedSearchId) {
    // Read inside the permit: a cycle that just ran may have seeded it already.
    const found = yield* savedSearches.get(owner, id);
    if (Option.isNone(found) || found.value.lastViewedAt !== null) return;
    const savedSearch = found.value;
    yield* checkSavedSearch(owner, savedSearch).pipe(
      // The checker (or the next run) records the baseline instead.
      Effect.catchCauseIf(isNotInterruption, (cause) =>
        Effect.logWarning(`[saved-searches] couldn't record a baseline for "${savedSearch.name}": ${describeCause(cause)}`),
      ),
    );
  });

  // With the checker disabled (tests, smoke runs) there is no background Facebook work at all; an
  // unseeded search records its baseline on its first run instead.
  const scheduleSeed = (owner: OwnerKey, id: SavedSearchId): Effect.Effect<void> =>
    config.disableChecker
      ? Effect.void
      : FiberSet.run(seeds, backgroundLane.withPermit(seed(owner, id))).pipe(Effect.asVoid);

  /** Active owners whose own interval says a check is due at `now`. */
  const dueOwners = Effect.fnUntraced(function* (now: number) {
    const active = new Set(yield* clientSessions.activeOwners(now - ACTIVE_SESSION_WINDOW_MS));
    // Owners that went inactive are forgotten: when they come back, they are due at once.
    for (const owner of lastCycleEndedAt.keys()) if (!active.has(owner)) lastCycleEndedAt.delete(owner);
    const due: DueOwner[] = [];
    for (const owner of active) {
      const intervalMs = (yield* settings.get(owner)).checkIntervalMinutes * MINUTE_MS;
      const last = lastCycleEndedAt.get(owner);
      if (intervalMs > 0 && (last === undefined || now >= last + intervalMs)) due.push({ owner, intervalMs });
    }
    return due;
  });

  /** One pass for these owners: their auto-check saved searches, then their favorites (each listing once). */
  const checkOwners = Effect.fnUntraced(function* (owners: ReadonlySet<OwnerKey>) {
    const stats = { ...NOTHING_CHECKED };
    let calls = 0;
    /** Space out Facebook calls (no pause before the first) and keep them off the seeds' toes. */
    const facebookCall = <A>(effect: Effect.Effect<A, AppError>) =>
      Effect.andThen(calls++ > 0 ? timing.pause : Effect.void, backgroundLane.withPermit(attempt(effect)));
    /** Accounts Facebook blocked this cycle (a checkpoint or an ended session): their other work is skipped. */
    const blockedAccounts = new Set<string>();
    const isBlocked = (profile: FbProfile) => profile.kind === 'account' && blockedAccounts.has(profileKey(profile));
    /**
     * Count a failed call; true when the cycle must stop. A block of the ANONYMOUS profile means
     * Facebook is blocking the server: everyone stops and backs off. A block of one account is that
     * account's problem (its checkpoint, its ended session): only its remaining work is skipped.
     */
    const failed = (
      what: string,
      outcome: { readonly code: AppError['code'] | null; readonly cause: Cause.Cause<AppError> },
      profile: FbProfile,
    ) => {
      if (outcome.code === 'FB_BLOCKED' && profile.kind === 'anonymous') {
        stats.blocked = true;
        return Effect.succeed(true);
      }
      stats.errors++;
      if (outcome.code === 'FB_BLOCKED') {
        blockedAccounts.add(profileKey(profile));
        return Effect.as(
          Effect.logWarning(`[checker] ${what}: Facebook blocked this account's check; skipping its other checks this cycle.`),
          false,
        );
      }
      return Effect.as(Effect.logWarning(`[checker] ${what}: ${describeCause(outcome.cause)}`), false);
    };

    for (const { owner, search } of yield* savedSearches.listAll) {
      if (!owners.has(owner) || !search.autoCheck || isBlocked(profileOfOwner(owner))) continue;
      const outcome = yield* facebookCall(checkSavedSearch(owner, search));
      if (outcome.ok) {
        stats.searches++;
        if (!outcome.value.seeded) stats.newListings += outcome.value.added;
      } else if (yield* failed(`saved search "${search.name}"`, outcome, profileOfOwner(owner))) {
        return stats;
      }
    }

    // Sold is final; don't keep asking Facebook about it.
    const toRefresh = new Map<string, FavoriteToRefresh>();
    for (const { owner, favorite } of yield* favorites.listAll) {
      if (!owners.has(owner) || favorite.listing.status === 'sold') continue;
      const entry = toRefresh.get(favorite.listing.id);
      if (entry === undefined) {
        toRefresh.set(favorite.listing.id, { id: favorite.listing.id, as: owner, owners: [owner] });
        continue;
      }
      entry.owners.push(owner);
      if (accountOfOwner(entry.as) === null && accountOfOwner(owner) !== null) entry.as = owner;
    }

    /**
     * Apply one Facebook answer to every saver's OWN current copy (re-read now: one of them may have
     * unfavorited it while Facebook answered). True when someone still had it.
     */
    const refreshEach = (entry: FavoriteToRefresh, update: (stored: ListingSummary) => ListingSummary) =>
      Effect.gen(function* () {
        let refreshed = false;
        let dropped = false;
        for (const owner of entry.owners) {
          const current = yield* favorites.get(owner, entry.id);
          if (Option.isNone(current)) continue;
          const stored = current.value.listing;
          const fresh = update(stored);
          yield* favorites.updateListing(owner, fresh, yield* Clock.currentTimeMillis);
          refreshed = true;
          if (fresh.price.amount !== null && stored.price.amount !== null && fresh.price.amount < stored.price.amount) dropped = true;
        }
        return { refreshed, dropped };
      });

    for (const entry of toRefresh.values()) {
      const profile = profileOfOwner(entry.as);
      if (isBlocked(profile)) continue;
      const outcome = yield* facebookCall(marketplace.getListing(profile, entry.id));
      if (outcome.ok) {
        const detail = outcome.value;
        const { refreshed, dropped } = yield* refreshEach(entry, (stored) => mergeListing(stored, detail));
        if (refreshed) stats.favorites++;
        if (dropped) stats.priceDrops++;
      } else if (outcome.code === 'NOT_FOUND') {
        // Removed from Marketplace: almost always sold.
        if ((yield* refreshEach(entry, (stored) => ({ ...stored, status: 'sold' }))).refreshed) stats.favorites++;
      } else if (yield* failed(`favorite ${entry.id}`, outcome, profile)) {
        return stats;
      }
    }
    return stats;
  });

  /** Check every due owner (None when nobody is due). Its owners' next cycle is one interval after it ends. */
  const cycle = Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const due = yield* dueOwners(startedAt);
    if (due.length === 0) return Option.none<CycleRun>();
    const exit = yield* Effect.exit(checkOwners(new Set(due.map((d) => d.owner))));
    const endedAt = yield* Clock.currentTimeMillis;
    // A failed cycle counts too: it is retried after the interval, not at the next wake-up.
    if (!(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))) {
      for (const { owner } of due) lastCycleEndedAt.set(owner, endedAt);
    }
    const stats = yield* exit;
    return Option.some<CycleRun>({
      stats,
      owners: due.length,
      shortestIntervalMs: Math.min(...due.map((d) => d.intervalMs)),
      startedAt,
      endedAt,
    });
  });

  const runCycle: Effect.Effect<CycleStats> = cycle.pipe(
    Effect.map(Option.match({ onNone: () => NOTHING_CHECKED, onSome: (run) => run.stats })),
    Effect.withSpan('Checker.runCycle'),
  );

  /** The background loop: never overlaps itself (one fiber), re-reads the intervals every wake-up. */
  const loop = Effect.gen(function* () {
    const maxBackoffMs = Duration.toMillis(timing.maxBackoff);
    /** No cycle before this: the boot delay, then the backoff after Facebook blocked us. */
    let resumeAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(timing.firstRunDelay);
    let backoffMs = 0;

    /** One wake-up: run a cycle when anyone is due. */
    const tick = Effect.gen(function* () {
      if ((yield* Clock.currentTimeMillis) < resumeAt) return;
      const ran = yield* cycle;
      if (Option.isNone(ran)) return;
      const { stats, owners, shortestIntervalMs, startedAt, endedAt } = ran.value;
      if (stats.blocked) {
        // Facebook blocks the server, not one owner: every owner waits.
        backoffMs = Math.min(Math.max(backoffMs, shortestIntervalMs) * 2, maxBackoffMs);
        resumeAt = endedAt + backoffMs;
        yield* Effect.logWarning(
          `[checker] Facebook blocked the check; stopped early (${describeStats(stats, owners, endedAt - startedAt)}). ` +
            `Next try in ${String(Math.round(backoffMs / MINUTE_MS))} min.`,
        );
      } else {
        backoffMs = 0;
        yield* Effect.logInfo(`[checker] ${describeStats(stats, owners, endedAt - startedAt)}`);
      }
    });

    for (;;) {
      yield* Effect.sleep(timing.pollInterval);
      // Anything else that breaks a wake-up (a failed cycle, a settings read that died) is logged
      // and the loop goes on, as legacy's tick did; only interruption (runtime disposal) ends it.
      yield* tick.pipe(
        Effect.catchCauseIf(isNotInterruption, (cause) => Effect.logError(`[checker] check failed:\n${Cause.pretty(cause)}`)),
      );
    }
  });

  if (!config.disableChecker) yield* Effect.forkScoped(loop);

  return Checker.of({ checkSavedSearch, scheduleSeed, runCycle });
});

export class Checker extends Context.Service<Checker, CheckerShape>()('faceslop/server/Checker') {
  /** No background fiber; methods are defects. */
  static readonly layerStub = Layer.succeed(
    Checker,
    Checker.of({
      checkSavedSearch: () => notImplemented('Checker.checkSavedSearch'),
      scheduleSeed: () => notImplemented('Checker.scheduleSeed'),
      runCycle: notImplemented('Checker.runCycle'),
    }),
  );

  /** Needs the repositories, Marketplace and AppConfig (tests provide their own). */
  static readonly layerNoDeps = Layer.effect(Checker, make);

  /** The layer the app runs: starts the background loop unless AppConfig.disableChecker. */
  static readonly layer = Checker.layerNoDeps.pipe(
    Layer.provide([
      SavedSearchesRepo.layer,
      FavoritesRepo.layer,
      SettingsRepo.layer,
      ClientSessionsRepo.layer,
      Marketplace.layer,
      AppConfig.layer,
    ]),
  );
}

const savedSearchNotFound = () => new AppError({ code: 'NOT_FOUND', message: 'That saved search no longer exists.' });

const mustExist = Option.match({
  onNone: () => Effect.fail(savedSearchNotFound()),
  onSome: (savedSearch: SavedSearch) => Effect.succeed(savedSearch),
});

// ---------- saved-search operations behind the saved-searches server functions ----------

/**
 * Create a saved search (createSavedSearch server function), then record its baseline in the
 * background, so what exists now never counts as new (newCount starts at 0).
 */
export const createSavedSearch = Effect.fn('createSavedSearch')(function* (
  owner: OwnerKey,
  input: SavedSearchInput,
  now: number,
) {
  const created = yield* SavedSearchesRepo.use((repo) => repo.create(owner, input, now));
  yield* Checker.use((checker) => checker.scheduleSeed(owner, created.id));
  return created;
});

/**
 * Apply a patch (updateSavedSearch server function). New params forget what was seen, so a fresh
 * baseline is recorded in the background. NOT_FOUND when the search doesn't exist.
 */
export const updateSavedSearch = Effect.fn('updateSavedSearch')(function* (
  owner: OwnerKey,
  id: SavedSearchId,
  patch: SavedSearchPatch,
) {
  const repo = yield* SavedSearchesRepo;
  const before = yield* Effect.flatMap(repo.get(owner, id), mustExist);
  const updated = yield* Effect.flatMap(repo.update(owner, id, patch), mustExist);
  if (patch.params !== undefined && !sameSearchParams(patch.params, before.params)) {
    yield* Checker.use((checker) => checker.scheduleSeed(owner, id));
  }
  return updated;
});

/**
 * "Run now" (the runSavedSearch server function): fetch page 1 and record it, then return every
 * listing first seen since the previous view (including what background checks found), minus
 * locally filtered ones, and mark the search viewed. The first run of a never-seeded search is
 * its baseline, so it reports nothing. NOT_FOUND when the search doesn't exist.
 */
export const runSavedSearch = Effect.fn('runSavedSearch')(function* (owner: OwnerKey, id: SavedSearchId) {
  const repo = yield* SavedSearchesRepo;
  const savedSearch = yield* Effect.flatMap(repo.get(owner, id), mustExist);
  yield* Checker.use((checker) => checker.checkSavedSearch(owner, savedSearch));
  // One transaction: what was first seen since the last view, then lastViewedAt = now, so a
  // background check can't record something in between that would never be reported.
  const unseen = yield* repo.viewNew(owner, id);
  const { kept } = applyLocalFilters(unseen, yield* loadLocalFilters(owner));
  const viewed = yield* repo.get(owner, id);
  if (Option.isNone(viewed)) return yield* savedSearchNotFound();
  return { savedSearch: viewed.value, newListings: kept } satisfies SavedSearchRunResult;
});
