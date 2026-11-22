// Group watches and the posts each has seen (`group_watches`, `group_watch_posts`).
//
// Every watch belongs to an owner (an account: groups need a Facebook login) and there is at most
// one per owner and group. Methods that take an owner treat another owner's watch as missing; the
// rest take ids already resolved through one of them (or listAll).
//
// A check is recorded atomically (`recordCheck`): the first one of a watch records its baseline
// (everything seen, nothing matches); later ones record the posts not seen before and, for those
// that match (the caller's `matchOf`), the post itself and the keywords it matched; the caller's
// `onMatches` (queueing the webhooks) runs in the same transaction, so a match is never recorded
// without its deliveries. Seen rows are kept for SEEN_RETENTION_MS (a post Facebook shows again,
// say a pinned one, must not count as new); beyond the newest MATCHES_KEPT matches of a watch,
// older matches become plain seen rows (their stored post is dropped).
import '@tanstack/react-start/server-only';
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from 'effect';
import { SqlClient } from 'effect/sql';
import { DatabaseLayer } from '@/server/db/Database';
import { decodeRowsSkippingBad } from '@/server/db/stored';
import type { OwnerKey } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import {
  GroupPost,
  GroupWatchId,
  type GroupWatch,
  type GroupWatchInput,
  type GroupWatchMatch,
  type GroupWatchPatch,
} from '@/shared/domain';

export const SEEN_RETENTION_MS = 180 * 24 * 60 * 60_000;
export const MATCHES_KEPT = 200;
/** How many of the most recently seen post ids a check compares against. */
export const RECENT_SEEN_LIMIT = 500;

/** What one recorded check did. */
export interface RecordedWatchCheck {
  /** True when this check recorded the watch's baseline (nothing counts as new). */
  readonly seeded: boolean;
  /** Posts seen for the first time (none when seeded). */
  readonly added: readonly GroupPost[];
  /** Of those, the matches (as stored). */
  readonly matches: readonly GroupWatchMatch[];
  readonly at: number;
}

export interface GroupWatchesRepoShape {
  /** The owner's watches, newest first. */
  readonly list: (owner: OwnerKey) => Effect.Effect<readonly GroupWatch[]>;
  /** None when it doesn't exist or is another owner's (same for update/remove/matches/viewMatches). */
  readonly get: (owner: OwnerKey, id: GroupWatchId) => Effect.Effect<Option.Option<GroupWatch>>;
  /** None when the owner already watches that group. */
  readonly create: (owner: OwnerKey, input: GroupWatchInput, now: number) => Effect.Effect<Option.Option<GroupWatch>>;
  readonly update: (owner: OwnerKey, id: GroupWatchId, patch: GroupWatchPatch) => Effect.Effect<Option.Option<GroupWatch>>;
  /** True when a row was deleted (seen posts cascade). */
  readonly remove: (owner: OwnerKey, id: GroupWatchId) => Effect.Effect<boolean>;
  /** Every owner's watches (the watcher). */
  readonly listAll: Effect.Effect<readonly { readonly owner: OwnerKey; readonly watch: GroupWatch }[]>;
  /** The most recently seen post ids of a watch (at most RECENT_SEEN_LIMIT). */
  readonly recentSeenIds: (id: GroupWatchId) => Effect.Effect<ReadonlySet<string>>;
  /**
   * Record one check's posts at the current time. None when the watch was deleted meanwhile.
   * `matchOf` decides, for each post not seen before, the keywords it matched (null: no match);
   * `onMatches` gets the new matches inside the same transaction (not called while seeding).
   */
  readonly recordCheck: (
    id: GroupWatchId,
    posts: readonly GroupPost[],
    matchOf: (post: GroupPost) => readonly string[] | null,
    onMatches: (matches: readonly GroupWatchMatch[]) => Effect.Effect<void>,
  ) => Effect.Effect<Option.Option<RecordedWatchCheck>>;
  /** A failed check: when, and why (shown on the watch until a check succeeds). */
  readonly markFailed: (id: GroupWatchId, at: number, error: string) => Effect.Effect<void>;
  /** The owner's matches for a watch, newest first. */
  readonly matches: (owner: OwnerKey, id: GroupWatchId, limit: number) => Effect.Effect<readonly GroupWatchMatch[]>;
  /**
   * Mark the watch's matches seen up to `upTo` (the newest matchedAt the user was shown), so a
   * match recorded meanwhile still counts as new. False when the watch doesn't exist.
   */
  readonly viewMatches: (owner: OwnerKey, id: GroupWatchId, upTo: number) => Effect.Effect<boolean>;
  /** Drop seen rows older than SEEN_RETENTION_MS; matches beyond the newest MATCHES_KEPT become plain seen rows. */
  readonly prune: (now: number) => Effect.Effect<void>;
}

