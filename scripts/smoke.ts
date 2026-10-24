// Live end-to-end check of the Marketplace engine against facebook.com, through the real Effect
// layers (Marketplace.layer: the real Browser, headless, and AppConfig). Run with `npm run smoke`.
// Exits non-zero if any check fails.
//
// Logged out: everything runs as the anonymous profile (no Facebook cookies), and the data dir is
// a throwaway temp dir unless FACESLOP_DATA_DIR is set. About a dozen page loads and a few GraphQL
// requests, one after another: keep it at that.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cause, Clock, ConfigProvider, Console, Effect, Exit, Layer, ManagedRuntime, Ref, Schema } from 'effect';
import { Marketplace } from '@/server/marketplace/Marketplace';
import { ANONYMOUS_PROFILE } from '@/server/session/identity';
import { ListingDetail, ListingSummary } from '@/shared/domain';
import { AppError } from '@/shared/errors';

const DENVER_ID = '115590505119035';
const profile = ANONYMOUS_PROFILE;
const BICYCLES_CATEGORY_ID = '1658310421102081';

class SmokeFailure extends Schema.TaggedError<SmokeFailure>()('SmokeFailure', { message: Schema.String }) {}

const ensure = (condition: boolean, message: string): Effect.Effect<void, SmokeFailure> =>
  condition ? Effect.void : Effect.fail(new SmokeFailure({ message }));

const decodeSummary = Schema.decodeUnknownEffect(ListingSummary);
const decodeDetail = Schema.decodeUnknownEffect(ListingDetail);

/** Every listing satisfies the domain schema and looks like a real Marketplace listing. */
const ensureWellFormed = (listings: readonly ListingSummary[]) =>
  Effect.forEach(
    listings,
    (listing) =>
      Effect.gen(function* () {
        yield* decodeSummary(listing).pipe(
          Effect.mapError((issue) => new SmokeFailure({ message: `listing ${listing.id} breaks the schema: ${issue.message}` })),
        );
        yield* ensure(/^\d+$/.test(listing.id), `bad listing id ${listing.id}`);
        yield* ensure(listing.title.length > 0, `listing ${listing.id} has no title`);
        yield* ensure(listing.url.endsWith(`/marketplace/item/${listing.id}/`), `listing ${listing.id} has a bad url`);
      }),
    { discard: true },
  );

/** The error code an effect fails with ('ok' when it succeeds). */
const codeOf = <A>(effect: Effect.Effect<A, AppError>) =>
  effect.pipe(
    Effect.as('ok'),
    Effect.catch((error) => Effect.succeed(error.code)),
  );

const describeCause = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  if (error instanceof AppError) return `${error.code} ${error.message}`;
  if (error instanceof SmokeFailure) return error.message;
  return error instanceof Error ? error.message : String(error);
};

