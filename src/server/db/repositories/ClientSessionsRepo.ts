// Browser sessions (`client_sessions`), install-wide values (`meta`), and moving local data between
// owners. Replaces AppSessionsRepo. Token SHA-256 hashes only, never raw tokens. OWNER: data builder.
//
// The Sessions service (src/server/session/Sessions.ts) keeps every session in memory and writes
// through to this table; the checker reads `activeOwners` from it. `reassignOwner` is how a
// browser's data follows it to the Facebook account it logs in with.
import '@tanstack/react-start/server-only';
import { Array as Arr, Context, Effect, Layer, Option, Schema } from 'effect';
import { SqlClient, SqlSchema } from 'effect/sql';
import { DatabaseLayer } from '@/server/db/Database';
import { sameSearchParams } from '@/server/db/repositories/SavedSearchesRepo';
import { SearchParamsJson } from '@/server/db/stored';
import type { ClientSessionId, FbUserId, OwnerKey } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';

export interface ClientSessionRow {
  readonly id: ClientSessionId;
  readonly tokenHash: string;
  /** Fingerprint of the APP_PASSWORD this session was unlocked with; null when locked. */
  readonly unlockedWith: string | null;
  readonly fbUserId: FbUserId | null;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

export interface ClientSessionsRepoShape {
  /** Every session (loaded once at startup). */
  readonly list: Effect.Effect<readonly ClientSessionRow[]>;
  readonly insert: (row: ClientSessionRow) => Effect.Effect<void>;
  /** Replace a session's token (unlock re-issues it). */
  readonly setTokenHash: (id: ClientSessionId, tokenHash: string) => Effect.Effect<void>;
  readonly setUnlockedWith: (id: ClientSessionId, fingerprint: string | null) => Effect.Effect<void>;
  readonly setAccount: (id: ClientSessionId, userId: FbUserId | null) => Effect.Effect<void>;
  /** Set last_seen_at (Sessions calls it at most daily, for unlocked sessions). */
  readonly touch: (id: ClientSessionId, at: number) => Effect.Effect<void>;
  readonly remove: (id: ClientSessionId) => Effect.Effect<void>;
  /**
   * Owners with local data whose browser was seen at or after `since`: "fb:<id>" for accounts with
   * at least one bound session seen since then, "session:<id>" for unbound sessions seen since then.
   * The background checker only works for these.
   */
  readonly activeOwners: (since: number) => Effect.Effect<readonly OwnerKey[]>;
  /**
   * Move every local data row (favorites, saved searches with their seen listings, hidden
   * listings, blocked sellers, settings) from one owner to another, in one transaction. Where both
   * owners have the same key (same setting, hidden listing, ...), the target's row wins and the
   * source's is dropped, except that a favorite keeps the earlier save's savedAt/originalPrice
   * (and a note either had), and a saved search with the same params as one of the target's is
   * dropped as a duplicate. Returns how many rows moved.
   */
  readonly reassignOwner: (from: OwnerKey, to: OwnerKey) => Effect.Effect<number>;
  /** True when rows from before multi-user support (UNCLAIMED_OWNER) still exist. */
  readonly hasUnclaimedData: Effect.Effect<boolean>;
  /** An install-wide value from `meta` (e.g. the unlock fingerprint salt). */
  readonly getMeta: (key: string) => Effect.Effect<Option.Option<string>>;
  /** Store `value` unless the key exists; returns the stored value either way. */
  readonly getOrInsertMeta: (key: string, value: string) => Effect.Effect<string>;
}

/**
 * How long a browser session counts as in use after it was last seen (`last_seen_at`, which
 * Sessions refreshes at most once a day, and only while the session is unlocked). The checker
 * only works for owners with such a session (activeOwners), and a Facebook logout elsewhere keeps
 * the account's cookies only for such sessions (Sessions.unbindAccount).
 */
export const ACTIVE_SESSION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Local data tables keyed by (owner, key): on a conflict, the target owner's row wins. */
const KEYED_TABLES = ['settings', 'favorites', 'hidden_listings', 'blocked_sellers'] as const;

const SessionRow = Schema.Struct({
  id: Schema.String,
  token_hash: Schema.String,
  unlocked_with: Schema.NullOr(Schema.String),
  fb_user_id: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
  last_seen_at: Schema.Finite,
});

const toRow = (row: typeof SessionRow.Type): ClientSessionRow => ({
  id: row.id as ClientSessionId,
  tokenHash: row.token_hash,
  unlockedWith: row.unlocked_with,
  fbUserId: row.fb_user_id as FbUserId | null,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
});

const OwnerRow = Schema.Struct({ owner: Schema.String });
const ValueRow = Schema.Struct({ value: Schema.String });
const FoundRow = Schema.Struct({ found: Schema.Number });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const list = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SessionRow,
    execute: () =>
      sql`SELECT id, token_hash, unlocked_with, fb_user_id, created_at, last_seen_at FROM client_sessions ORDER BY created_at, id`,
  })(undefined).pipe(
    Effect.map((rows) => rows.map(toRow)),
    Effect.orDie,
    Effect.withSpan('ClientSessionsRepo.list'),
  );

  const insert = Effect.fn('ClientSessionsRepo.insert')(
    (row: ClientSessionRow) =>
      Effect.asVoid(
        sql`INSERT INTO client_sessions (id, token_hash, unlocked_with, fb_user_id, created_at, last_seen_at)
            VALUES (${row.id}, ${row.tokenHash}, ${row.unlockedWith}, ${row.fbUserId}, ${row.createdAt}, ${row.lastSeenAt})`,
      ),
    Effect.orDie,
  );

  const setTokenHash = Effect.fn('ClientSessionsRepo.setTokenHash')(
    (id: ClientSessionId, tokenHash: string) =>
      Effect.asVoid(sql`UPDATE client_sessions SET token_hash = ${tokenHash} WHERE id = ${id}`),
    Effect.orDie,
  );

  const setUnlockedWith = Effect.fn('ClientSessionsRepo.setUnlockedWith')(
    (id: ClientSessionId, fingerprint: string | null) =>
      Effect.asVoid(sql`UPDATE client_sessions SET unlocked_with = ${fingerprint} WHERE id = ${id}`),
    Effect.orDie,
  );

  const setAccount = Effect.fn('ClientSessionsRepo.setAccount')(
    (id: ClientSessionId, userId: FbUserId | null) =>
      Effect.asVoid(sql`UPDATE client_sessions SET fb_user_id = ${userId} WHERE id = ${id}`),
    Effect.orDie,
  );

  const touch = Effect.fn('ClientSessionsRepo.touch')(
    (id: ClientSessionId, at: number) => Effect.asVoid(sql`UPDATE client_sessions SET last_seen_at = ${at} WHERE id = ${id}`),
    Effect.orDie,
  );

  const remove = Effect.fn('ClientSessionsRepo.remove')(
    (id: ClientSessionId) => Effect.asVoid(sql`DELETE FROM client_sessions WHERE id = ${id}`),
    Effect.orDie,
  );

  const activeOwnerRows = SqlSchema.findAll({
    Request: Schema.Finite,
    Result: OwnerRow,
    execute: (since) =>
      sql`SELECT DISTINCT CASE WHEN fb_user_id IS NULL THEN 'session:' || id ELSE 'fb:' || fb_user_id END AS owner
          FROM client_sessions
          WHERE last_seen_at >= ${since}
          ORDER BY owner`,
  });

  const activeOwners = Effect.fn('ClientSessionsRepo.activeOwners')(
    (since: number) => Effect.map(activeOwnerRows(since), (rows) => rows.map((row) => row.owner as OwnerKey)),
    Effect.orDie,
  );

  /** The number of rows a RETURNING statement touched. */
  const count = (statement: Effect.Effect<readonly unknown[], unknown>) => Effect.map(statement, (rows) => rows.length);

  const searchParamsOf = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.Finite, params_json: SearchParamsJson }),
    execute: (owner) => sql`SELECT id, params_json FROM saved_searches WHERE owner = ${owner}`,
  });

  const reassignOwner = Effect.fn('ClientSessionsRepo.reassignOwner')(
    (from: OwnerKey, to: OwnerKey) =>
      from === to
        ? Effect.succeed(0)
        : sql.withTransaction(
            Effect.gen(function* () {
              let moved = 0;
              // A favorite both owners saved keeps the EARLIER save (its savedAt and originalPrice
              // are the price-drop baseline) and any note; the merged row is then the target's.
              yield* sql`UPDATE favorites SET
                    saved_at = MIN(favorites.saved_at, source.saved_at),
                    original_price_json = CASE WHEN source.saved_at < favorites.saved_at
                      THEN source.original_price_json ELSE favorites.original_price_json END,
                    note = COALESCE(favorites.note, source.note)
                  FROM (SELECT listing_id, saved_at, original_price_json, note FROM favorites WHERE owner = ${from}) AS source
                  WHERE favorites.owner = ${to} AND favorites.listing_id = source.listing_id`;
              for (const table of KEYED_TABLES) {
                const name = sql.literal(table);
                // Rows whose key the target already has stay behind (OR IGNORE) and are dropped.
                moved += yield* count(sql`UPDATE OR IGNORE ${name} SET owner = ${to} WHERE owner = ${from} RETURNING owner`);
                yield* sql`DELETE FROM ${name} WHERE owner = ${from}`;
              }
              // Saved searches have their own ids; one with the same params as a target search is a
              // duplicate (the UI never lets an owner save one twice) and is dropped with its seen rows.
              const targetParams = (yield* searchParamsOf(to)).map((row) => row.params_json);
              const duplicates = (yield* searchParamsOf(from))
                .filter((row) => targetParams.some((params) => sameSearchParams(params, row.params_json)))
                .map((row) => row.id);
              for (const id of duplicates) yield* sql`DELETE FROM saved_searches WHERE id = ${id}`;
              // The rest move; their seen listings follow by id.
              moved += yield* count(sql`UPDATE saved_searches SET owner = ${to} WHERE owner = ${from} RETURNING owner`);
              return moved;
            }),
          ),
    Effect.orDie,
  );

  const hasUnclaimedData = SqlSchema.findOne({
    Request: Schema.Void,
    Result: FoundRow,
    execute: () =>
      sql`SELECT (EXISTS (SELECT 1 FROM settings WHERE owner = '')
               OR EXISTS (SELECT 1 FROM favorites WHERE owner = '')
               OR EXISTS (SELECT 1 FROM hidden_listings WHERE owner = '')
               OR EXISTS (SELECT 1 FROM blocked_sellers WHERE owner = '')
               OR EXISTS (SELECT 1 FROM saved_searches WHERE owner = '')) AS found`,
  })(undefined).pipe(
    Effect.map((row) => row.found !== 0),
    Effect.orDie,
    Effect.withSpan('ClientSessionsRepo.hasUnclaimedData'),
  );

  const metaRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: ValueRow,
    execute: (key) => sql`SELECT value FROM meta WHERE key = ${key}`,
  });
  const metaValue = (key: string) => Effect.map(metaRows(key), (rows) => Arr.head(rows.map((row) => row.value)));

  const getMeta = Effect.fn('ClientSessionsRepo.getMeta')(metaValue, Effect.orDie);

  const getOrInsertMeta = Effect.fn('ClientSessionsRepo.getOrInsertMeta')(
    (key: string, value: string) =>
      sql.withTransaction(
        Effect.andThen(
          sql`INSERT INTO meta (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO NOTHING`,
          Effect.map(metaValue(key), Option.getOrElse(() => value)),
        ),
      ),
    Effect.orDie,
  );

  return ClientSessionsRepo.of({
    list,
    insert,
    setTokenHash,
    setUnlockedWith,
    setAccount,
    touch,
    remove,
    activeOwners,
    reassignOwner,
    hasUnclaimedData,
    getMeta,
    getOrInsertMeta,
  });
});

