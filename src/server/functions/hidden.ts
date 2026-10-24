// Hidden listings (this browser's owner: see src/server/session/identity.ts).
// Legacy: GET/POST/DELETE /api/hidden, DELETE /api/hidden/:id.
import { createServerFn } from '@tanstack/react-start';
import { Effect, Option } from 'effect';
import { runEffect, validate } from '@/server/bridge';
import { HiddenListingsRepo } from '@/server/db/repositories/HiddenListingsRepo';
import { currentOwner, ensureOwner } from '@/server/session/CurrentClient';
import { HiddenListingIdRequest, HiddenListingInput, OK, type HiddenListing } from '@/shared/domain';

export const listHidden = createServerFn({ method: 'GET' }).handler(() =>
  runEffect(
    Effect.flatMap(currentOwner, (owner) =>
      Option.isNone(owner)
        ? Effect.succeed<readonly HiddenListing[]>([])
        : HiddenListingsRepo.use((repo) => repo.list(owner.value)),
    ),
  ),
);

export const hideListing = createServerFn({ method: 'POST' })
  .validator(validate(HiddenListingInput))
  .handler(({ data }) =>
    runEffect(Effect.flatMap(ensureOwner, (owner) => HiddenListingsRepo.use((repo) => repo.hide(owner, data, Date.now())))),
  );

export const unhideListing = createServerFn({ method: 'POST' })
  .validator(validate(HiddenListingIdRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.flatMap(ensureOwner, (owner) => HiddenListingsRepo.use((repo) => repo.unhide(owner, data.id))).pipe(Effect.as(OK)),
    ),
  );

export const clearHidden = createServerFn({ method: 'POST' }).handler(() =>
  runEffect(Effect.flatMap(ensureOwner, (owner) => HiddenListingsRepo.use((repo) => repo.clear(owner))).pipe(Effect.as(OK))),
);
