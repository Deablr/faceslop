// App settings (key/value rows in `settings`, one set per owner). OWNER: server builder.
// Port of Store.getSettings/updateSettings (legacy/src/server/db.ts): unknown keys and values that
// fail their check are ignored on read; missing keys fall back to DEFAULT_SETTINGS.
// Database failures are defects (Effect.orDie): repositories have no typed errors.
import '@tanstack/react-start/server-only';
import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient, SqlSchema } from 'effect/sql';
import { DatabaseLayer } from '@/server/db/Database';
import { StoredSettings, settingsPatchToJson } from '@/server/db/stored';
import type { OwnerKey } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import type { Settings, SettingsPatch } from '@/shared/domain';

export interface SettingsRepoShape {
  /** The owner's settings (DEFAULT_SETTINGS for keys they never set). */
  readonly get: (owner: OwnerKey) => Effect.Effect<Settings>;
  /** Merge an already-validated patch into the owner's settings and return the stored result. */
  readonly update: (owner: OwnerKey, patch: SettingsPatch) => Effect.Effect<Settings>;
  /** Every owner with at least one stored setting (the checker reads each one's interval). */
  readonly owners: Effect.Effect<readonly OwnerKey[]>;
}

const SettingRow = Schema.Struct({ key: Schema.String, value: Schema.String });
const OwnerRow = Schema.Struct({ owner: Schema.String });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decodeSettings = Schema.decodeUnknownEffect(StoredSettings);

  const rows = SqlSchema.findAll({
    Request: Schema.String,
    Result: SettingRow,
    execute: (owner) => sql`SELECT key, value FROM settings WHERE owner = ${owner}`,
  });

  const get = Effect.fn('SettingsRepo.get')(
    (owner: OwnerKey) =>
      rows(owner).pipe(
        Effect.map((all) => Object.fromEntries(all.map((row) => [row.key, row.value]))),
        Effect.flatMap(decodeSettings),
      ),
    Effect.orDie,
  );

  const update = Effect.fn('SettingsRepo.update')(function* (owner: OwnerKey, patch: SettingsPatch) {
    const values = Object.entries(settingsPatchToJson(patch));
    yield* sql.withTransaction(
      Effect.forEach(
        values,
        ([key, value]) =>
          sql`INSERT INTO settings (owner, key, value) VALUES (${owner}, ${key}, ${value})
              ON CONFLICT (owner, key) DO UPDATE SET value = excluded.value`,
        { discard: true },
      ),
    );
    return yield* get(owner);
  }, Effect.orDie);

  const owners = SqlSchema.findAll({
    Request: Schema.Void,
    Result: OwnerRow,
    execute: () => sql`SELECT DISTINCT owner FROM settings ORDER BY owner`,
  })(undefined).pipe(
    Effect.map((all) => all.map((row) => row.owner as OwnerKey)),
    Effect.orDie,
    Effect.withSpan('SettingsRepo.owners'),
  );

  return SettingsRepo.of({ get, update, owners });
});

export class SettingsRepo extends Context.Service<SettingsRepo, SettingsRepoShape>()('faceslop/server/SettingsRepo') {
  static readonly layerStub = Layer.succeed(
    SettingsRepo,
    SettingsRepo.of({
      get: () => notImplemented('SettingsRepo.get'),
      update: () => notImplemented('SettingsRepo.update'),
      owners: notImplemented('SettingsRepo.owners'),
    }),
  );

  /** Needs a SqlClient (tests provide DatabaseLayerMemory; see ./layers.ts). */
  static readonly layerNoDeps = Layer.effect(SettingsRepo, make);

  /** The layer the app runs. */
  static readonly layer = SettingsRepo.layerNoDeps.pipe(Layer.provide(DatabaseLayer));
}
