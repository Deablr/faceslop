// All six repositories (the five per-owner data repositories + ClientSessionsRepo) over one
// database, for tests (the app uses each repository's own `layer`, which provides the file
// database at AppConfig.databaseFile). OWNER: server builder.
//
//   it.effect('...', () => Effect.gen(function* () { ... }).pipe(Effect.provide(RepositoriesLayerMemory)))
//
// Every Effect.provide builds it afresh, so each test gets its own empty in-memory database.
import '@tanstack/react-start/server-only';
import { Layer } from 'effect';
import type { SqlClient } from 'effect/sql';
import { DatabaseLayerMemory } from '@/server/db/Database';
import { BlockedSellersRepo } from '@/server/db/repositories/BlockedSellersRepo';
import { ClientSessionsRepo } from '@/server/db/repositories/ClientSessionsRepo';
import { FavoritesRepo } from '@/server/db/repositories/FavoritesRepo';
import { HiddenListingsRepo } from '@/server/db/repositories/HiddenListingsRepo';
import { SavedSearchesRepo } from '@/server/db/repositories/SavedSearchesRepo';
import { SettingsRepo } from '@/server/db/repositories/SettingsRepo';

/** The repositories (and the SqlClient) over the given database layer. */
export const repositoriesFor = <ROut extends SqlClient.SqlClient, E>(database: Layer.Layer<ROut, E>) =>
  SavedSearchesRepo.layerNoDeps.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SettingsRepo.layerNoDeps,
        FavoritesRepo.layerNoDeps,
        HiddenListingsRepo.layerNoDeps,
        BlockedSellersRepo.layerNoDeps,
        ClientSessionsRepo.layerNoDeps,
      ),
    ),
    Layer.provideMerge(database),
  );

/** The repositories over a fresh, migrated in-memory database. */
export const RepositoriesLayerMemory = repositoriesFor(DatabaseLayerMemory);
