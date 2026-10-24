// The background checker and saved-search runs (port of legacy/test/server-checker.test.ts and the
// saved-search parts of legacy/test/server.test.ts), against real repositories on an in-memory
// database and a scripted fake Marketplace. Time is the TestClock.
//
// Multi-user: the checker works per owner. Only owners with a browser seen in the last 30 days are
// checked, each on its own interval; searches run as the owner's Facebook profile through
// Marketplace.searchFirstPage (the fake's `search` dies); a listing favorited by several owners is
// fetched once and every copy is updated.
import { describe, expect, it } from '@effect/vitest';
import { Clock, Context, Duration, Effect, Exit, Fiber, Layer, Option, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import {
  Checker,
  CheckerTiming,
  createSavedSearch,
  mergeListing,
  runSavedSearch,
  updateSavedSearch,
  type CheckerTimingShape,
} from '@/server/checker/Checker';
import { AppConfig } from '@/server/config';
import { RepositoriesLayerMemory } from '@/server/db/layers';
import { ClientSessionsRepo } from '@/server/db/repositories/ClientSessionsRepo';
import { FavoritesRepo } from '@/server/db/repositories/FavoritesRepo';
import { SavedSearchesRepo } from '@/server/db/repositories/SavedSearchesRepo';
import { SettingsRepo } from '@/server/db/repositories/SettingsRepo';
import { Marketplace, type SearchPage } from '@/server/marketplace/Marketplace';
import {
  type ClientSessionId,
  type FbUserId,
  type OwnerKey,
  accountOwner,
  profileKey,
  sessionOwner,
} from '@/server/session/identity';
import type { ListingDetail, ListingSummary, SearchParams } from '@/shared/domain';
import { AppError } from '@/shared/errors';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A logged-in owner (their Facebook account) and a browser that never logged in. */
const ALICE = '1001' as FbUserId;
const A = accountOwner(ALICE);
const B = sessionOwner('guest-browser' as ClientSessionId);

const listing = (id: string, overrides: Partial<ListingSummary> = {}): ListingSummary => ({
  id,
  title: `Listing ${id}`,
  price: { amount: 100, formatted: '$100', currency: 'USD' },
  previousPrice: null,
  imageUrl: 'https://scontent.example/a.jpg',
  location: 'Brooklyn, NY',
  createdAt: 1,
  status: 'available',
  sellerId: 's1',
  sellerName: 'Sam',
  deliveryTypes: ['IN_PERSON'],
  categoryId: null,
  url: `https://www.facebook.com/marketplace/item/${id}/`,
  ...overrides,
});

const detail = (base: ListingSummary, overrides: Partial<ListingDetail> = {}): ListingDetail => ({
  ...base,
  description: '',
  photos: [],
  condition: null,
  attributes: [],
  categoryName: null,
  seller: null,
  shippingOffered: false,
  canMessage: false,
  hasMessaged: false,
  isViewerSeller: false,
  ...overrides,
});

const page = (listings: ListingSummary[]): SearchPage => ({ sessionId: null, listings, hasMore: false, location: null });

/** What the fake Marketplace answers (queued answers first, then the fallback) and what it was asked. */
interface Script {
  readonly searches: Effect.Effect<SearchPage, AppError>[];
  searchFallback: Effect.Effect<SearchPage, AppError>;
  readonly listings: Effect.Effect<ListingDetail, AppError>[];
  readonly searchCalls: SearchParams[];
  /** profileKey of each search ("anonymous" or "fb:<id>"). */
  readonly searchProfiles: string[];
  readonly listingCalls: string[];
  readonly listingProfiles: string[];
  pauses: number;
}

const makeScript = (): Script => ({
  searches: [],
  searchFallback: Effect.succeed(page([])),
  listings: [],
  searchCalls: [],
  searchProfiles: [],
  listingCalls: [],
  listingProfiles: [],
  pauses: 0,
});

const blocked = () => new AppError({ code: 'FB_BLOCKED', message: 'checkpoint' });

const fakeMarketplace = (script: Script) =>
  Layer.succeed(
    Marketplace,
    Marketplace.of({
      // Background checks and "run now" must not open search sessions.
      search: () => Effect.die('the checker must use searchFirstPage'),
      searchFirstPage: (profile, params) =>
        Effect.suspend(() => {
          script.searchCalls.push(params);
          script.searchProfiles.push(profileKey(profile));
          return script.searches.shift() ?? script.searchFallback;
        }),
      loadMore: () => Effect.die('unused'),
      closeSession: () => Effect.die('unused'),
      closeAllSessions: () => Effect.void,
      getListing: (profile, id) =>
        Effect.suspend(() => {
          script.listingCalls.push(id);
          script.listingProfiles.push(profileKey(profile));
          return script.listings.shift() ?? Effect.die(`unexpected getListing(${id})`);
        }),
      forgetListing: () => Effect.void,
      clearListingCache: () => Effect.void,
      searchLocations: () => Effect.succeed([]),
      categories: Effect.succeed([]),
    }),
  );

interface TimingOptions {
  readonly firstRunDelay?: Duration.Input;
  readonly pollInterval?: Duration.Input;
  readonly maxBackoff?: Duration.Input;
  readonly pause?: Effect.Effect<void>;
}

interface CheckerLayerOptions {
  readonly background?: boolean;
  readonly timing?: TimingOptions;
  /** Wraps the SettingsRepo the checker sees (the repositories keep the real one). */
  readonly settings?: Layer.Layer<SettingsRepo, never, SettingsRepo>;
}

/**
 * The checker over fresh repositories and the fake Marketplace. `background` enables background work
 * (the loop and seeds); time only passes when a test adjusts the TestClock.
 */
const checkerLayer = (script: Script, options: CheckerLayerOptions = {}) => {
  const timing = options.timing ?? {};
  const pacing: CheckerTimingShape = {
    firstRunDelay: Duration.fromInputUnsafe(timing.firstRunDelay ?? '1 minute'),
    pollInterval: Duration.fromInputUnsafe(timing.pollInterval ?? '30 seconds'),
    maxBackoff: Duration.fromInputUnsafe(timing.maxBackoff ?? '6 hours'),
    pause:
      timing.pause ??
      Effect.sync(() => {
        script.pauses++;
      }),
  };
  const checker = options.settings === undefined ? Checker.layerNoDeps : Checker.layerNoDeps.pipe(Layer.provide(options.settings));
  return checker.pipe(
    Layer.provideMerge(RepositoriesLayerMemory),
    Layer.provide(fakeMarketplace(script)),
    Layer.provide(AppConfig.layerTest({ dataDir: '/nonexistent/faceslop-test', disableChecker: options.background !== true })),
    Layer.provide(Layer.succeed(CheckerTiming, pacing)),
  );
};

/** A browser of this owner was seen now (account owners: a session bound to the account). */
const activate = (owner: OwnerKey, seenAt?: number) =>
  Effect.gen(function* () {
    const now = seenAt ?? (yield* Clock.currentTimeMillis);
    const account = owner.startsWith('fb:') ? (owner.slice(3) as FbUserId) : null;
    const id = (account === null ? owner.slice('session:'.length) : `browser-of-${account}-${String(now)}`) as ClientSessionId;
    yield* ClientSessionsRepo.use((repo) =>
      repo.insert({ id, tokenHash: `hash-${id}`, unlockedWith: null, fbUserId: account, createdAt: now, lastSeenAt: now }),
    );
  });

const createSearch = (name: string, params: SearchParams, autoCheck = true, owner: OwnerKey = A) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    SavedSearchesRepo.use((repo) => repo.create(owner, { name, params, autoCheck }, now)),
  );