const KeywordsJson = Schema.fromJsonString(Schema.Array(Schema.String)).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some([]))));
const encodeKeywords = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const PostJson = Schema.fromJsonString(GroupPost);
const encodePost = Schema.encodeSync(PostJson);

const WatchRow = Schema.Struct({
  id: GroupWatchId,
  owner: Schema.String,
  group_id: Schema.String,
  group_name: Schema.String,
  keywords_json: KeywordsJson,
  exclude_keywords_json: KeywordsJson,
  interval_minutes: Schema.Int,
  enabled: Schema.BooleanFromBit,
  created_at: Schema.Finite,
  last_checked_at: Schema.NullOr(Schema.Finite),
  last_error: Schema.NullOr(Schema.String),
  seeded_at: Schema.NullOr(Schema.Finite),
  matches_viewed_at: Schema.NullOr(Schema.Finite),
  new_matches: Schema.Int,
});
type WatchRow = typeof WatchRow.Type;

const decodeWatches = decodeRowsSkippingBad(WatchRow);
const decodeMatches = decodeRowsSkippingBad(
  Schema.Struct({ watch_id: GroupWatchId, post_json: PostJson, matched_keywords_json: KeywordsJson, first_seen_at: Schema.Finite }),
);
const decodeIds = decodeRowsSkippingBad(Schema.Struct({ post_id: Schema.String }));

