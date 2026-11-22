// Webhooks and their delivery log (`webhooks`, `webhook_deliveries`).
//
// Every webhook belongs to an owner (an account). Methods that take an owner treat another owner's
// webhook as missing. Deliveries are rows the Webhooks service sends and retries: created
// 'pending' (due now), then 'delivered', or retried until they are 'failed'. The log keeps each
// webhook's newest DELIVERIES_KEPT deliveries for DELIVERY_RETENTION_MS.
import '@tanstack/react-start/server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import { Array as Arr, Context, Effect, Layer, Option, Schema } from 'effect';
import { SqlClient } from 'effect/sql';
import { DatabaseLayer } from '@/server/db/Database';
import { decodeRowsSkippingBad } from '@/server/db/stored';
import type { OwnerKey } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import {
  WebhookDeliveryStatus,
  WebhookEvent,
  WebhookId,
  type Webhook,
  type WebhookDelivery,
  type WebhookInput,
  type WebhookPatch,
} from '@/shared/domain';

export const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const DELIVERIES_KEPT = 200;

/** A delivery to send: what the Webhooks service needs. */
export interface DueDelivery {
  readonly id: number;
  readonly uuid: string;
  readonly event: WebhookEvent;
  readonly payloadJson: string;
  readonly attempts: number;
  readonly createdAt: number;
  readonly webhook: { readonly id: WebhookId; readonly url: string; readonly secret: string; readonly enabled: boolean };
}

export interface NewDelivery {
  readonly event: WebhookEvent;
  readonly summary: string;
  /** Builds the JSON body for the delivery's uuid (it goes in the body too). */
  readonly payload: (uuid: string) => string;
}

export interface AttemptOutcome {
  readonly status: WebhookDeliveryStatus;
  readonly httpStatus: number | null;
  readonly error: string | null;
  readonly at: number;
  readonly nextAttemptAt: number | null;
}

export interface WebhooksRepoShape {
  /** The owner's webhooks, oldest first, each with its latest delivery. */
  readonly list: (owner: OwnerKey) => Effect.Effect<readonly Webhook[]>;
  readonly get: (owner: OwnerKey, id: WebhookId) => Effect.Effect<Option.Option<Webhook>>;
  /** A new webhook with a fresh random secret. */
  readonly create: (owner: OwnerKey, input: WebhookInput, now: number) => Effect.Effect<Webhook>;
  readonly update: (owner: OwnerKey, id: WebhookId, patch: WebhookPatch) => Effect.Effect<Option.Option<Webhook>>;
  readonly remove: (owner: OwnerKey, id: WebhookId) => Effect.Effect<boolean>;
  /** The owner's enabled webhooks' ids. */
  readonly enabledIds: (owner: OwnerKey) => Effect.Effect<readonly WebhookId[]>;
  /**
   * Queue one delivery per webhook, due at `dueAt` (null: never picked up by `due`, for a delivery
   * the caller sends itself). Returns the deliveries' ids.
   */
  readonly enqueue: (
    webhookIds: readonly WebhookId[],
    delivery: NewDelivery,
    now: number,
    dueAt: number | null,
  ) => Effect.Effect<readonly number[]>;
  /** Pending deliveries due at `now`, oldest first. */
  readonly due: (now: number, limit: number) => Effect.Effect<readonly DueDelivery[]>;
  /** One delivery by id (any owner; ids come from enqueue). */
  readonly delivery: (id: number) => Effect.Effect<Option.Option<DueDelivery>>;
  /** Record an attempt's outcome (attempts + 1). */
  readonly recordAttempt: (id: number, outcome: AttemptOutcome) => Effect.Effect<void>;
  /** The owner's deliveries for a webhook, newest first. */
  readonly deliveries: (owner: OwnerKey, id: WebhookId, limit: number) => Effect.Effect<readonly WebhookDelivery[]>;
  readonly prune: (now: number) => Effect.Effect<void>;
}