export class ClientSessionsRepo extends Context.Service<ClientSessionsRepo, ClientSessionsRepoShape>()(
  'faceslop/server/ClientSessionsRepo',
) {
  static readonly layerStub = Layer.succeed(
    ClientSessionsRepo,
    ClientSessionsRepo.of({
      list: notImplemented('ClientSessionsRepo.list'),
      insert: () => notImplemented('ClientSessionsRepo.insert'),
      setTokenHash: () => notImplemented('ClientSessionsRepo.setTokenHash'),
      setUnlockedWith: () => notImplemented('ClientSessionsRepo.setUnlockedWith'),
      setAccount: () => notImplemented('ClientSessionsRepo.setAccount'),
      touch: () => notImplemented('ClientSessionsRepo.touch'),
      remove: () => notImplemented('ClientSessionsRepo.remove'),
      activeOwners: () => notImplemented('ClientSessionsRepo.activeOwners'),
      reassignOwner: () => notImplemented('ClientSessionsRepo.reassignOwner'),
      hasUnclaimedData: notImplemented('ClientSessionsRepo.hasUnclaimedData'),
      getMeta: () => notImplemented('ClientSessionsRepo.getMeta'),
      getOrInsertMeta: () => notImplemented('ClientSessionsRepo.getOrInsertMeta'),
    }),
  );

  /** Needs a SqlClient (tests provide DatabaseLayerMemory; see ../layers.ts). */
  static readonly layerNoDeps = Layer.effect(ClientSessionsRepo, make);

  /** The layer the app runs. */
  static readonly layer = ClientSessionsRepo.layerNoDeps.pipe(Layer.provide(DatabaseLayer));
}