const toWatch = (row: WatchRow): GroupWatch => ({
  id: row.id,
  groupId: row.group_id,
  groupName: row.group_name,
  keywords: row.keywords_json,
  excludeKeywords: row.exclude_keywords_json,
  intervalMinutes: row.interval_minutes,
  enabled: row.enabled,
  createdAt: row.created_at,
  lastCheckedAt: row.last_checked_at,
  lastError: row.last_error,
  seeded: row.seeded_at !== null,
  newMatchCount: row.new_matches,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = sql.literal(`w.id, w.owner, w.group_id, w.group_name, w.keywords_json, w.exclude_keywords_json,
    w.interval_minutes, w.enabled, w.created_at, w.last_checked_at, w.last_error, w.seeded_at, w.matches_viewed_at,
    (SELECT COUNT(*) FROM group_watch_posts p
      WHERE p.watch_id = w.id AND p.matched_keywords_json IS NOT NULL
        AND p.first_seen_at > COALESCE(w.matches_viewed_at, 0)) AS new_matches`);

  const ownedRow = (owner: OwnerKey, id: GroupWatchId) =>
    Effect.map(sql`SELECT ${columns} FROM group_watches w WHERE w.id = ${id} AND w.owner = ${owner}`, (rows) =>
      Arr.head(decodeWatches(rows)),
    );
  const rowById = (id: GroupWatchId) =>
    Effect.map(sql`SELECT ${columns} FROM group_watches w WHERE w.id = ${id}`, (rows) => Arr.head(decodeWatches(rows)));

  const list = Effect.fn('GroupWatchesRepo.list')(
    (owner: OwnerKey) =>
      Effect.map(sql`SELECT ${columns} FROM group_watches w WHERE w.owner = ${owner} ORDER BY w.created_at DESC, w.id DESC`, (rows) =>
        decodeWatches(rows).map(toWatch),
      ),
    Effect.orDie,
  );

  const get = Effect.fn('GroupWatchesRepo.get')(
    (owner: OwnerKey, id: GroupWatchId) => Effect.map(ownedRow(owner, id), Option.map(toWatch)),
    Effect.orDie,
  );

  const create = Effect.fn('GroupWatchesRepo.create')(function* (owner: OwnerKey, input: GroupWatchInput, now: number) {
    const inserted = yield* sql`
      INSERT INTO group_watches (owner, group_id, group_name, keywords_json, exclude_keywords_json, interval_minutes, enabled, created_at)
      VALUES (${owner}, ${input.groupId}, ${input.groupName}, ${encodeKeywords(input.keywords)},
              ${encodeKeywords(input.excludeKeywords)}, ${input.intervalMinutes}, ${input.enabled ? 1 : 0}, ${now})
      ON CONFLICT (owner, group_id) DO NOTHING
      RETURNING id`;
    const id = Arr.head(decodeRowsSkippingBad(Schema.Struct({ id: GroupWatchId }))(inserted));
    if (Option.isNone(id)) return Option.none<GroupWatch>();
    return Option.map(yield* rowById(id.value.id), toWatch);
  }, Effect.orDie);

  const update = Effect.fn('GroupWatchesRepo.update')(function* (owner: OwnerKey, id: GroupWatchId, patch: GroupWatchPatch) {
    const existing = yield* ownedRow(owner, id);
    if (Option.isNone(existing)) return Option.none<GroupWatch>();
    const before = existing.value;
    yield* sql`UPDATE group_watches
               SET keywords_json = ${encodeKeywords(patch.keywords ?? before.keywords_json)},
                   exclude_keywords_json = ${encodeKeywords(patch.excludeKeywords ?? before.exclude_keywords_json)},
                   interval_minutes = ${patch.intervalMinutes ?? before.interval_minutes},
                   enabled = ${(patch.enabled ?? before.enabled) ? 1 : 0}
               WHERE id = ${id}`;
    return yield* get(owner, id);
  }, Effect.orDie);

  const remove = Effect.fn('GroupWatchesRepo.remove')(
    (owner: OwnerKey, id: GroupWatchId) =>
      Effect.map(sql`DELETE FROM group_watches WHERE id = ${id} AND owner = ${owner} RETURNING id`, (rows) => rows.length > 0),
    Effect.orDie,
  );

  const listAll = Effect.map(sql`SELECT ${columns} FROM group_watches w ORDER BY w.owner, w.created_at`, (rows) =>
    decodeWatches(rows).map((row) => ({ owner: row.owner as OwnerKey, watch: toWatch(row) })),
  ).pipe(Effect.orDie, Effect.withSpan('GroupWatchesRepo.listAll'));

  const recentSeenIds = Effect.fn('GroupWatchesRepo.recentSeenIds')(
    (id: GroupWatchId) =>
      Effect.map(
        sql`SELECT post_id FROM group_watch_posts WHERE watch_id = ${id}
            ORDER BY first_seen_at DESC, rowid DESC LIMIT ${RECENT_SEEN_LIMIT}`,
        (rows): ReadonlySet<string> => new Set(decodeIds(rows).map((row) => row.post_id)),
      ),
    Effect.orDie,
  );

  const recordCheck = Effect.fn('GroupWatchesRepo.recordCheck')(
    (
      id: GroupWatchId,
      posts: readonly GroupPost[],
      matchOf: (post: GroupPost) => readonly string[] | null,
      onMatches: (matches: readonly GroupWatchMatch[]) => Effect.Effect<void>,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* rowById(id);
          if (Option.isNone(current)) return Option.none<RecordedWatchCheck>();
          const watch = current.value;
          // Never at or before the last view: what this check matches must count as new.
          const now = yield* Clock.currentTimeMillis;
          const at = Math.max(now, (watch.matches_viewed_at ?? 0) + 1);
          const seeding = watch.seeded_at === null;
          const added: GroupPost[] = [];
          const matches: GroupWatchMatch[] = [];
          for (const post of posts) {
            const keywords = seeding ? null : matchOf(post);
            const inserted = yield* sql`
              INSERT INTO group_watch_posts (watch_id, post_id, first_seen_at, matched_keywords_json, post_json)
              VALUES (${id}, ${post.id}, ${at}, ${keywords === null ? null : encodeKeywords(keywords)},
                      ${keywords === null ? null : encodePost(post)})
              ON CONFLICT (watch_id, post_id) DO NOTHING
              RETURNING post_id`;
            if (inserted.length === 0 || seeding) continue;
            added.push(post);
            if (keywords !== null) matches.push({ watchId: id, post, matchedKeywords: keywords, matchedAt: at });
          }
          yield* sql`UPDATE group_watches
                     SET last_checked_at = ${at}, last_error = NULL,
                         seeded_at = COALESCE(seeded_at, ${at}),
                         matches_viewed_at = COALESCE(matches_viewed_at, ${at})
                     WHERE id = ${id}`;
          if (matches.length > 0) yield* onMatches(matches);
          return Option.some<RecordedWatchCheck>({ seeded: seeding, added, matches, at });
        }),
      ),
    Effect.orDie,
  );

  const markFailed = Effect.fn('GroupWatchesRepo.markFailed')(
    (id: GroupWatchId, at: number, error: string) =>
      Effect.asVoid(sql`UPDATE group_watches SET last_checked_at = ${at}, last_error = ${error.slice(0, 500)} WHERE id = ${id}`),
    Effect.orDie,
  );

  const matches = Effect.fn('GroupWatchesRepo.matches')(
    (owner: OwnerKey, id: GroupWatchId, limit: number) =>
      Effect.map(
        sql`SELECT p.watch_id, p.post_json, p.matched_keywords_json, p.first_seen_at
            FROM group_watch_posts p JOIN group_watches w ON w.id = p.watch_id
            WHERE p.watch_id = ${id} AND w.owner = ${owner} AND p.matched_keywords_json IS NOT NULL
            ORDER BY p.first_seen_at DESC, p.rowid DESC LIMIT ${limit}`,
        (rows) =>
          decodeMatches(rows).map(
            (row): GroupWatchMatch => ({
              watchId: row.watch_id,
              post: row.post_json,
              matchedKeywords: row.matched_keywords_json,
              matchedAt: row.first_seen_at,
            }),
          ),
      ),
    Effect.orDie,
  );

  const viewMatches = Effect.fn('GroupWatchesRepo.viewMatches')(
    (owner: OwnerKey, id: GroupWatchId, upTo: number) =>
      Effect.map(
        sql`UPDATE group_watches SET matches_viewed_at = MAX(COALESCE(matches_viewed_at, 0), ${upTo})
            WHERE id = ${id} AND owner = ${owner} RETURNING id`,
        (rows) => rows.length > 0,
      ),
    Effect.orDie,
  );

  const prune = Effect.fn('GroupWatchesRepo.prune')(
    (now: number) =>
      Effect.asVoid(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM group_watch_posts WHERE first_seen_at < ${now - SEEN_RETENTION_MS}`;
            yield* sql`UPDATE group_watch_posts SET matched_keywords_json = NULL, post_json = NULL
                       WHERE matched_keywords_json IS NOT NULL AND rowid NOT IN (
                         SELECT rowid FROM (
                           SELECT rowid, ROW_NUMBER() OVER (PARTITION BY watch_id ORDER BY first_seen_at DESC, rowid DESC) AS n
                           FROM group_watch_posts WHERE matched_keywords_json IS NOT NULL
                         ) WHERE n <= ${MATCHES_KEPT})`;
          }),
        ),
      ),
    Effect.orDie,
  );

  return GroupWatchesRepo.of({
    list,
    get,
    create,
    update,
    remove,
    listAll,
    recentSeenIds,
    recordCheck,
    markFailed,
    matches,
    viewMatches,
    prune,
  });
});

export class GroupWatchesRepo extends Context.Service<GroupWatchesRepo, GroupWatchesRepoShape>()('faceslop/server/GroupWatchesRepo') {
  static readonly layerStub = Layer.succeed(
    GroupWatchesRepo,
    GroupWatchesRepo.of({
      list: () => notImplemented('GroupWatchesRepo.list'),
      get: () => notImplemented('GroupWatchesRepo.get'),
      create: () => notImplemented('GroupWatchesRepo.create'),
      update: () => notImplemented('GroupWatchesRepo.update'),
      remove: () => notImplemented('GroupWatchesRepo.remove'),
      listAll: notImplemented('GroupWatchesRepo.listAll'),
      recentSeenIds: () => notImplemented('GroupWatchesRepo.recentSeenIds'),
      recordCheck: () => notImplemented('GroupWatchesRepo.recordCheck'),
      markFailed: () => notImplemented('GroupWatchesRepo.markFailed'),
      matches: () => notImplemented('GroupWatchesRepo.matches'),
      viewMatches: () => notImplemented('GroupWatchesRepo.viewMatches'),
      prune: () => notImplemented('GroupWatchesRepo.prune'),
    }),
  );

  /** Needs a SqlClient (tests: see ../layers.ts). */
  static readonly layerNoDeps = Layer.effect(GroupWatchesRepo, make);

  /** The layer the app runs. */
  static readonly layer = GroupWatchesRepo.layerNoDeps.pipe(Layer.provide(DatabaseLayer));
}
