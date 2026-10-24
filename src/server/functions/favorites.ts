// Favorites (this browser's owner: see src/server/session/identity.ts).
// Legacy: GET /api/favorites, POST /api/favorites, DELETE /api/favorites/:listingId.
import { createServerFn } from '@tanstack/react-start';
import { Effect, Option } from 'effect';
import { runEffect, validate } from '@/server/bridge';
import { FavoritesRepo } from '@/server/db/repositories/FavoritesRepo';
import { currentOwner, ensureOwner } from '@/server/session/CurrentClient';
import { FavoriteInput, ListingIdRequest, OK, type Favorite } from '@/shared/domain';

export const listFavorites = createServerFn({ method: 'GET' }).handler(() =>
  runEffect(
    Effect.flatMap(currentOwner, (owner) =>
      Option.isNone(owner) ? Effect.succeed<readonly Favorite[]>([]) : FavoritesRepo.use((repo) => repo.list(owner.value)),
    ),
  ),
);

export const addFavorite = createServerFn({ method: 'POST' })
  .validator(validate(FavoriteInput))
  .handler(({ data }) =>
    runEffect(Effect.flatMap(ensureOwner, (owner) => FavoritesRepo.use((repo) => repo.save(owner, data, Date.now())))),
  );

export const removeFavorite = createServerFn({ method: 'POST' })
  .validator(validate(ListingIdRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.flatMap(ensureOwner, (owner) => FavoritesRepo.use((repo) => repo.remove(owner, data.listingId))).pipe(Effect.as(OK)),
    ),
  );
