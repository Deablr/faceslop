// The local SQLite database (built-in node:sqlite via @effect/sql-sqlite-node) at
// <FACESLOP_DATA_DIR>/faceslop.db, migrated on startup. OWNER: server builder.
//
// Everything the app remembers lives here: settings, favorites, saved searches (+ which listings
// each has seen), hidden listings, blocked sellers (each row has an `owner`: see
// src/server/session/identity.ts), browser sessions (`client_sessions`) and install-wide values
// (`meta`). Repositories (./repositories/*) depend on `SqlClient` from this layer.
//
// Migrations: append to `migrations` with the next id ("0003_add_x"); never edit an applied one.
// The first migration uses IF NOT EXISTS so a database created by legacy v1 (same tables) is adopted.
import '@tanstack/react-start/server-only';
import fs from 'node:fs/promises';
import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-node';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/sql';
import { AppConfig } from '@/server/config';

const statements = (...sql: readonly string[]) =>
  Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient;
    for (const statement of sql) yield* client.unsafe(statement);
  });

/**
 * Rebuild `table` with an `owner TEXT NOT NULL DEFAULT ''` column in front of `columns` (which
 * include the new primary key), copying every row with owner '' in rowid order (so "newest
 * first" ties still break the same way).
 */
const rebuildWithOwner = (table: string, columns: string, copied: string): readonly string[] => [
  `CREATE TABLE ${table}_multi_user (
      owner TEXT NOT NULL DEFAULT '',
      ${columns}
    )`,
  `INSERT INTO ${table}_multi_user (owner, ${copied}) SELECT '', ${copied} FROM ${table} ORDER BY rowid`,
  `DROP TABLE ${table}`,
  `ALTER TABLE ${table}_multi_user RENAME TO ${table}`,
];

/** Keyed "<id>_<name>"; run once each, in id order, inside a transaction. */
export const migrations = {
  '0001_initial': statements(
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS favorites (
      listing_id TEXT PRIMARY KEY,
      listing_json TEXT NOT NULL,
      original_price_json TEXT NOT NULL,
      note TEXT,
      saved_at INTEGER NOT NULL,
      last_checked_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS saved_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      params_json TEXT NOT NULL,
      auto_check INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_checked_at INTEGER,
      -- NULL until the first run has recorded what already exists ("seeded").
      last_viewed_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS saved_search_seen (
      saved_search_id INTEGER NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
      listing_id TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      listing_json TEXT NOT NULL,
      PRIMARY KEY (saved_search_id, listing_id)
    )`,
    `CREATE INDEX IF NOT EXISTS saved_search_seen_by_time ON saved_search_seen (saved_search_id, first_seen_at)`,
    `CREATE TABLE IF NOT EXISTS hidden_listings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      hidden_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS blocked_sellers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      blocked_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS app_sessions (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
  ),
  /**
   * Multi-user: every local data row gets an `owner` ("fb:<id>", "session:<id>"; existing rows get
   * '' = UNCLAIMED_OWNER, claimed by the first Facebook account that logs in). Tables keyed by
   * listing/seller/setting are rebuilt with the key widened to (owner, key) (SQLite can't alter a
   * primary key). saved_searches keeps its rows and ids (saved_search_seen references them) and
   * only gains the column. Old password unlocks (app_sessions) are dropped: everyone enters the
   * password once more and gets a client session.
   */
  '0002_multi_user': statements(
    ...rebuildWithOwner(
      'settings',
      `key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (owner, key)`,
      'key, value',
    ),
    ...rebuildWithOwner(
      'favorites',
      `listing_id TEXT NOT NULL,
      listing_json TEXT NOT NULL,
      original_price_json TEXT NOT NULL,
      note TEXT,
      saved_at INTEGER NOT NULL,
      last_checked_at INTEGER,
      PRIMARY KEY (owner, listing_id)`,
      'listing_id, listing_json, original_price_json, note, saved_at, last_checked_at',
    ),
    // The checker refreshes every owner's copy of a listing at once.
    `CREATE INDEX favorites_by_listing ON favorites (listing_id)`,
    ...rebuildWithOwner(
      'hidden_listings',
      `id TEXT NOT NULL,
      title TEXT NOT NULL,
      hidden_at INTEGER NOT NULL,
      PRIMARY KEY (owner, id)`,
      'id, title, hidden_at',
    ),
    ...rebuildWithOwner(
      'blocked_sellers',
      `id TEXT NOT NULL,
      name TEXT NOT NULL,
      blocked_at INTEGER NOT NULL,
      PRIMARY KEY (owner, id)`,
      'id, name, blocked_at',
    ),
    `ALTER TABLE saved_searches ADD COLUMN owner TEXT NOT NULL DEFAULT ''`,
    `CREATE INDEX saved_searches_by_owner ON saved_searches (owner, created_at)`,
    `DROP TABLE IF EXISTS app_sessions`,
    `CREATE TABLE client_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      -- Fingerprint of the APP_PASSWORD this browser entered; NULL while locked.
      unlocked_with TEXT,
      -- The Facebook account (c_user) this browser logged in with; NULL when not logged in.
      fb_user_id TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    )`,
    `CREATE INDEX client_sessions_by_account ON client_sessions (fb_user_id)`,
    `CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ),
};

/** SqlClient for a database file (or ':memory:'), with foreign keys on and all migrations applied. */
export const layerFor = (filename: string) =>
  SqliteMigrator.layer({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe('PRAGMA foreign_keys = ON')),
      ).pipe(Layer.provideMerge(SqliteClient.layer({ filename }))),
    ),
  );

/** The app database at AppConfig.databaseFile (data dir created with mode 0700). */
export const DatabaseLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    yield* Effect.promise(() => fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 }));
    return layerFor(config.databaseFile);
  }),
).pipe(Layer.provide(AppConfig.layer));

/** A fresh, migrated in-memory database (tests). */
export const DatabaseLayerMemory = layerFor(':memory:');