/** A webhook signing secret: 32 random bytes, hex. */
export const newSecret = (): string => `whsec_${randomBytes(32).toString('hex')}`;

const WebhookRow = Schema.Struct({
  id: WebhookId,
  name: Schema.String,
  url: Schema.String,
  secret: Schema.String,
  enabled: Schema.BooleanFromBit,
  created_at: Schema.Finite,
});
type WebhookRow = typeof WebhookRow.Type;

const DeliveryRow = Schema.Struct({
  id: Schema.Int,
  webhook_id: WebhookId,
  event: WebhookEvent,
  summary: Schema.String,
  status: WebhookDeliveryStatus,
  attempts: Schema.Int,
  http_status: Schema.NullOr(Schema.Int),
  error: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
  last_attempt_at: Schema.NullOr(Schema.Finite),
  next_attempt_at: Schema.NullOr(Schema.Finite),
});
type DeliveryRow = typeof DeliveryRow.Type;

const DueRow = Schema.Struct({
  id: Schema.Int,
  delivery_uuid: Schema.String,
  event: WebhookEvent,
  payload_json: Schema.String,
  attempts: Schema.Int,
  created_at: Schema.Finite,
  webhook_id: WebhookId,
  url: Schema.String,
  secret: Schema.String,
  enabled: Schema.BooleanFromBit,
});

const decodeWebhooks = decodeRowsSkippingBad(WebhookRow);
const decodeDeliveries = decodeRowsSkippingBad(DeliveryRow);
const decodeDue = decodeRowsSkippingBad(DueRow);
const decodeIds = decodeRowsSkippingBad(Schema.Struct({ id: Schema.Int }));