const getSaved = (id: number, owner: OwnerKey = A) =>
  Effect.flatMap(SavedSearchesRepo.use((repo) => repo.get(owner, id)), (found) => Effect.sync(() => Option.getOrThrow(found)));

const getFavorite = (id: string, owner: OwnerKey = A) =>
  Effect.flatMap(FavoritesRepo.use((repo) => repo.get(owner, id)), (found) => Effect.sync(() => Option.getOrThrow(found)));

const saveFavorite = (listingSummary: ListingSummary, savedAt: number, owner: OwnerKey = A) =>
  FavoritesRepo.use((repo) => repo.save(owner, { listing: listingSummary, note: null }, savedAt));

const setInterval = (minutes: number, owner: OwnerKey = A) =>
  SettingsRepo.use((repo) => repo.update(owner, { checkIntervalMinutes: minutes }));

const runCycle = Checker.use((checker) => checker.runCycle);

/** Let forked background work (seeds) finish: they only wait on synchronous fakes. */
const settle = Effect.repeat(Effect.yieldNow, { times: 50 });

describe('runCycle', () => {
  it.effect('checks auto-check saved searches and refreshes favorites, pacing every Facebook call', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      yield* activate(A);
      const repo = yield* SavedSearchesRepo;
      const watched = yield* createSearch('Bikes', { query: 'bike' });
      yield* createSearch('Manual', { query: 'desk' }, false);
      yield* repo.recordSeen(watched.id, [listing('1')], 10);
      yield* repo.markSeeded(watched.id, 10);
      yield* saveFavorite(listing('50'), 0);
      yield* saveFavorite(listing('51', { status: 'sold' }), 0);

      script.searches.push(Effect.succeed(page([listing('1'), listing('2')])));
      script.listings.push(
        Effect.succeed(
          detail(listing('50'), { price: { amount: 80, formatted: '$80', currency: 'USD' }, status: 'pending', imageUrl: null }),
        ),
      );

      const stats = yield* runCycle;
      expect(stats).toEqual({ searches: 1, newListings: 1, favorites: 1, priceDrops: 1, errors: 0, blocked: false });
      expect(script.searchCalls).toEqual([{ query: 'bike' }]);
      expect(script.searchProfiles).toEqual([A]); // as Alice's Facebook account
      expect(script.listingCalls).toEqual(['50']); // the sold favorite is skipped
      expect(script.listingProfiles).toEqual([A]);
      expect(script.pauses).toBe(1);

      const saved = yield* getSaved(watched.id);
      expect(saved.newCount).toBe(1);
      expect(saved.lastCheckedAt).toBe(1000);

      const fav = yield* getFavorite('50');
      expect(fav.listing.price.amount).toBe(80);
      expect(fav.listing.status).toBe('pending');
      expect(fav.listing.imageUrl).toBe('https://scontent.example/a.jpg'); // kept: the detail had none
      expect(fav.originalPrice.amount).toBe(100);
      expect(fav.lastCheckedAt).toBe(1000);
    }).pipe(Effect.provide(checkerLayer(script)));
  });

  it.effect('searches the stored params as they are (no default location)', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* activate(A);
      yield* SettingsRepo.use((repo) => repo.update(A, { defaultLocation: { id: 'nyc', name: 'New York' }, defaultRadiusKm: 30 }));
      yield* createSearch('Bikes', { query: 'bike', maxPrice: 300 });
      yield* runCycle;
      expect(script.searchCalls).toEqual([{ query: 'bike', maxPrice: 300 }]);
    }).pipe(Effect.provide(checkerLayer(script)));
  });

  it.effect('seeds unseeded searches without counting their results as new', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* TestClock.setTime(500);
      yield* activate(A);
      const s = yield* createSearch('New', {});
      script.searches.push(Effect.succeed(page([listing('1'), listing('2')])));
      expect((yield* runCycle).newListings).toBe(0);
      expect(yield* getSaved(s.id)).toMatchObject({ newCount: 0, lastViewedAt: 500 });
    }).pipe(Effect.provide(checkerLayer(script)));
  });

  it.effect('marks favorites that disappeared as sold', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* activate(A);
      yield* saveFavorite(listing('50'), 0);
      script.listings.push(Effect.fail(new AppError({ code: 'NOT_FOUND', message: 'gone' })));
      expect((yield* runCycle).favorites).toBe(1);
      expect((yield* getFavorite('50')).listing.status).toBe('sold');
      // Sold is final: the next cycle doesn't ask Facebook again.
      yield* TestClock.adjust('61 minutes');
      yield* runCycle;
      expect(script.listingCalls).toEqual(['50']);
    }).pipe(Effect.provide(checkerLayer(script)));
  });

  it.effect('stops early when Facebook blocks the server (an anonymous check)', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* activate(B);
      yield* createSearch('A', { query: 'a' }, true, B);
      yield* createSearch('B', { query: 'b' }, true, B);
      yield* saveFavorite(listing('50'), 0, B);
      script.searches.push(Effect.fail(blocked()));

      const stats = yield* runCycle;
      expect(stats.blocked).toBe(true);
      expect(script.searchCalls).toHaveLength(1);
      expect(script.listingCalls).toEqual([]);
    }).pipe(Effect.provide(checkerLayer(script)));
  });

  it.effect('stops early when Facebook blocks an anonymous favorite refresh', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* activate(B);
      yield* saveFavorite(listing('50'), 1, B);
      yield* saveFavorite(listing('51'), 2, B);
      script.listings.push(Effect.fail(blocked()));
      expect(yield* runCycle).toMatchObject({ favorites: 0, errors: 0, blocked: true });
      expect(script.listingCalls).toHaveLength(1);
    }).pipe(Effect.provide(checkerLayer(script)));
  });

  it.effect("a block of one ACCOUNT skips only that account's remaining work; others go on, nobody backs off", () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* activate(A);
      yield* activate(B);
      yield* createSearch('Alice 1', { query: 'a1' }, true, A);
      yield* createSearch('Alice 2', { query: 'a2' }, true, A);
      yield* createSearch('Guest', { query: 'g' }, true, B);
      yield* saveFavorite(listing('50'), 1, A);
      yield* saveFavorite(listing('60'), 2, B);
      // listAll is ordered by owner (fb: first), newest first: Alice's "a2" runs first and is blocked.
      script.searches.push(Effect.fail(blocked()), Effect.succeed(page([listing('9')])));
      script.listings.push(Effect.succeed(detail(listing('60'))));
      const stats = yield* runCycle;
      expect(stats).toMatchObject({ blocked: false, errors: 1, searches: 1, favorites: 1 });
      // Alice's other search and her favorite were skipped; the guest's work ran.
      expect(script.searchCalls).toEqual([{ query: 'a2' }, { query: 'g' }]);
      expect(script.listingCalls).toEqual(['60']);
    }).pipe(Effect.provide(checkerLayer(script)));
  });

  it.effect('keeps going after other errors, including defects', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* activate(A);
      yield* createSearch('A', { query: 'a' });
      yield* createSearch('B', { query: 'b' });
      yield* createSearch('C', { query: 'c' });
      script.searches.push(Effect.fail(new AppError({ code: 'FB_TIMEOUT', message: 'slow' })), Effect.die('boom'));
      const stats = yield* runCycle;
      expect(stats).toMatchObject({ searches: 1, errors: 2, blocked: false });
      expect(script.searchCalls).toHaveLength(3);
      expect(script.pauses).toBe(2);
    }).pipe(Effect.provide(checkerLayer(script)));
  });

  it.effect('skips a favorite that was unfavorited while Facebook answered', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* activate(A);
      const favorites = yield* FavoritesRepo;
      yield* saveFavorite(listing('50'), 0);
      script.listings.push(Effect.as(favorites.remove(A, '50'), detail(listing('50'))));
      expect((yield* runCycle).favorites).toBe(0);
      expect(yield* favorites.listAll).toEqual([]);
    }).pipe(Effect.provide(checkerLayer(script)));
  });

  it.effect('is interrupted between Facebook calls', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* activate(A);
      yield* createSearch('A', { query: 'a' });
      yield* createSearch('B', { query: 'b' });
      const fiber = yield* Effect.forkChild(runCycle);
      yield* settle;
      yield* Fiber.interrupt(fiber);
      expect(script.searchCalls).toHaveLength(1);
    }).pipe(Effect.provide(checkerLayer(script, { timing: { pause: Effect.sleep('10 seconds') } })));
  });
});

