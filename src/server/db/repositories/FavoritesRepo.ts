// Favorites (`favorites` table, one row per owner and listing). OWNER: server builder.
// Port of Store.*Favorite* (legacy/src/server/db.ts). Rows whose stored JSON is unusable are skipped.
// Two owners can save the same listing; the background refresh updates both copies at once.
import '@tanstack/react-start/server-only';
import { Array as Arr, Context, Effect, Layer, Schema, type Option } from 'effect';
import { SqlClient } from 'effect/sql';
import { DatabaseLayer } from '@/server/db/Database';
import { ListingJson, decodeRowsSkippingBad, listingToJson, priceFromJson, priceToJson } from '@/server/db/stored';
import type { OwnerKey } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import type { Favorite, FavoriteInput, ListingId, ListingSummary } from '@/shared/domain';

export interface FavoritesRepoShape {
  /** The owner's favorites, newest first. */
  readonly list: (owner: OwnerKey) => Effect.Effect<readonly Favorite[]>;
  readonly get: (owner: OwnerKey, listingId: ListingId) => Effect.Effect<Option.Option<Favorite>>;
  /** Save (or re-save). Re-saving refreshes the listing and note but keeps savedAt and originalPrice. */
  readonly save: (owner: OwnerKey, input: FavoriteInput, now: number) => Effect.Effect<Favorite>;
  /**
   * Background refresh of the owner's favorite: new listing data (price/status); originalPrice
   * untouched. Per owner: each owner's copy is refreshed from their own stored copy (it came from
   * their browser), never from another owner's. No-op when the owner no longer has it.
   */
  readonly updateListing: (owner: OwnerKey, listing: ListingSummary, checkedAt: number) => Effect.Effect<void>;
  /** True when a row was deleted. */
  readonly remove: (owner: OwnerKey, listingId: ListingId) => Effect.Effect<boolean>;
  /** Every owner's favorites (background refresh; the checker de-duplicates by listing id). */
  readonly listAll: Effect.Effect<readonly { readonly owner: OwnerKey; readonly favorite: Favorite }[]>;
}

const FavoriteRow = Schema.Struct({
  listing_json: ListingJson,
  original_price_json: Schema.String,
  note: Schema.NullOr(Schema.String),
  saved_at: Schema.Finite,
  last_checked_at: Schema.NullOr(Schema.Finite),
});

const toFavorite = (row: typeof FavoriteRow.Type): Favorite => ({
  listing: row.listing_json,
  savedAt: row.saved_at,
  originalPrice: priceFromJson(row.original_price_json, row.listing_json.price),
  lastCheckedAt: row.last_checked_at,
  note: row.note,
});

const OwnedFavoriteRow = Schema.Struct({ owner: Schema.String, ...FavoriteRow.fields });

const decodeFavorites = decodeRowsSkippingBad(FavoriteRow);
const decodeOwnedFavorites = decodeRowsSkippingBad(OwnedFavoriteRow);
const decodeFavorite = Schema.decodeUnknownEffect(FavoriteRow);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal('listing_json, original_price_json, note, saved_at, last_checked_at');

  const list = Effect.fn('FavoritesRepo.list')(
    (owner: OwnerKey) =>
      Effect.map(
        sql`SELECT ${columns} FROM favorites WHERE owner = ${owner} ORDER BY saved_at DESC, rowid DESC`,
        (rows) => decodeFavorites(rows).map(toFavorite),
      ),
    Effect.orDie,
  );

  const get = Effect.fn('FavoritesRepo.get')(
    (owner: OwnerKey, listingId: ListingId) =>
      Effect.map(sql`SELECT ${columns} FROM favorites WHERE owner = ${owner} AND listing_id = ${listingId}`, (rows) =>
        Arr.head(decodeFavorites(rows).map(toFavorite)),
      ),
    Effect.orDie,
  );

  const save = Effect.fn('FavoritesRepo.save')(function* (owner: OwnerKey, input: FavoriteInput, now: number) {
    const { listing, note } = input;
    const rows = yield* sql`
      INSERT INTO favorites (owner, listing_id, listing_json, original_price_json, note, saved_at)
      VALUES (${owner}, ${listing.id}, ${listingToJson(listing)}, ${priceToJson(listing.price)}, ${note}, ${now})
      ON CONFLICT (owner, listing_id) DO UPDATE SET listing_json = excluded.listing_json, note = excluded.note
      RETURNING ${columns}`;
    return toFavorite(yield* decodeFavorite(rows[0]));
  }, Effect.orDie);

  const updateListing = Effect.fn('FavoritesRepo.updateListing')(
    (owner: OwnerKey, listing: ListingSummary, checkedAt: number) =>
      sql`UPDATE favorites SET listing_json = ${listingToJson(listing)}, last_checked_at = ${checkedAt}
          WHERE owner = ${owner} AND listing_id = ${listing.id}`.pipe(Effect.asVoid),
    Effect.orDie,
  );

  const remove = Effect.fn('FavoritesRepo.remove')(
    (owner: OwnerKey, listingId: ListingId) =>
      Effect.map(
        sql`DELETE FROM favorites WHERE owner = ${owner} AND listing_id = ${listingId} RETURNING listing_id`,
        (rows) => rows.length > 0,
      ),
    Effect.orDie,
  );

  const listAll = sql`SELECT owner, ${columns} FROM favorites ORDER BY owner, saved_at DESC, rowid DESC`.pipe(
    Effect.map((rows) =>
      decodeOwnedFavorites(rows).map((row) => ({ owner: row.owner as OwnerKey, favorite: toFavorite(row) })),
    ),
    Effect.orDie,
    Effect.withSpan('FavoritesRepo.listAll'),
  );

  return FavoritesRepo.of({ list, get, save, updateListing, remove, listAll });
});

export class FavoritesRepo extends Context.Service<FavoritesRepo, FavoritesRepoShape>()('faceslop/server/FavoritesRepo') {
  static readonly layerStub = Layer.succeed(
    FavoritesRepo,
    FavoritesRepo.of({
      list: () => notImplemented('FavoritesRepo.list'),
      get: () => notImplemented('FavoritesRepo.get'),
      save: () => notImplemented('FavoritesRepo.save'),
      updateListing: () => notImplemented('FavoritesRepo.updateListing'),
      remove: () => notImplemented('FavoritesRepo.remove'),
      listAll: notImplemented('FavoritesRepo.listAll'),
    }),
  );

  /** Needs a SqlClient (tests provide DatabaseLayerMemory; see ./layers.ts). */
  static readonly layerNoDeps = Layer.effect(FavoritesRepo, make);

  /** The layer the app runs. */
  static readonly layer = FavoritesRepo.layerNoDeps.pipe(Layer.provide(DatabaseLayer));
}
