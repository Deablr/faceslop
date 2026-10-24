// Sellers an owner blocked (`blocked_sellers`, one row per owner and seller). OWNER: server builder.
// Port of Store.*Seller*.
import '@tanstack/react-start/server-only';
import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient, SqlSchema } from 'effect/sql';
import { DatabaseLayer } from '@/server/db/Database';
import type { OwnerKey } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import type { BlockedSeller, BlockedSellerInput, FbId } from '@/shared/domain';

export interface BlockedSellersRepoShape {
  /** The owner's blocked sellers, newest first. */
  readonly list: (owner: OwnerKey) => Effect.Effect<readonly BlockedSeller[]>;
  /** Block (re-blocking updates the name, keeps blockedAt). */
  readonly block: (owner: OwnerKey, input: BlockedSellerInput, now: number) => Effect.Effect<BlockedSeller>;
  readonly unblock: (owner: OwnerKey, id: FbId) => Effect.Effect<boolean>;
  /** The owner's blocked seller ids, for local filtering. */
  readonly ids: (owner: OwnerKey) => Effect.Effect<ReadonlySet<string>>;
}

const BlockedRow = Schema.Struct({ id: Schema.String, name: Schema.String, blocked_at: Schema.Finite });
const toBlocked = (row: typeof BlockedRow.Type): BlockedSeller => ({ id: row.id, name: row.name, blockedAt: row.blocked_at });
const IdRow = Schema.Struct({ id: Schema.String });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows = SqlSchema.findAll({
    Request: Schema.String,
    Result: BlockedRow,
    execute: (owner) =>
      sql`SELECT id, name, blocked_at FROM blocked_sellers WHERE owner = ${owner} ORDER BY blocked_at DESC, rowid DESC`,
  });

  const list = Effect.fn('BlockedSellersRepo.list')(
    (owner: OwnerKey) => Effect.map(rows(owner), (all) => all.map(toBlocked)),
    Effect.orDie,
  );

  const upsert = SqlSchema.findOne({
    Request: Schema.Struct({ owner: Schema.String, id: Schema.String, name: Schema.String, now: Schema.Finite }),
    Result: BlockedRow,
    execute: ({ owner, id, name, now }) =>
      sql`INSERT INTO blocked_sellers (owner, id, name, blocked_at) VALUES (${owner}, ${id}, ${name}, ${now})
          ON CONFLICT (owner, id) DO UPDATE SET name = excluded.name
          RETURNING id, name, blocked_at`,
  });

  const block = Effect.fn('BlockedSellersRepo.block')(
    (owner: OwnerKey, input: BlockedSellerInput, now: number) =>
      Effect.map(upsert({ owner, id: input.id, name: input.name, now }), toBlocked),
    Effect.orDie,
  );

  const unblock = Effect.fn('BlockedSellersRepo.unblock')(
    (owner: OwnerKey, id: FbId) =>
      Effect.map(
        sql`DELETE FROM blocked_sellers WHERE owner = ${owner} AND id = ${id} RETURNING id`,
        (deleted) => deleted.length > 0,
      ),
    Effect.orDie,
  );

  const idRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: IdRow,
    execute: (owner) => sql`SELECT id FROM blocked_sellers WHERE owner = ${owner}`,
  });

  const ids = Effect.fn('BlockedSellersRepo.ids')(
    (owner: OwnerKey) => Effect.map(idRows(owner), (all): ReadonlySet<string> => new Set(all.map((row) => row.id))),
    Effect.orDie,
  );

  return BlockedSellersRepo.of({ list, block, unblock, ids });
});

export class BlockedSellersRepo extends Context.Service<BlockedSellersRepo, BlockedSellersRepoShape>()(
  'faceslop/server/BlockedSellersRepo',
) {
  static readonly layerStub = Layer.succeed(
    BlockedSellersRepo,
    BlockedSellersRepo.of({
      list: () => notImplemented('BlockedSellersRepo.list'),
      block: () => notImplemented('BlockedSellersRepo.block'),
      unblock: () => notImplemented('BlockedSellersRepo.unblock'),
      ids: () => notImplemented('BlockedSellersRepo.ids'),
    }),
  );

  /** Needs a SqlClient (tests provide DatabaseLayerMemory; see ./layers.ts). */
  static readonly layerNoDeps = Layer.effect(BlockedSellersRepo, make);

  /** The layer the app runs. */
  static readonly layer = BlockedSellersRepo.layerNoDeps.pipe(Layer.provide(DatabaseLayer));
}