describe('runCycle: owners', () => {
  it.effect('checks each active owner on its own interval (0 = off), as its own Facebook profile', () => {
    const script = makeScript();
    const C = sessionOwner('paused-browser' as ClientSessionId);
    return Effect.gen(function* () {
      for (const owner of [A, B, C]) yield* activate(owner);
      yield* setInterval(15, A);
      yield* setInterval(0, C);
      yield* createSearch('Alice', { query: 'a' }, true, A);
      yield* createSearch('Guest', { query: 'b' }, true, B);
      yield* createSearch('Paused', { query: 'c' }, true, C);

      expect((yield* runCycle).searches).toBe(2);
      expect(script.searchCalls).toEqual([{ query: 'a' }, { query: 'b' }]);
      // An account owner searches as its account, a browser that never logged in anonymously.
      expect(script.searchProfiles).toEqual([A, 'anonymous']);

      // Nobody is due yet.
      yield* TestClock.adjust('14 minutes');
      expect((yield* runCycle).searches).toBe(0);
      // Alice's 15 minutes have passed; the guest has the default hour.
      yield* TestClock.adjust('1 minute');
      expect((yield* runCycle).searches).toBe(1);
      expect(script.searchCalls.at(-1)).toEqual({ query: 'a' });
      yield* TestClock.adjust('45 minutes');
      expect((yield* runCycle).searches).toBe(2);
      expect(script.searchCalls.slice(-2)).toEqual([{ query: 'a' }, { query: 'b' }]);
      expect(script.searchCalls.filter((params) => params.query === 'c')).toEqual([]);
    }).pipe(Effect.provide(checkerLayer(script)));
  });

  it.effect('skips owners whose browsers were not seen for 30 days', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* activate(A, 0);
      yield* createSearch('Alice', { query: 'a' }, true, A);
      yield* saveFavorite(listing('50'), 0, A);
      yield* TestClock.setTime(31 * DAY_MS);
      expect(yield* runCycle).toMatchObject({ searches: 0, favorites: 0 });
      expect(script.searchCalls).toEqual([]);

      // Back (a browser of Alice's was seen): checked again.
      yield* activate(A);
      script.listings.push(Effect.succeed(detail(listing('50'))));
      expect(yield* runCycle).toMatchObject({ searches: 1, favorites: 1 });
    }).pipe(Effect.provide(checkerLayer(script)));
  });

  it.effect("fetches a listing favorited by several owners once, as an account, and updates each due owner's copy", () => {
    const script = makeScript();
    const C = sessionOwner('paused-browser' as ClientSessionId);
    return Effect.gen(function* () {
      for (const owner of [A, B, C]) yield* activate(owner);
      yield* setInterval(0, C);
      // The guest saved it first; Alice has it too; C (checks off) has it and one of its own.
      yield* saveFavorite(listing('50'), 1, B);
      yield* saveFavorite(listing('50'), 2, A);
      yield* saveFavorite(listing('50'), 3, C);
      yield* saveFavorite(listing('60'), 3, C);
      yield* saveFavorite(listing('70'), 4, B);

      script.listings.push(
        Effect.succeed(detail(listing('50'), { price: { amount: 60, formatted: '$60', currency: 'USD' } })),
        Effect.succeed(detail(listing('70'))),
      );
      yield* TestClock.setTime(5000);
      expect(yield* runCycle).toMatchObject({ favorites: 2, priceDrops: 1 });
      expect(script.listingCalls).toEqual(['50', '70']);
      // Alice's account fetches the shared listing; the guest's own listing is fetched anonymously.
      expect(script.listingProfiles).toEqual([A, 'anonymous']);
      for (const owner of [A, B]) {
        expect(yield* getFavorite('50', owner)).toMatchObject({ listing: { price: { amount: 60 } }, lastCheckedAt: 5000 });
      }
      // C turned checks off: its copies are left alone.
      expect((yield* getFavorite('50', C)).lastCheckedAt).toBeNull();
      expect((yield* getFavorite('60', C)).lastCheckedAt).toBeNull();
    }).pipe(Effect.provide(checkerLayer(script)));
  });

  it.effect("never writes one owner's stored copy into another owner's favorite", () => {
    const script = makeScript();
    return Effect.gen(function* () {
      for (const owner of [A, B]) yield* activate(owner);
      // A's browser sent a doctored copy (stored copies come from the client); B saved the real one.
      const doctored = listing('50', { title: 'INJECTED', imageUrl: 'https://evil.example/track.gif', sellerName: 'Evil' });
      yield* saveFavorite(doctored, 1, A);
      yield* saveFavorite(listing('50'), 2, B);
      script.listings.push(Effect.fail(new AppError({ code: 'NOT_FOUND', message: 'gone' })));
      yield* TestClock.setTime(5000);
      expect(yield* runCycle).toMatchObject({ favorites: 1 });
      expect(script.listingCalls).toEqual(['50']);
      expect((yield* getFavorite('50', A)).listing).toMatchObject({ title: 'INJECTED', status: 'sold' });
      expect((yield* getFavorite('50', B)).listing).toEqual({ ...listing('50'), status: 'sold' });
    }).pipe(Effect.provide(checkerLayer(script)));
  });
});

