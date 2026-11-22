// Webhooks (owned by this browser's Facebook account; group watch matches go to every enabled
// one). The URL's host is checked when it is saved (src/server/webhooks/Webhooks.ts: no
// link-local, unspecified or multicast addresses). "Send test" posts a signed test event now.
import { createServerFn } from '@tanstack/react-start';
import { Effect, Option } from 'effect';
import { runEffect, validate } from '@/server/bridge';
import { WebhooksRepo } from '@/server/db/repositories/WebhooksRepo';
import { currentOwner, requireAccount } from '@/server/session/CurrentClient';
import { accountOwner } from '@/server/session/identity';
import { Webhooks } from '@/server/webhooks/Webhooks';
import { OK, UpdateWebhookInput, WebhookIdRequest, WebhookInput, type Webhook, type WebhookDelivery } from '@/shared/domain';
import { AppError } from '@/shared/errors';

const DELIVERIES_SHOWN = 30;

const webhookGone = () => new AppError({ code: 'NOT_FOUND', message: 'That webhook no longer exists.' });

export const listWebhooks = createServerFn({ method: 'GET' }).handler(() =>
  runEffect(
    Effect.flatMap(currentOwner, (owner) =>
      Option.isNone(owner) ? Effect.succeed<readonly Webhook[]>([]) : WebhooksRepo.use((repo) => repo.list(owner.value)),
    ),
  ),
);

export const createWebhook = createServerFn({ method: 'POST' })
  .validator(validate(WebhookInput))
  .handler(({ data }) =>
    runEffect(
      Effect.gen(function* () {
        const owner = accountOwner((yield* requireAccount).userId);
        yield* Webhooks.use((webhooks) => webhooks.checkTarget(data.url));
        return yield* WebhooksRepo.use((repo) => repo.create(owner, data, Date.now()));
      }),
    ),
  );

export const updateWebhook = createServerFn({ method: 'POST' })
  .validator(validate(UpdateWebhookInput))
  .handler(({ data }) =>
    runEffect(
      Effect.gen(function* () {
        const owner = accountOwner((yield* requireAccount).userId);
        const url = data.patch.url;
        if (url !== undefined) yield* Webhooks.use((webhooks) => webhooks.checkTarget(url));
        const updated = yield* WebhooksRepo.use((repo) => repo.update(owner, data.id, data.patch));
        return Option.isNone(updated) ? yield* webhookGone() : updated.value;
      }),
    ),
  );

/** Idempotent: deleting a missing webhook is fine (its deliveries go with it). */
export const deleteWebhook = createServerFn({ method: 'POST' })
  .validator(validate(WebhookIdRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.flatMap(requireAccount, ({ userId }) => WebhooksRepo.use((repo) => repo.remove(accountOwner(userId), data.id))).pipe(
        Effect.as(OK),
      ),
    ),
  );

export const testWebhook = createServerFn({ method: 'POST' })
  .validator(validate(WebhookIdRequest))
  .handler(({ data }) =>
    runEffect(Effect.flatMap(requireAccount, ({ userId }) => Webhooks.use((webhooks) => webhooks.sendTest(accountOwner(userId), data.id)))),
  );

export const listWebhookDeliveries = createServerFn({ method: 'GET' })
  .validator(validate(WebhookIdRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.flatMap(currentOwner, (owner) =>
        Option.isNone(owner)
          ? Effect.succeed<readonly WebhookDelivery[]>([])
          : WebhooksRepo.use((repo) => repo.deliveries(owner.value, data.id, DELIVERIES_SHOWN)),
      ),
    ),
  );
