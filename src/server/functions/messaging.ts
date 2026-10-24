// Message a seller as this browser's Facebook account. Legacy: POST /api/listings/:id/message.
import { createServerFn } from '@tanstack/react-start';
import { Effect } from 'effect';
import { runEffect, validate } from '@/server/bridge';
import { Messaging } from '@/server/messaging/Messaging';
import { requireAccount } from '@/server/session/CurrentClient';
import { SendMessageInput } from '@/shared/domain';

export const sendMessage = createServerFn({ method: 'POST' })
  .validator(validate(SendMessageInput))
  .handler(({ data }) =>
    runEffect(
      Effect.flatMap(requireAccount, ({ userId }) =>
        Messaging.use((messaging) => messaging.sendMessage(userId, data.listingId, data.text)),
      ),
    ),
  );