describe('checkSavedSearch', () => {
  it.effect("records the first page, as the owner's profile", () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* TestClock.setTime(100);
      const s = yield* createSearch('A', { query: 'a' });
      script.searches.push(Effect.succeed(page([listing('1')])), Effect.succeed(page([listing('1'), listing('2')])));
      const checker = yield* Checker;
      expect(yield* checker.checkSavedSearch(A, s)).toEqual({ added: 1, seeded: true, at: 100 });
      yield* TestClock.adjust(50);
      expect(yield* checker.checkSavedSearch(A, yield* getSaved(s.id))).toEqual({ added: 1, seeded: false, at: 150 });
      expect(script.searchProfiles).toEqual([A, A]);

      const guests = yield* createSearch('B', { query: 'b' }, true, B);
      yield* checker.checkSavedSearch(B, guests);
      expect(script.searchProfiles.at(-1)).toBe('anonymous');
    }).pipe(Effect.provide(checkerLayer(script)));
  });

  it.effect('records nothing for a search deleted meanwhile, and passes Facebook errors on', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      const s = yield* createSearch('A', { query: 'a' });
      yield* SavedSearchesRepo.use((repo) => repo.remove(A, s.id));
      const checker = yield* Checker;
      expect(yield* checker.checkSavedSearch(A, s)).toMatchObject({ added: 0, seeded: false });
      script.searches.push(Effect.fail(blocked()));
      const exit = yield* Effect.exit(checker.checkSavedSearch(A, s));
      expect(Exit.isFailure(exit) && Option.getOrNull(Exit.findErrorOption(exit))?.code).toBe('FB_BLOCKED');
    }).pipe(Effect.provide(checkerLayer(script)));
  });
});

