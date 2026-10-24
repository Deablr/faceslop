// The convention every service relies on: each service's `layer` provides its own dependencies,
// and a shared dependency is built once per runtime because layers are memoized by reference.
// Also: the test database layer (RepositoriesLayerMemory) provides every repository.
import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import { describe, expect, it } from 'vitest';
import { RepositoriesLayerMemory } from '@/server/db/layers';
import { BlockedSellersRepo } from '@/server/db/repositories/BlockedSellersRepo';
import { ClientSessionsRepo } from '@/server/db/repositories/ClientSessionsRepo';
import { FavoritesRepo } from '@/server/db/repositories/FavoritesRepo';
import { HiddenListingsRepo } from '@/server/db/repositories/HiddenListingsRepo';
import { SavedSearchesRepo } from '@/server/db/repositories/SavedSearchesRepo';
import { SettingsRepo } from '@/server/db/repositories/SettingsRepo';
import { AppLayer } from '@/server/runtime';

describe('layer memoization', () => {
  it('builds a shared dependency once even when several service layers provide it', async () => {
    let builds = 0;
    class Shared extends Context.Service<Shared, { readonly id: number }>()('test/Shared') {
      static readonly layer = Layer.effect(
        Shared,
        Effect.sync(() => ({ id: ++builds })),
      );
    }
    class A extends Context.Service<A, { readonly shared: number }>()('test/A') {
      static readonly layer = Layer.effect(A, Effect.map(Shared, (s) => ({ shared: s.id }))).pipe(Layer.provide(Shared.layer));
    }
    class B extends Context.Service<B, { readonly shared: number }>()('test/B') {
      static readonly layer = Layer.effect(B, Effect.map(Shared, (s) => ({ shared: s.id }))).pipe(Layer.provide(Shared.layer));
    }
    const runtime = ManagedRuntime.make(Layer.mergeAll(A.layer, B.layer));
    const [a, b] = await runtime.runPromise(Effect.all([A, B]));
    await runtime.dispose();
    expect(builds).toBe(1);
    expect(a.shared).toBe(b.shared);
  });

  it('AppLayer has no unmet requirements (compile-time) and is a single Layer value', () => {
    const layer: Layer.Layer<Layer.Success<typeof AppLayer>, Layer.Error<typeof AppLayer>> = AppLayer;
    expect(Layer.isLayer(layer)).toBe(true);
  });

  it('RepositoriesLayerMemory provides every repository over one fresh database', async () => {
    const owners = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.all([SettingsRepo, FavoritesRepo, HiddenListingsRepo, BlockedSellersRepo, SavedSearchesRepo]);
        return yield* ClientSessionsRepo.use((repo) => repo.activeOwners(0));
      }).pipe(Effect.provide(RepositoriesLayerMemory)),
    );
    expect(owners).toEqual([]);
  });
});
