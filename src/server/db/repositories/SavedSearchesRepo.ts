// Saved searches and the listings each has seen (`saved_searches`, `saved_search_seen`).
// OWNER: server builder. Port of Store.*SavedSearch*, recordSeen, seenSince, markChecked,
// markViewed, markSeeded (legacy/src/server/db.ts).
//
// Every saved search belongs to an owner (see src/server/session/identity.ts). Methods that take
// an owner treat another owner's search as missing; the rest take ids that were already resolved
// through one of them (or listAll).
//
// `newCount` = listings first seen after lastViewedAt, after the owner's local filters (hidden
// listings, blocked sellers, excluded keywords), so the repository reads those too.
//
// Legacy ran "record a check" and "view the new listings" synchronously, so nothing could slip in
// between their statements. Here they are `recordCheck` / `viewNew`: one transaction each, with the
// timestamp read inside it (the SQLite client serializes transactions), so a background check and a
// "run now" can't interleave and lose a listing.
import '@tanstack/react-start/server-only';
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from 'effect';
import { SqlClient } from 'effect/sql';
import { DatabaseLayer } from '@/server/db/Database';
import { BlockedSellersRepo } from '@/server/db/repositories/BlockedSellersRepo';
import { HiddenListingsRepo } from '@/server/db/repositories/HiddenListingsRepo';
import { SettingsRepo } from '@/server/db/repositories/SettingsRepo';
import { ListingJson, SearchParamsJson, decodeRowsSkippingBad, listingToJson, searchParamsToJson } from '@/server/db/stored';
import { NO_LOCAL_FILTERS, applyLocalFilters, loadLocalFilters, type LocalFilters } from '@/server/filters';
import type { OwnerKey } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import {
  SavedSearchId,
  type ListingSummary,
  type SavedSearch,
  type SavedSearchInput,
  type SavedSearchPatch,
  type SearchParams,
} from '@/shared/domain';

/** What one recorded check did. */
export interface RecordedCheck {
  /** Listings recorded for the first time. */
  readonly added: number;
  /** True when this check recorded the search's baseline (nothing counts as new). */
  readonly seeded: boolean;
  /** first_seen_at of the added rows. */
  readonly at: number;
}

export interface SavedSearchesRepoShape {
  /** The owner's saved searches, newest first (newCount filtered with the owner's local filters). */
  readonly list: (owner: OwnerKey) => Effect.Effect<readonly SavedSearch[]>;
  /** None when the search doesn't exist or belongs to another owner (same for update/remove/viewNew). */
  readonly get: (owner: OwnerKey, id: SavedSearchId) => Effect.Effect<Option.Option<SavedSearch>>;
  readonly create: (owner: OwnerKey, input: SavedSearchInput, now: number) => Effect.Effect<SavedSearch>;
  /**
   * Apply a patch. Changing params forgets everything seen so far and marks the search unseeded
   * again (the next run records the new baseline). None when the search doesn't exist.
   */
  readonly update: (owner: OwnerKey, id: SavedSearchId, patch: SavedSearchPatch) => Effect.Effect<Option.Option<SavedSearch>>;
  /** True when a row was deleted (seen rows cascade). */
  readonly remove: (owner: OwnerKey, id: SavedSearchId) => Effect.Effect<boolean>;
  /** Every owner's saved searches (the background checker groups them by owner). */
  readonly listAll: Effect.Effect<readonly { readonly owner: OwnerKey; readonly search: SavedSearch }[]>;
  // The methods below take ids the caller already resolved through an owner-checked method (or
  // listAll), so they are not owner-checked again.
  /**
   * Record listings returned by a run. New ones get first_seen_at = now; already-seen ones keep
   * it but get fresh listing data. Returns how many were seen for the first time.
   */
  readonly recordSeen: (id: SavedSearchId, listings: readonly ListingSummary[], now: number) => Effect.Effect<number>;
  /** Listings first seen strictly after `since`, newest first (unfiltered). */
  readonly seenSince: (id: SavedSearchId, since: number) => Effect.Effect<readonly ListingSummary[]>;
  readonly markChecked: (id: SavedSearchId, at: number) => Effect.Effect<void>;
  readonly markViewed: (id: SavedSearchId, at: number) => Effect.Effect<void>;
  /** Mark the baseline recorded unless the user already viewed it. True when this call seeded it. */
  readonly markSeeded: (id: SavedSearchId, at: number) => Effect.Effect<boolean>;
  /**
   * One check's first page, recorded atomically at the current time (at least lastViewedAt + 1, so
   * what it adds always counts as new): unless the search was deleted
   * or its params changed since `searched` was read (the results would belong to other params),
   * recordSeen + markChecked + markSeeded. None when nothing was recorded.
   */
  readonly recordCheck: (
    searched: SavedSearch,
    listings: readonly ListingSummary[],
  ) => Effect.Effect<Option.Option<RecordedCheck>>;
  /**
   * View the owner's saved search atomically: the listings first seen after its lastViewedAt
   * (unfiltered, newest first), then lastViewedAt = now. An unseeded, missing or other owner's
   * search returns [] and is left as it is, so its next check still records a baseline.
   */
  readonly viewNew: (owner: OwnerKey, id: SavedSearchId) => Effect.Effect<readonly ListingSummary[]>;
}