describe('scheduleSeed', () => {
  it.effect('records a baseline in the background and returns at once', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* TestClock.setTime(700);
      const s = yield* createSearch('A', { query: 'a' });
      script.searches.push(Effect.succeed(page([listing('1'), listing('2')])));
      yield* Checker.use((checker) => checker.scheduleSeed(A, s.id));
      yield* settle;
      expect(script.searchProfiles).toEqual([A]);
      expect(yield* getSaved(s.id)).toMatchObject({ newCount: 0, lastViewedAt: 700, lastCheckedAt: 700 });
      // Already seeded: a second seed doesn't search again.
      yield* Checker.use((checker) => checker.scheduleSeed(A, s.id));
      yield* settle;
      expect(script.searchCalls).toHaveLength(1);
    }).pipe(Effect.provide(checkerLayer(script, { background: true })));
  });

  it.effect("never fails: a Facebook error leaves the search unseeded; missing or another owner's searches are ignored", () => {
    const script = makeScript();
    return Effect.gen(function* () {
      const s = yield* createSearch('A', { query: 'a' });
      script.searches.push(Effect.fail(new AppError({ code: 'FB_TIMEOUT', message: 'slow' })));
      yield* Checker.use((checker) => checker.scheduleSeed(A, s.id));
      yield* settle;
      expect((yield* getSaved(s.id)).lastViewedAt).toBeNull();
      yield* Checker.use((checker) => checker.scheduleSeed(A, 424242));
      yield* Checker.use((checker) => checker.scheduleSeed(B, s.id));
      yield* settle;
      expect(script.searchCalls).toHaveLength(1);
    }).pipe(Effect.provide(checkerLayer(script, { background: true })));
  });

  it.effect('does nothing when the checker is disabled (no background Facebook work)', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      const s = yield* createSearch('A', { query: 'a' });
      yield* Checker.use((checker) => checker.scheduleSeed(A, s.id));
      yield* settle;
      expect(script.searchCalls).toEqual([]);
      expect((yield* getSaved(s.id)).lastViewedAt).toBeNull();
    }).pipe(Effect.provide(checkerLayer(script, { background: false })));
  });
});

