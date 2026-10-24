// Listings an owner hid (`hidden_listings`, one row per owner and listing). OWNER: server builder.
// Port of Store.*Hidden*.
import '@tanstack/react-start/server-only';
import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient, SqlSchema } from 'effect/sql';
import { DatabaseLayer } from '@/server/db/Database';
import type { OwnerKey } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import type { HiddenListing, HiddenListingInput, ListingId } from '@/shared/domain';

export interface HiddenListingsRepoShape {
  /** The owner's hidden listings, newest first. */
  readonly list: (owner: OwnerKey) => Effect.Effect<readonly HiddenListing[]>;
  /** Hide (re-hiding updates the title, keeps hiddenAt). */
  readonly hide: (owner: OwnerKey, input: HiddenListingInput, now: number) => Effect.Effect<HiddenListing>;
  readonly unhide: (owner: OwnerKey, id: ListingId) => Effect.Effect<boolean>;
  readonly clear: (owner: OwnerKey) => Effect.Effect<void>;
  /** The owner's hidden ids, for local filtering. */
  readonly ids: (owner: OwnerKey) => Effect.Effect<ReadonlySet<string>>;
}

const HiddenRow = Schema.Struct({ id: Schema.String, title: Schema.String, hidden_at: Schema.Finite });
const toHidden = (row: typeof HiddenRow.Type): HiddenListing => ({ id: row.id, title: row.title, hiddenAt: row.hidden_at });
const IdRow = Schema.Struct({ id: Schema.String });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows = SqlSchema.findAll({
    Request: Schema.String,
    Result: HiddenRow,
    execute: (owner) =>
      sql`SELECT id, title, hidden_at FROM hidden_listings WHERE owner = ${owner} ORDER BY hidden_at DESC, rowid DESC`,
  });

  const list = Effect.fn('HiddenListingsRepo.list')(
    (owner: OwnerKey) => Effect.map(rows(owner), (all) => all.map(toHidden)),
    Effect.orDie,
  );

  const upsert = SqlSchema.findOne({
    Request: Schema.Struct({ owner: Schema.String, id: Schema.String, title: Schema.String, now: Schema.Finite }),
    Result: HiddenRow,
    execute: ({ owner, id, title, now }) =>
      sql`INSERT INTO hidden_listings (owner, id, title, hidden_at) VALUES (${owner}, ${id}, ${title}, ${now})
          ON CONFLICT (owner, id) DO UPDATE SET title = excluded.title
          RETURNING id, title, hidden_at`,
  });

  const hide = Effect.fn('HiddenListingsRepo.hide')(
    (owner: OwnerKey, input: HiddenListingInput, now: number) =>
      Effect.map(upsert({ owner, id: input.id, title: input.title, now }), toHidden),
    Effect.orDie,
  );

  const unhide = Effect.fn('HiddenListingsRepo.unhide')(
    (owner: OwnerKey, id: ListingId) =>
      Effect.map(
        sql`DELETE FROM hidden_listings WHERE owner = ${owner} AND id = ${id} RETURNING id`,
        (deleted) => deleted.length > 0,
      ),
    Effect.orDie,
  );

  const clear = Effect.fn('HiddenListingsRepo.clear')(
    (owner: OwnerKey) => Effect.asVoid(sql`DELETE FROM hidden_listings WHERE owner = ${owner}`),
    Effect.orDie,
  );

  const idRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: IdRow,
    execute: (owner) => sql`SELECT id FROM hidden_listings WHERE owner = ${owner}`,
  });

  const ids = Effect.fn('HiddenListingsRepo.ids')(
    (owner: OwnerKey) => Effect.map(idRows(owner), (all): ReadonlySet<string> => new Set(all.map((row) => row.id))),
    Effect.orDie,
  );

  return HiddenListingsRepo.of({ list, hide, unhide, clear, ids });
});

export class HiddenListingsRepo extends Context.Service<HiddenListingsRepo, HiddenListingsRepoShape>()(
  'faceslop/server/HiddenListingsRepo',
) {
  static readonly layerStub = Layer.succeed(
    HiddenListingsRepo,
    HiddenListingsRepo.of({
      list: () => notImplemented('HiddenListingsRepo.list'),
      hide: () => notImplemented('HiddenListingsRepo.hide'),
      unhide: () => notImplemented('HiddenListingsRepo.unhide'),
      clear: () => notImplemented('HiddenListingsRepo.clear'),
      ids: () => notImplemented('HiddenListingsRepo.ids'),
    }),
  );

  /** Needs a SqlClient (tests provide DatabaseLayerMemory; see ./layers.ts). */
  static readonly layerNoDeps = Layer.effect(HiddenListingsRepo, make);

  /** The layer the app runs. */
  static readonly layer = HiddenListingsRepo.layerNoDeps.pipe(Layer.provide(DatabaseLayer));
}