/** Same search? Key order doesn't matter (clients may send keys in any order). */
export const sameSearchParams = (a: SearchParams, b: SearchParams): boolean => canonicalParams(a) === canonicalParams(b);

const canonicalParams = (params: SearchParams): string =>
  JSON.stringify(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const SavedSearchRow = Schema.Struct({
  id: SavedSearchId,
  owner: Schema.String,
  name: Schema.String,
  params_json: SearchParamsJson,
  auto_check: Schema.BooleanFromBit,
  created_at: Schema.Finite,
  last_checked_at: Schema.NullOr(Schema.Finite),
  last_viewed_at: Schema.NullOr(Schema.Finite),
});
type SavedSearchRow = typeof SavedSearchRow.Type;

const decodeSavedSearches = decodeRowsSkippingBad(SavedSearchRow);
const decodeListings = decodeRowsSkippingBad(Schema.Struct({ listing_json: ListingJson }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const filterServices = yield* Effect.context<HiddenListingsRepo | BlockedSellersRepo | SettingsRepo>();
  const localFilters = (owner: OwnerKey) => Effect.provideContext(loadLocalFilters(owner), filterServices);

  const columns = sql.literal('id, owner, name, params_json, auto_check, created_at, last_checked_at, last_viewed_at');

  const ownerRows = (owner: OwnerKey) =>
    Effect.map(
      sql`SELECT ${columns} FROM saved_searches WHERE owner = ${owner} ORDER BY created_at DESC, id DESC`,
      decodeSavedSearches,
    );

  const allRows = Effect.map(
    sql`SELECT ${columns} FROM saved_searches ORDER BY owner, created_at DESC, id DESC`,
    decodeSavedSearches,
  );

  /** Any owner's row (for ids that were already resolved). */
  const rowById = (id: SavedSearchId) =>
    Effect.map(sql`SELECT ${columns} FROM saved_searches WHERE id = ${id}`, (rows) => Arr.head(decodeSavedSearches(rows)));

  /** The owner's row; None for another owner's id. */
  const ownedRow = (owner: OwnerKey, id: SavedSearchId) =>
    Effect.map(sql`SELECT ${columns} FROM saved_searches WHERE id = ${id} AND owner = ${owner}`, (rows) =>
      Arr.head(decodeSavedSearches(rows)),
    );

  const seenSinceRows = (id: SavedSearchId, since: number) =>
    Effect.map(
      sql`SELECT listing_json FROM saved_search_seen
          WHERE saved_search_id = ${id} AND first_seen_at > ${since}
          ORDER BY first_seen_at DESC, rowid DESC`,
      (rows) => decodeListings(rows).map((row) => row.listing_json),
    );

  const toSavedSearch = (row: SavedSearchRow, filters: LocalFilters) =>
    Effect.map(
      row.last_viewed_at === null ? Effect.succeed([]) : seenSinceRows(row.id, row.last_viewed_at),
      (unseen): SavedSearch => ({
        id: row.id,
        name: row.name,
        params: row.params_json,
        createdAt: row.created_at,
        autoCheck: row.auto_check,
        lastCheckedAt: row.last_checked_at,
        lastViewedAt: row.last_viewed_at,
        newCount: applyLocalFilters(unseen, filters).kept.length,
      }),
    );

  /** One owner's rows as SavedSearches (their local filters are read once). */
  const withNewCounts = (owner: OwnerKey, rows: readonly SavedSearchRow[]) =>
    rows.length === 0
      ? Effect.succeed([])
      : Effect.flatMap(localFilters(owner), (filters) => Effect.forEach(rows, (row) => toSavedSearch(row, filters)));

  const list = Effect.fn('SavedSearchesRepo.list')(
    (owner: OwnerKey) => Effect.flatMap(ownerRows(owner), (rows) => withNewCounts(owner, rows)),
    Effect.orDie,
  );

  const get = Effect.fn('SavedSearchesRepo.get')(
    (owner: OwnerKey, id: SavedSearchId) =>
      Effect.flatMap(ownedRow(owner, id), (row) =>
        Option.isNone(row) ? Effect.succeedNone : Effect.map(withNewCounts(owner, [row.value]), Arr.head),
      ),
    Effect.orDie,
  );

  const listAll = allRows.pipe(
    Effect.flatMap((rows) => {
      // Rows come ordered by owner; each owner's filters are read once.
      const byOwner = Arr.groupBy(rows, (row) => row.owner);
      return Effect.forEach(Object.entries(byOwner), ([owner, owned]) =>
        Effect.map(withNewCounts(owner as OwnerKey, owned), (searches) =>
          searches.map((search) => ({ owner: owner as OwnerKey, search })),
        ),
      );
    }),
    Effect.map((groups) => groups.flat()),
    Effect.orDie,
    Effect.withSpan('SavedSearchesRepo.listAll'),
  );

  const create = Effect.fn('SavedSearchesRepo.create')(function* (owner: OwnerKey, input: SavedSearchInput, now: number) {
    const rows = yield* sql`
      INSERT INTO saved_searches (owner, name, params_json, auto_check, created_at)
      VALUES (${owner}, ${input.name}, ${searchParamsToJson(input.params)}, ${input.autoCheck ? 1 : 0}, ${now})
      RETURNING ${columns}`;
    const created = yield* Schema.decodeUnknownEffect(SavedSearchRow)(rows[0]);
    // Nothing is seen yet (lastViewedAt is null), so newCount is 0 without reading the filters.
    return yield* toSavedSearch(created, NO_LOCAL_FILTERS);
  }, Effect.orDie);

  const update = Effect.fn('SavedSearchesRepo.update')(function* (
    owner: OwnerKey,
    id: SavedSearchId,
    patch: SavedSearchPatch,
  ) {
    const updated = yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* ownedRow(owner, id);
        if (Option.isNone(existing)) return false;
        const before = existing.value;
        const params = patch.params ?? before.params_json;
        yield* sql`UPDATE saved_searches
                   SET name = ${patch.name ?? before.name},
                       params_json = ${searchParamsToJson(params)},
                       auto_check = ${(patch.autoCheck ?? before.auto_check) ? 1 : 0}
                   WHERE id = ${id}`;
        if (!sameSearchParams(params, before.params_json)) {
          // New params: what was seen belongs to the old search. The next check records a baseline.
          yield* sql`DELETE FROM saved_search_seen WHERE saved_search_id = ${id}`;
          yield* sql`UPDATE saved_searches SET last_viewed_at = NULL, last_checked_at = NULL WHERE id = ${id}`;
        }
        return true;
      }),
    );
    return updated ? yield* get(owner, id) : Option.none<SavedSearch>();
  }, Effect.orDie);

  const remove = Effect.fn('SavedSearchesRepo.remove')(
    (owner: OwnerKey, id: SavedSearchId) =>
      Effect.map(
        sql`DELETE FROM saved_searches WHERE id = ${id} AND owner = ${owner} RETURNING id`,
        (rows) => rows.length > 0,
      ),
    Effect.orDie,
  );

  /** Insert-or-refresh each listing; the number inserted. Several statements: run it inside a transaction. */
  const insertSeen = Effect.fnUntraced(function* (id: SavedSearchId, listings: readonly ListingSummary[], now: number) {
    let added = 0;
    for (const listing of listings) {
      const json = listingToJson(listing);
      const inserted = yield* sql`
        INSERT INTO saved_search_seen (saved_search_id, listing_id, first_seen_at, listing_json)
        VALUES (${id}, ${listing.id}, ${now}, ${json})
        ON CONFLICT (saved_search_id, listing_id) DO NOTHING
        RETURNING listing_id`;
      if (inserted.length > 0) {
        added++;
      } else {
        // Already seen: keep first_seen_at, refresh the listing data (price, status, title).
        yield* sql`UPDATE saved_search_seen SET listing_json = ${json}
                   WHERE saved_search_id = ${id} AND listing_id = ${listing.id}`;
      }
    }
    return added;
  });

  const recordSeen = Effect.fn('SavedSearchesRepo.recordSeen')(
    (id: SavedSearchId, listings: readonly ListingSummary[], now: number) => sql.withTransaction(insertSeen(id, listings, now)),
    Effect.orDie,
  );

  const seenSince = Effect.fn('SavedSearchesRepo.seenSince')(seenSinceRows, Effect.orDie);

  const markChecked = Effect.fn('SavedSearchesRepo.markChecked')(
    (id: SavedSearchId, at: number) => Effect.asVoid(sql`UPDATE saved_searches SET last_checked_at = ${at} WHERE id = ${id}`),
    Effect.orDie,
  );

  const markViewed = Effect.fn('SavedSearchesRepo.markViewed')(
    (id: SavedSearchId, at: number) => Effect.asVoid(sql`UPDATE saved_searches SET last_viewed_at = ${at} WHERE id = ${id}`),
    Effect.orDie,
  );

  const markSeededRows = (id: SavedSearchId, at: number) =>
    Effect.map(
      sql`UPDATE saved_searches SET last_viewed_at = ${at}
          WHERE id = ${id} AND last_viewed_at IS NULL
          RETURNING id`,
      (rows) => rows.length > 0,
    );

  const markSeeded = Effect.fn('SavedSearchesRepo.markSeeded')(markSeededRows, Effect.orDie);

  const recordCheck = Effect.fn('SavedSearchesRepo.recordCheck')(
    (searched: SavedSearch, listings: readonly ListingSummary[]) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* rowById(searched.id);
          if (Option.isNone(current) || !sameSearchParams(current.value.params_json, searched.params)) {
            return Option.none<RecordedCheck>();
          }
          // New rows count as new when first_seen_at > lastViewedAt. Recorded in the same
          // millisecond as the last view (or after the clock stepped back), they would never be
          // reported, so they get at least lastViewedAt + 1.
          const lastViewedAt = current.value.last_viewed_at;
          const now = yield* Clock.currentTimeMillis;
          const at = lastViewedAt === null ? now : Math.max(now, lastViewedAt + 1);
          const added = yield* insertSeen(searched.id, listings, at);
          yield* sql`UPDATE saved_searches SET last_checked_at = ${at} WHERE id = ${searched.id}`;
          const seeded = yield* markSeededRows(searched.id, at);
          return Option.some<RecordedCheck>({ added, seeded, at });
        }),
      ),
    Effect.orDie,
  );

  const viewNew = Effect.fn('SavedSearchesRepo.viewNew')(
    (owner: OwnerKey, id: SavedSearchId) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* ownedRow(owner, id);
          const lastViewedAt = Option.flatMapNullishOr(current, (row) => row.last_viewed_at);
          if (Option.isNone(lastViewedAt)) return [];
          const unseen = yield* seenSinceRows(id, lastViewedAt.value);
          // Never earlier than what was just reported (the clock may have stepped back), so the
          // next view doesn't report it again.
          const now = yield* Clock.currentTimeMillis;
          yield* sql`UPDATE saved_searches
                     SET last_viewed_at = MAX(${now}, ${lastViewedAt.value}, COALESCE(
                       (SELECT MAX(first_seen_at) FROM saved_search_seen WHERE saved_search_id = ${id}), 0))
                     WHERE id = ${id}`;
          return unseen;
        }),
      ),
    Effect.orDie,
  );

  return SavedSearchesRepo.of({
    list,
    get,
    create,
    update,
    remove,
    listAll,
    recordSeen,
    seenSince,
    markChecked,
    markViewed,
    markSeeded,
    recordCheck,
    viewNew,
  });
});

