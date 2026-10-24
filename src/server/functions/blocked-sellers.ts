// Blocked sellers (this browser's owner: see src/server/session/identity.ts).
// Legacy: GET/POST /api/blocked-sellers, DELETE /api/blocked-sellers/:id.
import { createServerFn } from '@tanstack/react-start';
import { Effect, Option } from 'effect';
import { runEffect, validate } from '@/server/bridge';
import { BlockedSellersRepo } from '@/server/db/repositories/BlockedSellersRepo';
import { currentOwner, ensureOwner } from '@/server/session/CurrentClient';
import { BlockedSellerInput, OK, SellerIdRequest, type BlockedSeller } from '@/shared/domain';

export const listBlockedSellers = createServerFn({ method: 'GET' }).handler(() =>
  runEffect(
    Effect.flatMap(currentOwner, (owner) =>
      Option.isNone(owner)
        ? Effect.succeed<readonly BlockedSeller[]>([])
        : BlockedSellersRepo.use((repo) => repo.list(owner.value)),
    ),
  ),
);

export const blockSeller = createServerFn({ method: 'POST' })
  .validator(validate(BlockedSellerInput))
  .handler(({ data }) =>
    runEffect(Effect.flatMap(ensureOwner, (owner) => BlockedSellersRepo.use((repo) => repo.block(owner, data, Date.now())))),
  );

export const unblockSeller = createServerFn({ method: 'POST' })
  .validator(validate(SellerIdRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.flatMap(ensureOwner, (owner) => BlockedSellersRepo.use((repo) => repo.unblock(owner, data.id))).pipe(Effect.as(OK)),
    ),
  );
