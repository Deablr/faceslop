// Settings (this browser's owner: see src/server/session/identity.ts).
// Legacy: GET /api/settings, PUT /api/settings (Partial<Settings>).
import { createServerFn } from '@tanstack/react-start';
import { Effect, Option } from 'effect';
import { runEffect, validate } from '@/server/bridge';
import { SettingsRepo } from '@/server/db/repositories/SettingsRepo';
import { currentOwner, ensureOwner } from '@/server/session/CurrentClient';
import { DEFAULT_SETTINGS, SettingsPatch } from '@/shared/domain';

export const getSettings = createServerFn({ method: 'GET' }).handler(() =>
  runEffect(
    Effect.flatMap(currentOwner, (owner) =>
      Option.isNone(owner) ? Effect.succeed(DEFAULT_SETTINGS) : SettingsRepo.use((repo) => repo.get(owner.value)),
    ),
  ),
);

export const updateSettings = createServerFn({ method: 'POST' })
  .validator(validate(SettingsPatch))
  .handler(({ data }) =>
    runEffect(Effect.flatMap(ensureOwner, (owner) => SettingsRepo.use((repo) => repo.update(owner, data)))),
  );