const program = Effect.gen(function* () {
  const marketplace = yield* Marketplace;
  const failures = yield* Ref.make(0);

  const check = Effect.fnUntraced(function* (name: string, body: Effect.Effect<string, AppError | SmokeFailure>) {
    const started = yield* Clock.currentTimeMillis;
    const exit = yield* Effect.exit(body);
    const seconds = (((yield* Clock.currentTimeMillis) - started) / 1000).toFixed(1);
    if (Exit.isSuccess(exit)) {
      yield* Console.log(`ok    ${name}: ${exit.value} [${seconds}s]`);
    } else {
      yield* Ref.update(failures, (n) => n + 1);
      yield* Console.log(`FAIL  ${name}: ${describeCause(exit.cause)} [${seconds}s]`);
    }
  });

  const seen = new Set<string>();
  const state: { sessionId: string | null; first: ListingSummary | null } = { sessionId: null, first: null };

  yield* check(
    'search nyc "bike" (max $500, newest first)',
    Effect.gen(function* () {
      const page = yield* marketplace.search(profile, { location: 'nyc', query: 'bike', maxPrice: 500, sortBy: 'creation_time_descend' });
      yield* ensure(page.listings.length >= 5, `only ${page.listings.length} listings`);
      yield* ensureWellFormed(page.listings);
      yield* ensure(page.hasMore && page.sessionId !== null, 'expected more pages');
      yield* ensure(page.location?.name?.includes('New York') === true, `unexpected location ${page.location?.name ?? 'none'}`);
      const overBudget = page.listings.filter((l) => (l.price.amount ?? 0) > 500).length;
      yield* ensure(overBudget <= page.listings.length / 5, `${overBudget} listings over $500: filter not applied?`);
      for (const l of page.listings) seen.add(l.id);
      state.sessionId = page.sessionId;
      const top = page.listings[0];
      state.first = top ?? null;
      return `${page.listings.length} listings near ${page.location?.name ?? '?'}, first "${top?.title ?? ''}" ${top?.price.formatted ?? ''}`;
    }),
  );

  for (const n of [2, 3]) {
    yield* check(
      `load more (page ${n})`,
      Effect.gen(function* () {
        if (state.sessionId === null) return yield* new SmokeFailure({ message: 'no session from the previous step' });
        const page = yield* marketplace.loadMore(profile, state.sessionId);
        yield* ensure(page.listings.length > 0, 'no new listings');
        yield* ensureWellFormed(page.listings);
        const dupes = page.listings.filter((l) => seen.has(l.id)).length;
        yield* ensure(dupes === 0, `${dupes} duplicate listings`);
        for (const l of page.listings) seen.add(l.id);
        state.sessionId = page.sessionId;
        return `${page.listings.length} new listings (${seen.size} total), hasMore=${page.hasMore}`;
      }),
    );
  }
  if (state.sessionId !== null) yield* marketplace.closeSession(profile, state.sessionId);

  yield* check(
    'listing detail (+ cache hit)',
    Effect.gen(function* () {
      const listing = state.first;
      if (listing === null) return yield* new SmokeFailure({ message: 'no listing from the search step' });
      const detail = yield* marketplace.getListing(profile, listing.id);
      yield* decodeDetail(detail).pipe(Effect.mapError((issue) => new SmokeFailure({ message: `detail breaks the schema: ${issue.message}` })));
      yield* ensure(detail.title === listing.title, `title mismatch: "${detail.title}" vs "${listing.title}"`);
      yield* ensure(detail.photos.length > 0, 'no photos');
      const before = yield* Clock.currentTimeMillis;
      yield* marketplace.getListing(profile, listing.id);
      const cachedMs = (yield* Clock.currentTimeMillis) - before;
      yield* ensure(cachedMs < 50, `second call took ${cachedMs}ms: not served from cache`);
      return `"${detail.title}" ${detail.price.formatted}, ${detail.photos.length} photos, condition=${detail.condition ?? '-'}, seller=${detail.seller ? 'yes' : 'no'}, category=${detail.categoryName ?? '-'}`;
    }),
  );

  yield* check(
    'removed listing -> NOT_FOUND, bad id -> BAD_REQUEST',
    Effect.gen(function* () {
      const missing = yield* codeOf(marketplace.getListing(profile, '1631327708471399'));
      const bad = yield* codeOf(marketplace.getListing(profile, 'abc'));
      yield* ensure(missing === 'NOT_FOUND', `removed listing gave ${missing}`);
      yield* ensure(bad === 'BAD_REQUEST', `bad id gave ${bad}`);
      return 'as expected';
    }),
  );

  yield* check(
    'location search "Denver"',
    Effect.gen(function* () {
      const options = yield* marketplace.searchLocations('Denver');
      const denver = options.find((o) => o.id === DENVER_ID);
      if (!denver) {
        return yield* new SmokeFailure({ message: `Denver, Colorado (${DENVER_ID}) missing from ${options.map((o) => o.name).join(', ')}` });
      }
      yield* ensure(denver.name === 'Denver, Colorado', `unexpected name ${denver.name}`);
      return `${options.length} options, first "${options[0]?.name ?? ''}"`;
    }),
  );

  yield* check(
    'first page only, with a city page id (Denver)',
    Effect.gen(function* () {
      const page = yield* marketplace.searchFirstPage(profile, { location: DENVER_ID, query: 'desk' });
      yield* ensure(page.sessionId === null && !page.hasMore, 'searchFirstPage kept a session');
      yield* ensure(page.listings.length > 0, 'no listings');
      yield* ensureWellFormed(page.listings);
      yield* ensure(page.location?.name === 'Denver, Colorado', `location is ${page.location?.name ?? 'none'}`);
      return `${page.listings.length} listings near ${page.location?.name ?? '?'}`;
    }),
  );

  yield* check(
    'category browse (nyc bicycles)',
    Effect.gen(function* () {
      const page = yield* marketplace.search(profile, { location: 'nyc', category: 'bicycles' });
      if (page.sessionId !== null) yield* marketplace.closeSession(profile, page.sessionId);
      yield* ensure(page.listings.length >= 5, `only ${page.listings.length} listings`);
      yield* ensureWellFormed(page.listings);
      const bikes = page.listings.filter((l) => l.categoryId === BICYCLES_CATEGORY_ID).length;
      return `${page.listings.length} listings, ${bikes} in Bicycles`;
    }),
  );

  yield* check(
    'nearby browse, no query (austin) + load more',
    Effect.gen(function* () {
      const page = yield* marketplace.search(profile, { location: 'austin' });
      yield* ensure(page.listings.length >= 5, `only ${page.listings.length} listings`);
      yield* ensureWellFormed(page.listings);
      if (page.sessionId === null) return yield* new SmokeFailure({ message: 'expected more pages' });
      const more = yield* marketplace.loadMore(profile, page.sessionId);
      if (more.sessionId !== null) yield* marketplace.closeSession(profile, more.sessionId);
      yield* ensure(more.listings.length > 0, 'load more returned nothing');
      yield* ensureWellFormed(more.listings);
      const ids = new Set(page.listings.map((l) => l.id));
      yield* ensure(more.listings.every((l) => !ids.has(l.id)), 'load more repeated listings');
      return `${page.listings.length} + ${more.listings.length} listings near ${page.location?.name ?? '?'}`;
    }),
  );

  yield* marketplace.closeAllSessions(profile);
  return yield* Ref.get(failures);
});

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'faceslop-smoke-'));
// Real environment variables win; these only fill in what isn't set.
const defaults = ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ FACESLOP_DATA_DIR: scratch, FACESLOP_DISABLE_CHECKER: '1' }));
const runtime = ManagedRuntime.make(Marketplace.layer.pipe(Layer.provide(defaults)));

let failures = 1;
try {
  failures = await runtime.runPromise(program);
} catch (error) {
  console.error('smoke run failed:', error);
} finally {
  await runtime.dispose();
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(failures > 0 ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures > 0 ? 1 : 0);