const toDelivery = (row: DeliveryRow): WebhookDelivery => ({
  id: row.id,
  webhookId: row.webhook_id,
  event: row.event,
  summary: row.summary,
  status: row.status,
  attempts: row.attempts,
  httpStatus: row.http_status,
  error: row.error,
  createdAt: row.created_at,
  lastAttemptAt: row.last_attempt_at,
  nextAttemptAt: row.next_attempt_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const webhookColumns = sql.literal('id, name, url, secret, enabled, created_at');
  const deliveryColumns = sql.literal(
    'id, webhook_id, event, summary, status, attempts, http_status, error, created_at, last_attempt_at, next_attempt_at',
  );
  const dueColumns = sql.literal(`d.id, d.delivery_uuid, d.event, d.payload_json, d.attempts, d.created_at,
    w.id AS webhook_id, w.url, w.secret, w.enabled`);

  const latestDelivery = (id: WebhookId) =>
    Effect.map(
      sql`SELECT ${deliveryColumns} FROM webhook_deliveries WHERE webhook_id = ${id} ORDER BY created_at DESC, id DESC LIMIT 1`,
      (rows) => Option.getOrNull(Option.map(Arr.head(decodeDeliveries(rows)), toDelivery)),
    );

  const toWebhook = (row: WebhookRow) =>
    Effect.map(
      latestDelivery(row.id),
      (lastDelivery): Webhook => ({
        id: row.id,
        name: row.name,
        url: row.url,
        secret: row.secret,
        enabled: row.enabled,
        createdAt: row.created_at,
        lastDelivery,
      }),
    );

  const ownedRow = (owner: OwnerKey, id: WebhookId) =>
    Effect.map(sql`SELECT ${webhookColumns} FROM webhooks WHERE id = ${id} AND owner = ${owner}`, (rows) =>
      Arr.head(decodeWebhooks(rows)),
    );

  const list = Effect.fn('WebhooksRepo.list')(
    (owner: OwnerKey) =>
      Effect.flatMap(sql`SELECT ${webhookColumns} FROM webhooks WHERE owner = ${owner} ORDER BY created_at, id`, (rows) =>
        Effect.forEach(decodeWebhooks(rows), toWebhook),
      ),
    Effect.orDie,
  );

  const get = Effect.fn('WebhooksRepo.get')(
    (owner: OwnerKey, id: WebhookId) =>
      Effect.flatMap(ownedRow(owner, id), (row) => (Option.isNone(row) ? Effect.succeedNone : Effect.map(toWebhook(row.value), Option.some))),
    Effect.orDie,
  );

  const create = Effect.fn('WebhooksRepo.create')(function* (owner: OwnerKey, input: WebhookInput, now: number) {
    const rows = yield* sql`
      INSERT INTO webhooks (owner, name, url, secret, enabled, created_at)
      VALUES (${owner}, ${input.name}, ${input.url}, ${newSecret()}, ${input.enabled ? 1 : 0}, ${now})
      RETURNING ${webhookColumns}`;
    return yield* toWebhook(yield* Schema.decodeUnknownEffect(WebhookRow)(rows[0]));
  }, Effect.orDie);

  const update = Effect.fn('WebhooksRepo.update')(function* (owner: OwnerKey, id: WebhookId, patch: WebhookPatch) {
    const existing = yield* ownedRow(owner, id);
    if (Option.isNone(existing)) return Option.none<Webhook>();
    const before = existing.value;
    yield* sql`UPDATE webhooks
               SET name = ${patch.name ?? before.name},
                   url = ${patch.url ?? before.url},
                   enabled = ${(patch.enabled ?? before.enabled) ? 1 : 0},
                   secret = ${patch.rotateSecret === true ? newSecret() : before.secret}
               WHERE id = ${id}`;
    return yield* get(owner, id);
  }, Effect.orDie);

  const remove = Effect.fn('WebhooksRepo.remove')(
    (owner: OwnerKey, id: WebhookId) =>
      Effect.map(sql`DELETE FROM webhooks WHERE id = ${id} AND owner = ${owner} RETURNING id`, (rows) => rows.length > 0),
    Effect.orDie,
  );

  const enabledIds = Effect.fn('WebhooksRepo.enabledIds')(
    (owner: OwnerKey) =>
      Effect.map(sql`SELECT id FROM webhooks WHERE owner = ${owner} AND enabled = 1 ORDER BY id`, (rows) =>
        decodeRowsSkippingBad(Schema.Struct({ id: WebhookId }))(rows).map((row) => row.id),
      ),
    Effect.orDie,
  );

  const enqueue = Effect.fn('WebhooksRepo.enqueue')(
    (webhookIds: readonly WebhookId[], delivery: NewDelivery, now: number, dueAt: number | null) =>
      sql.withTransaction(
        Effect.forEach(webhookIds, (webhookId) => {
          const uuid = randomUUID();
          return Effect.map(
            sql`INSERT INTO webhook_deliveries
                  (webhook_id, delivery_uuid, event, summary, payload_json, status, attempts, created_at, next_attempt_at)
                VALUES (${webhookId}, ${uuid}, ${delivery.event}, ${delivery.summary.slice(0, 300)}, ${delivery.payload(uuid)},
                        'pending', 0, ${now}, ${dueAt})
                RETURNING id`,
            (rows) => decodeIds(rows)[0]?.id ?? -1,
          );
        }),
      ).pipe(Effect.map((ids) => ids.filter((id) => id > 0))),
    Effect.orDie,
  );

  const toDue = (row: typeof DueRow.Type): DueDelivery => ({
    id: row.id,
    uuid: row.delivery_uuid,
    event: row.event,
    payloadJson: row.payload_json,
    attempts: row.attempts,
    createdAt: row.created_at,
    webhook: { id: row.webhook_id, url: row.url, secret: row.secret, enabled: row.enabled },
  });

  const due = Effect.fn('WebhooksRepo.due')(
    (now: number, limit: number) =>
      Effect.map(
        sql`SELECT ${dueColumns} FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
            WHERE d.status = 'pending' AND d.next_attempt_at <= ${now}
            ORDER BY d.next_attempt_at, d.id LIMIT ${limit}`,
        (rows) => decodeDue(rows).map(toDue),
      ),
    Effect.orDie,
  );

  const delivery = Effect.fn('WebhooksRepo.delivery')(
    (id: number) =>
      Effect.map(
        sql`SELECT ${dueColumns} FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ${id}`,
        (rows) => Option.map(Arr.head(decodeDue(rows)), toDue),
      ),
    Effect.orDie,
  );

  const recordAttempt = Effect.fn('WebhooksRepo.recordAttempt')(
    (id: number, outcome: AttemptOutcome) =>
      Effect.asVoid(
        sql`UPDATE webhook_deliveries
            SET status = ${outcome.status}, attempts = attempts + 1, http_status = ${outcome.httpStatus},
                error = ${outcome.error === null ? null : outcome.error.slice(0, 500)},
                last_attempt_at = ${outcome.at}, next_attempt_at = ${outcome.nextAttemptAt}
            WHERE id = ${id}`,
      ),
    Effect.orDie,
  );

  const deliveries = Effect.fn('WebhooksRepo.deliveries')(
    (owner: OwnerKey, id: WebhookId, limit: number) =>
      Effect.map(
        sql`SELECT ${sql.literal('d.id, d.webhook_id, d.event, d.summary, d.status, d.attempts, d.http_status, d.error, d.created_at, d.last_attempt_at, d.next_attempt_at')}
            FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
            WHERE d.webhook_id = ${id} AND w.owner = ${owner}
            ORDER BY d.created_at DESC, d.id DESC LIMIT ${limit}`,
        (rows) => decodeDeliveries(rows).map(toDelivery),
      ),
    Effect.orDie,
  );

  const prune = Effect.fn('WebhooksRepo.prune')(
    (now: number) =>
      Effect.asVoid(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM webhook_deliveries WHERE status != 'pending' AND created_at < ${now - DELIVERY_RETENTION_MS}`;
            yield* sql`DELETE FROM webhook_deliveries WHERE status != 'pending' AND id NOT IN (
                         SELECT id FROM (
                           SELECT id, ROW_NUMBER() OVER (PARTITION BY webhook_id ORDER BY created_at DESC, id DESC) AS n
                           FROM webhook_deliveries
                         ) WHERE n <= ${DELIVERIES_KEPT})`;
          }),
        ),
      ),
    Effect.orDie,
  );

  return WebhooksRepo.of({ list, get, create, update, remove, enabledIds, enqueue, due, delivery, recordAttempt, deliveries, prune });
});

export class WebhooksRepo extends Context.Service<WebhooksRepo, WebhooksRepoShape>()('faceslop/server/WebhooksRepo') {
  static readonly layerStub = Layer.succeed(
    WebhooksRepo,
    WebhooksRepo.of({
      list: () => notImplemented('WebhooksRepo.list'),
      get: () => notImplemented('WebhooksRepo.get'),
      create: () => notImplemented('WebhooksRepo.create'),
      update: () => notImplemented('WebhooksRepo.update'),
      remove: () => notImplemented('WebhooksRepo.remove'),
      enabledIds: () => notImplemented('WebhooksRepo.enabledIds'),
      enqueue: () => notImplemented('WebhooksRepo.enqueue'),
      due: () => notImplemented('WebhooksRepo.due'),
      delivery: () => notImplemented('WebhooksRepo.delivery'),
      recordAttempt: () => notImplemented('WebhooksRepo.recordAttempt'),
      deliveries: () => notImplemented('WebhooksRepo.deliveries'),
      prune: () => notImplemented('WebhooksRepo.prune'),
    }),
  );

  /** Needs a SqlClient (tests: see ../layers.ts). */
  static readonly layerNoDeps = Layer.effect(WebhooksRepo, make);

  /** The layer the app runs. */
  static readonly layer = WebhooksRepo.layerNoDeps.pipe(Layer.provide(DatabaseLayer));
}