describe('createSavedSearch / updateSavedSearch', () => {
  it.effect('seeds on create so existing results are not new', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* TestClock.setTime(100);
      script.searches.push(Effect.succeed(page([listing('1'), listing('2')])));
      const created = yield* createSavedSearch(A, { name: 'Bikes', params: { query: 'bike' }, autoCheck: true }, 100);
      expect(created).toMatchObject({ name: 'Bikes', params: { query: 'bike' }, autoCheck: true, newCount: 0, lastViewedAt: null });
      yield* settle;
      expect(script.searchCalls).toHaveLength(1);
      expect(yield* getSaved(created.id)).toMatchObject({ newCount: 0, lastViewedAt: 100, lastCheckedAt: 100 });
    }).pipe(Effect.provide(checkerLayer(script, { background: true })));
  });

  it.effect('re-seeds only when params change (in substance, not key order)', () => {
    const script = makeScript();
    script.searchFallback = Effect.succeed(page([listing('1')]));
    return Effect.gen(function* () {
      yield* TestClock.setTime(100);
      const created = yield* createSavedSearch(A, { name: 'Bikes', params: { query: 'bike', maxPrice: 300 }, autoCheck: true }, 100);
      yield* settle;
      expect(script.searchCalls).toHaveLength(1);

      const renamed = yield* updateSavedSearch(A, created.id, { name: 'Road bikes', params: { maxPrice: 300, query: 'bike' } });
      expect(renamed).toMatchObject({ name: 'Road bikes', lastViewedAt: 100 });
      yield* settle;
      expect(script.searchCalls).toHaveLength(1);

      yield* TestClock.setTime(200);
      const changed = yield* updateSavedSearch(A, created.id, { params: { query: 'road bike', maxPrice: 300 } });
      expect(changed).toMatchObject({ params: { query: 'road bike', maxPrice: 300 }, lastViewedAt: null, lastCheckedAt: null });
      yield* settle;
      expect(script.searchCalls.at(-1)).toEqual({ query: 'road bike', maxPrice: 300 });
      expect(yield* getSaved(created.id)).toMatchObject({ lastViewedAt: 200, newCount: 0 });
    }).pipe(Effect.provide(checkerLayer(script, { background: true })));
  });

  it.effect("fails with NOT_FOUND when updating a missing (or another owner's) saved search", () => {
    const script = makeScript();
    return Effect.gen(function* () {
      const missing = yield* Effect.flip(updateSavedSearch(A, 999, { name: 'x' }));
      expect(missing).toMatchObject({ code: 'NOT_FOUND', message: 'That saved search no longer exists.' });
      const theirs = yield* createSearch('Bikes', { query: 'bike' }, true, B);
      expect(yield* Effect.flip(updateSavedSearch(A, theirs.id, { name: 'Mine now' }))).toMatchObject({ code: 'NOT_FOUND' });
      expect((yield* getSaved(theirs.id, B)).name).toBe('Bikes');
    }).pipe(Effect.provide(checkerLayer(script)));
  });
});

