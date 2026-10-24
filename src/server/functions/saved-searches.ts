// Saved searches (this browser's owner: see src/server/session/identity.ts): CRUD plus "run now",
// which reports listings that are new since the last view.
// Legacy: GET/POST /api/saved-searches, PATCH/DELETE /api/saved-searches/:id, POST .../:id/run.
//
// - create: stored as given (autoCheck defaults to true), then a baseline is recorded in the
//   background (Checker.scheduleSeed) so what exists now never counts as new (newCount starts at 0).
// - update: changing params forgets what was seen and records a new baseline in the background.
// - run: fetch page 1 now and record it, then return everything first seen since the previous
//   view (including what the background checker found), minus locally filtered listings, and mark
//   the search viewed. The first run of a never-seeded search is its baseline.
// The logic lives in src/server/checker/Checker.ts (createSavedSearch, updateSavedSearch,
// runSavedSearch), where it is unit-tested.
import { createServerFn } from '@tanstack/react-start';
import { Effect, Option } from 'effect';
import { runEffect, validate } from '@/server/bridge';
import {
  createSavedSearch as createAndSeed,
  runSavedSearch as runNow,
  updateSavedSearch as updateAndReseed,
} from '@/server/checker/Checker';
import { SavedSearchesRepo } from '@/server/db/repositories/SavedSearchesRepo';
import { currentOwner, ensureOwner } from '@/server/session/CurrentClient';
import { OK, SavedSearchIdRequest, SavedSearchInput, UpdateSavedSearchInput, type SavedSearch } from '@/shared/domain';

export const listSavedSearches = createServerFn({ method: 'GET' }).handler(() =>
  runEffect(
    Effect.flatMap(currentOwner, (owner) =>
      Option.isNone(owner)
        ? Effect.succeed<readonly SavedSearch[]>([])
        : SavedSearchesRepo.use((repo) => repo.list(owner.value)),
    ),
  ),
);

export const createSavedSearch = createServerFn({ method: 'POST' })
  .validator(validate(SavedSearchInput))
  .handler(({ data }) => runEffect(Effect.flatMap(ensureOwner, (owner) => createAndSeed(owner, data, Date.now()))));

export const updateSavedSearch = createServerFn({ method: 'POST' })
  .validator(validate(UpdateSavedSearchInput))
  .handler(({ data }) => runEffect(Effect.flatMap(ensureOwner, (owner) => updateAndReseed(owner, data.id, data.patch))));

/** Idempotent: deleting a missing saved search is fine. */
export const deleteSavedSearch = createServerFn({ method: 'POST' })
  .validator(validate(SavedSearchIdRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.flatMap(ensureOwner, (owner) => SavedSearchesRepo.use((repo) => repo.remove(owner, data.id))).pipe(Effect.as(OK)),
    ),
  );

export const runSavedSearch = createServerFn({ method: 'POST' })
  .validator(validate(SavedSearchIdRequest))
  .handler(({ data }) => runEffect(Effect.flatMap(ensureOwner, (owner) => runNow(owner, data.id))));