export class SavedSearchesRepo extends Context.Service<SavedSearchesRepo, SavedSearchesRepoShape>()(
  'faceslop/server/SavedSearchesRepo',
) {
  static readonly layerStub = Layer.succeed(
    SavedSearchesRepo,
    SavedSearchesRepo.of({
      list: () => notImplemented('SavedSearchesRepo.list'),
      get: () => notImplemented('SavedSearchesRepo.get'),
      create: () => notImplemented('SavedSearchesRepo.create'),
      update: () => notImplemented('SavedSearchesRepo.update'),
      remove: () => notImplemented('SavedSearchesRepo.remove'),
      listAll: notImplemented('SavedSearchesRepo.listAll'),
      recordSeen: () => notImplemented('SavedSearchesRepo.recordSeen'),
      seenSince: () => notImplemented('SavedSearchesRepo.seenSince'),
      markChecked: () => notImplemented('SavedSearchesRepo.markChecked'),
      markViewed: () => notImplemented('SavedSearchesRepo.markViewed'),
      markSeeded: () => notImplemented('SavedSearchesRepo.markSeeded'),
      recordCheck: () => notImplemented('SavedSearchesRepo.recordCheck'),
      viewNew: () => notImplemented('SavedSearchesRepo.viewNew'),
    }),
  );

  /** Needs a SqlClient and the filter repositories (tests: see ./layers.ts). */
  static readonly layerNoDeps = Layer.effect(SavedSearchesRepo, make);

  /** The layer the app runs. */
  static readonly layer = SavedSearchesRepo.layerNoDeps.pipe(
    Layer.provide([DatabaseLayer, HiddenListingsRepo.layer, BlockedSellersRepo.layer, SettingsRepo.layer]),
  );
}