describe('runSavedSearch (run now)', () => {
  it.effect('returns listings first seen since the last view, excluding filtered ones, then marks it viewed', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      yield* SettingsRepo.use((repo) => repo.update(A, { defaultLocation: { id: 'nyc', name: 'NYC' }, defaultRadiusKm: 30 }));
      const created = yield* createSearch('Bikes', { query: 'bike' });
      script.searches.push(Effect.succeed(page([listing('1'), listing('2')])));
      yield* Checker.use((checker) => checker.scheduleSeed(A, created.id));
      yield* settle;

      // A background check found listing 3 (and a filtered one) while the user was away.
      yield* TestClock.adjust(10);
      yield* SavedSearchesRepo.use((repo) => repo.recordSeen(created.id, [listing('3'), listing('9', { title: 'Broken crib' })], 1010));
      yield* SettingsRepo.use((repo) => repo.update(A, { excludedKeywords: ['crib'] }));
      expect((yield* getSaved(created.id)).newCount).toBe(1);

      // Running now finds listing 4 too.
      yield* TestClock.adjust(10);
      script.searches.push(Effect.succeed(page([listing('4'), listing('1'), listing('3')])));
      const result = yield* runSavedSearch(A, created.id);
      expect(script.searchCalls.at(-1)).toEqual({ query: 'bike' });
      expect(script.searchProfiles.at(-1)).toBe(A);
      expect(result.newListings.map((l) => l.id).sort()).toEqual(['3', '4']);
      expect(result.savedSearch).toMatchObject({ newCount: 0, lastViewedAt: 1020, lastCheckedAt: 1020 });

      // Nothing new on an immediate re-run.
      yield* TestClock.adjust(10);
      script.searches.push(Effect.succeed(page([listing('4'), listing('1')])));
      expect((yield* runSavedSearch(A, created.id)).newListings).toEqual([]);
    }).pipe(Effect.provide(checkerLayer(script, { background: true })));
  });

  it.effect('treats the first run of an unseeded search as the baseline', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* TestClock.setTime(50);
      const created = yield* createSearch('Bikes', { query: 'bike' });
      script.searches.push(Effect.succeed(page([listing('1')])));
      const result = yield* runSavedSearch(A, created.id);
      expect(result.newListings).toEqual([]);
      expect(result.savedSearch.lastViewedAt).toBe(50);
    }).pipe(Effect.provide(checkerLayer(script)));
  });

  it.effect("fails with NOT_FOUND for an unknown (or another owner's) id, and with the Facebook error when the search fails", () => {
    const script = makeScript();
    return Effect.gen(function* () {
      const missing = yield* Effect.flip(runSavedSearch(A, 999));
      expect(missing).toMatchObject({ code: 'NOT_FOUND', message: 'That saved search no longer exists.' });
      const created = yield* createSearch('Bikes', { query: 'bike' });
      expect(yield* Effect.flip(runSavedSearch(B, created.id))).toMatchObject({ code: 'NOT_FOUND' });
      expect(script.searchCalls).toEqual([]);
      script.searches.push(Effect.fail(new AppError({ code: 'FB_TIMEOUT', message: 'slow' })));
      expect(yield* Effect.flip(runSavedSearch(A, created.id))).toMatchObject({ code: 'FB_TIMEOUT' });
      expect((yield* getSaved(created.id)).lastViewedAt).toBeNull();
    }).pipe(Effect.provide(checkerLayer(script)));
  });
});

describe('mergeListing', () => {
  it('prefers fresh values but keeps stored ones the detail lacks', () => {
    const stored = listing('1', { sellerName: 'Sam', deliveryTypes: ['SHIPPING'] });
    const merged = mergeListing(stored, detail(listing('1'), { sellerName: null, deliveryTypes: [], title: 'New title', status: 'sold' }));
    expect(merged).toMatchObject({ title: 'New title', sellerName: 'Sam', deliveryTypes: ['SHIPPING'], status: 'sold' });
    expect(merged).not.toHaveProperty('description');
    expect(merged).not.toHaveProperty('canMessage');
  });
});

