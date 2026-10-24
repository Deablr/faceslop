// The database layer: migrations from scratch, adopting a legacy v1 file, and the 0002 multi-user
// migration of a database that only had 0001 (every existing row ends up unclaimed: owner '').
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-node';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseLayerMemory, layerFor, migrations } from '@/server/db/Database';

const tables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
  return rows.map((row) => row.name);
});

const dirs: string[] = [];
const tempFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faceslop-db-'));
  dirs.push(dir);
  return path.join(dir, 'faceslop.db');
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Rows as plain objects (node:sqlite returns null-prototype objects). */
const plain = (rows: readonly unknown[]) => rows.map((row) => ({ ...(row as Record<string, unknown>) }));

describe('Database', () => {
  it('migrates a fresh database with foreign keys on', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fk = yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`;
        return { names: yield* tables, foreignKeys: fk[0]?.foreign_keys };
      }).pipe(Effect.provide(DatabaseLayerMemory)),
    );
    expect(result.foreignKeys).toBe(1);
    expect(result.names).toEqual(
      expect.arrayContaining([
        'blocked_sellers',
        'client_sessions',
        'favorites',
        'hidden_listings',
        'meta',
        'saved_search_seen',
        'saved_searches',
        'settings',
      ]),
    );
    expect(result.names).not.toContain('app_sessions');
  });

  it('adopts a database created by legacy v1 and is idempotent across restarts', async () => {
    const file = tempFile();
    // A legacy v1 database: same tables, PRAGMA user_version migrations, existing rows.
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings VALUES ('checkIntervalMinutes', '120');
      PRAGMA user_version = 1;`);
    legacy.close();

    const readSetting = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ owner: string; value: string }>`SELECT owner, value FROM settings WHERE key = 'checkIntervalMinutes'`;
    });
    for (let run = 0; run < 2; run++) {
      const rows = await Effect.runPromise(readSetting.pipe(Effect.provide(Layer.fresh(layerFor(file)))));
      expect(plain(rows)).toEqual([{ owner: '', value: '120' }]);
    }
  });

  it('0002_multi_user: keeps every row of a 0001 database, unclaimed (owner "")', async () => {
    const file = tempFile();
    // A database as the app left it before multi-user support: only 0001 applied.
    await Effect.runPromise(
      SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({ '0001_initial': migrations['0001_initial'] }) }).pipe(
        Effect.provide(Layer.fresh(SqliteClient.layer({ filename: file }))),
      ),
    );
    const before = new DatabaseSync(file);
    before.exec(`
      INSERT INTO settings VALUES ('checkIntervalMinutes', '30');
      INSERT INTO favorites VALUES ('11', '{"id":"11"}', '{"amount":1}', 'note', 100, 200);
      INSERT INTO favorites VALUES ('12', '{"id":"12"}', '{"amount":2}', NULL, 100, NULL);
      INSERT INTO saved_searches (name, params_json, auto_check, created_at, last_checked_at, last_viewed_at)
        VALUES ('Bikes', '{"query":"bike"}', 1, 50, 60, 70);
      INSERT INTO saved_search_seen VALUES (1, '11', 65, '{"id":"11"}');
      INSERT INTO hidden_listings VALUES ('21', 'Couch', 300);
      INSERT INTO blocked_sellers VALUES ('s1', 'Spammer', 400);
      INSERT INTO app_sessions VALUES ('hash', 1, 2);
    `);
    before.close();

    const dump = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return {
        names: yield* tables,
        settings: plain(yield* sql`SELECT * FROM settings`),
        favorites: plain(yield* sql`SELECT * FROM favorites ORDER BY rowid`),
        savedSearches: plain(yield* sql`SELECT id, owner, name, last_viewed_at FROM saved_searches`),
        seen: plain(yield* sql`SELECT saved_search_id, listing_id FROM saved_search_seen`),
        hidden: plain(yield* sql`SELECT * FROM hidden_listings`),
        blocked: plain(yield* sql`SELECT * FROM blocked_sellers`),
      };
    });
    const after = await Effect.runPromise(dump.pipe(Effect.provide(Layer.fresh(layerFor(file)))));

    expect(after.names).not.toContain('app_sessions');
    expect(after.names).toEqual(expect.arrayContaining(['client_sessions', 'meta']));
    expect(after.settings).toEqual([{ owner: '', key: 'checkIntervalMinutes', value: '30' }]);
    expect(after.favorites).toEqual([
      {
        owner: '',
        listing_id: '11',
        listing_json: '{"id":"11"}',
        original_price_json: '{"amount":1}',
        note: 'note',
        saved_at: 100,
        last_checked_at: 200,
      },
      {
        owner: '',
        listing_id: '12',
        listing_json: '{"id":"12"}',
        original_price_json: '{"amount":2}',
        note: null,
        saved_at: 100,
        last_checked_at: null,
      },
    ]);
    expect(after.savedSearches).toEqual([{ id: 1, owner: '', name: 'Bikes', last_viewed_at: 70 }]);
    expect(after.seen).toEqual([{ saved_search_id: 1, listing_id: '11' }]);
    expect(after.hidden).toEqual([{ owner: '', id: '21', title: 'Couch', hidden_at: 300 }]);
    expect(after.blocked).toEqual([{ owner: '', id: 's1', name: 'Spammer', blocked_at: 400 }]);

    // The widened keys: another owner can have the same listing/setting; the same owner can't.
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT INTO favorites (owner, listing_id, listing_json, original_price_json, saved_at) VALUES ('fb:1', '11', '{}', '{}', 1)").run();
    raw.prepare("INSERT INTO settings (owner, key, value) VALUES ('fb:1', 'checkIntervalMinutes', '15')").run();
    expect(() =>
      raw.prepare("INSERT INTO hidden_listings (owner, id, title, hidden_at) VALUES ('', '21', 'Again', 1)").run(),
    ).toThrow(/UNIQUE/);
    // Seen rows still cascade with their saved search.
    raw.exec('PRAGMA foreign_keys = ON');
    raw.prepare('DELETE FROM saved_searches WHERE id = 1').run();
    expect(raw.prepare('SELECT COUNT(*) AS n FROM saved_search_seen').get()).toEqual(expect.objectContaining({ n: 0 }));
    raw.close();
  });
});