describe('background loop', () => {
  it.effect('does nothing while paused, runs once the interval is on, and stops with the runtime', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        checkerLayer(script, { background: true, timing: { firstRunDelay: '1 second', pollInterval: '500 millis' } }),
        scope,
      );
      const settings = Context.get(context, SettingsRepo);
      yield* activate(A).pipe(Effect.provideContext(context));
      yield* settings.update(A, { checkIntervalMinutes: 0 });
      yield* Context.get(context, SavedSearchesRepo).create(A, { name: 'A', params: { query: 'a' }, autoCheck: true }, 0);

      yield* TestClock.adjust('5 seconds');
      expect(script.searchCalls).toHaveLength(0);

      yield* settings.update(A, { checkIntervalMinutes: 15 });
      yield* TestClock.adjust('600 millis');
      expect(script.searchCalls).toHaveLength(1);

      // Not again until the interval has passed.
      yield* TestClock.adjust('14 minutes');
      expect(script.searchCalls).toHaveLength(1);
      yield* TestClock.adjust('61 seconds');
      expect(script.searchCalls).toHaveLength(2);

      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust('1 hour');
      expect(script.searchCalls).toHaveLength(2);
    });
  });

  it.effect('waits about a minute after boot for the first cycle', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* activate(A);
      yield* createSearch('A', { query: 'a' });
      yield* TestClock.adjust('45 seconds');
      expect(script.searchCalls).toHaveLength(0);
      yield* TestClock.adjust('30 seconds');
      expect(script.searchCalls).toHaveLength(1);
    }).pipe(Effect.provide(checkerLayer(script, { background: true })));
  });

  it.effect('runs each owner on its own interval', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* activate(A);
      yield* activate(B);
      yield* setInterval(15, A);
      yield* createSearch('Alice', { query: 'a' }, true, A);
      yield* createSearch('Guest', { query: 'b' }, true, B);
      const count = (query: string) => script.searchCalls.filter((params) => params.query === query).length;

      yield* TestClock.adjust('1500 millis'); // first cycle at 1 s: both
      expect([count('a'), count('b')]).toEqual([1, 1]);
      yield* TestClock.adjust('15 minutes'); // Alice at 15m1s
      expect([count('a'), count('b')]).toEqual([2, 1]);
      yield* TestClock.adjust('45 minutes'); // Alice at 30m1s, 45m1s, 60m1s; the guest's hour at 60m1s
      expect([count('a'), count('b')]).toEqual([5, 2]);
    }).pipe(Effect.provide(checkerLayer(script, { background: true, timing: { firstRunDelay: '1 second', pollInterval: '500 millis' } })));
  });

  it.effect('doubles the wait after Facebook blocks a cycle', () => {
    const script = makeScript();
    script.searchFallback = Effect.fail(blocked());
    return Effect.gen(function* () {
      yield* activate(B);
      yield* setInterval(15, B);
      yield* createSearch('A', { query: 'a' }, true, B);
      yield* TestClock.adjust('1100 millis');
      expect(script.searchCalls).toHaveLength(1);

      // Doubled: 30 minutes, not 15.
      yield* TestClock.adjust('16 minutes');
      expect(script.searchCalls).toHaveLength(1);
      yield* TestClock.adjust('15 minutes');
      expect(script.searchCalls).toHaveLength(2);
      // Then 60.
      yield* TestClock.adjust('31 minutes');
      expect(script.searchCalls).toHaveLength(2);
      yield* TestClock.adjust('30 minutes');
      expect(script.searchCalls).toHaveLength(3);
    }).pipe(Effect.provide(checkerLayer(script, { background: true, timing: { firstRunDelay: '0 millis', pollInterval: '1 second' } })));
  });

  it.effect('backs off every owner when Facebook blocks one cycle', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* activate(B);
      yield* setInterval(15, B);
      yield* createSearch('Guest', { query: 'b' }, true, B);
      script.searches.push(Effect.fail(blocked()));
      yield* TestClock.adjust('1100 millis');
      expect(script.searchCalls).toHaveLength(1);

      // Alice shows up during the backoff: nobody is checked until it is over (30 minutes).
      yield* activate(A);
      yield* createSearch('Alice', { query: 'a' }, true, A);
      yield* TestClock.adjust('29 minutes');
      expect(script.searchCalls).toHaveLength(1);
      yield* TestClock.adjust('2 minutes');
      expect(script.searchCalls.slice(1)).toEqual([{ query: 'a' }, { query: 'b' }]);
    }).pipe(Effect.provide(checkerLayer(script, { background: true, timing: { firstRunDelay: '0 millis', pollInterval: '1 second' } })));
  });

  it.effect('caps the backoff at the maximum', () => {
    const script = makeScript();
    script.searchFallback = Effect.fail(blocked());
    return Effect.gen(function* () {
      yield* activate(B);
      yield* setInterval(15, B);
      yield* createSearch('A', { query: 'a' }, true, B);
      // 15 -> 30 -> 40 (capped) -> 40 ...
      yield* TestClock.adjust('1 second');
      yield* TestClock.adjust('31 minutes');
      expect(script.searchCalls).toHaveLength(2);
      yield* TestClock.adjust('41 minutes');
      expect(script.searchCalls).toHaveLength(3);
      yield* TestClock.adjust('41 minutes');
      expect(script.searchCalls).toHaveLength(4);
    }).pipe(
      Effect.provide(
        checkerLayer(script, { background: true, timing: { firstRunDelay: '0 millis', pollInterval: '1 second', maxBackoff: '40 minutes' } }),
      ),
    );
  });

  it.effect('keeps going after a wake-up fails (e.g. the settings read dies), like legacy', () => {
    const script = makeScript();
    let failures = 2;
    const flakySettings = Layer.effect(
      SettingsRepo,
      Effect.gen(function* () {
        const real = yield* SettingsRepo;
        return SettingsRepo.of({
          ...real,
          get: (owner) => Effect.suspend(() => (failures-- > 0 ? Effect.die(new Error('database is locked')) : real.get(owner))),
        });
      }),
    );
    return Effect.gen(function* () {
      yield* activate(A);
      yield* createSearch('A', { query: 'a' });
      yield* TestClock.adjust('2 seconds'); // two wake-ups, both fail
      expect(script.searchCalls).toHaveLength(0);
      yield* TestClock.adjust('1 second'); // the loop is still alive and runs the cycle
      expect(script.searchCalls).toHaveLength(1);
    }).pipe(
      Effect.provide(
        checkerLayer(script, {
          background: true,
          settings: flakySettings,
          timing: { firstRunDelay: '0 millis', pollInterval: '1 second' },
        }),
      ),
    );
  });

  it.effect('does not start when disabled', () => {
    const script = makeScript();
    return Effect.gen(function* () {
      yield* activate(A);
      yield* createSearch('A', { query: 'a' });
      yield* TestClock.adjust('2 hours');
      expect(script.searchCalls).toHaveLength(0);
    }).pipe(Effect.provide(checkerLayer(script, { background: false })));
  });
});
