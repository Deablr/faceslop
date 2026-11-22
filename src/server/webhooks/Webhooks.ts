// Outgoing webhooks: signed JSON POSTs for group-watch matches (and "Send test").
//
// - notifyGroupPost queues one delivery per enabled webhook of the owner (WebhooksRepo); a
//   background fiber (forked into the layer's scope) sends what is due every pollInterval, one at a
//   time, and retries failures after RETRY_DELAYS_MS (then gives up: 'failed'). A 2xx answer is
//   delivered; 4xx answers (except 408/425/429) and redirects are failures that aren't retried.
// - Every request: POST, `content-type: application/json`, and
//     X-Faceslop-Event: group.post | test
//     X-Faceslop-Delivery: <uuid>           (the same for every retry of a delivery)
//     X-Faceslop-Timestamp: <unix seconds>  (of this attempt)
//     X-Faceslop-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${body}`)>
//   Redirects are not followed. The body is GroupPostWebhookPayload / TestWebhookPayload.
// - Targets: any http(s) URL, including private network addresses (Home Assistant on the LAN),
//   except link-local, unspecified and multicast addresses (cloud metadata endpoints live at
//   169.254.169.254 and fd00:ec2::254), checked when a webhook is saved, before every attempt, and
//   on the address the request actually connects to (its DNS lookup is the checked one, so a
//   hostname can't pass the check and then resolve somewhere else: DNS rebinding).
// - Payloads hold other people's posts; they are never logged.
import '@tanstack/react-start/server-only';
import { createHmac } from 'node:crypto';
import { lookup as lookupCallback, type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Cause, Clock, Context, Duration, Effect, Layer, Option, Result } from 'effect';
import { WebhooksRepo, type AttemptOutcome, type DueDelivery } from '@/server/db/repositories/WebhooksRepo';
import type { OwnerKey } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import type {
  GroupPostWebhookPayload,
  GroupWatch,
  GroupWatchMatch,
  TestWebhookPayload,
  WebhookId,
  WebhookTestResult,
} from '@/shared/domain';
import { AppError } from '@/shared/errors';

/** Waits after the 1st, 2nd, ... failed attempt; after the last one the delivery has failed. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000] as const;
export const REQUEST_TIMEOUT_MS = 10_000;
const DUE_BATCH = 20;
const PRUNE_EVERY_MS = 60 * 60_000;

// ---------- pure ----------

/** The X-Faceslop-Signature value for a body sent at `timestamp` (unix seconds). */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${String(timestamp)}.${body}`).digest('hex')}`;
}

export function groupPostPayload(deliveryId: string, sentAt: number, watch: GroupWatch, match: GroupWatchMatch): GroupPostWebhookPayload {
  const { post } = match;
  return {
    version: 1,
    event: 'group.post',
    deliveryId,
    sentAt: new Date(sentAt).toISOString(),
    watch: { id: watch.id, groupId: watch.groupId, groupName: watch.groupName, matchedKeywords: match.matchedKeywords },
    post: {
      id: post.id,
      url: post.url,
      text: post.text,
      author: post.author === null ? null : { name: post.author.name, url: post.author.url },
      createdAt: post.createdAt === null ? null : new Date(post.createdAt).toISOString(),
      images: post.images,
      hasVideo: post.hasVideo,
      commentCount: post.commentCount,
    },
  };
}

export function testPayload(deliveryId: string, sentAt: number): TestWebhookPayload {
  return {
    version: 1,
    event: 'test',
    deliveryId,
    sentAt: new Date(sentAt).toISOString(),
    message: 'A test from faceslop. Group watch matches arrive here as "group.post" events.',
  };
}

/** Whether an attempt that got `httpStatus` (null: no answer) is worth retrying. */
export function isRetryable(httpStatus: number | null): boolean {
  if (httpStatus === null) return true;
  return httpStatus >= 500 || httpStatus === 408 || httpStatus === 425 || httpStatus === 429;
}

/** What to record after attempt number `attempt` (1-based) got `httpStatus` / `error`, at `now`. */
export function attemptOutcome(attempt: number, httpStatus: number | null, error: string | null, now: number, retries = true): AttemptOutcome {
  if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
    return { status: 'delivered', httpStatus, error: null, at: now, nextAttemptAt: null };
  }
  const message = error ?? (httpStatus !== null && httpStatus >= 300 && httpStatus < 400 ? `HTTP ${String(httpStatus)} (redirects aren't followed)` : `HTTP ${String(httpStatus)}`);
  const delay = RETRY_DELAYS_MS[attempt - 1];
  if (retries && delay !== undefined && isRetryable(httpStatus)) {
    return { status: 'pending', httpStatus, error: message, at: now, nextAttemptAt: now + delay };
  }
  return { status: 'failed', httpStatus, error: message, at: now, nextAttemptAt: null };
}

/** True for addresses a webhook may not target: link-local (cloud metadata), unspecified, multicast. */
export function isForbiddenAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = ipv4Of(ip);
  if (v4 !== null) {
    const [a = 0, b = 0] = v4.split('.').map(Number);
    return a === 0 || (a === 169 && b === 254) || a >= 224;
  }
  if (isIP(ip) !== 6) return false;
  return ip === '::' || /^fe[89ab]/.test(ip) || ip.startsWith('ff') || ip === 'fd00:ec2::254';
}

/** The IPv4 address `ip` is (itself, or an IPv4-mapped IPv6 address in either notation), or null. */
function ipv4Of(ip: string): string | null {
  if (isIP(ip) === 4) return ip;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
  if (dotted !== undefined) return dotted;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hex === null) return null;
  const high = parseInt(hex[1] ?? '0', 16);
  const low = parseInt(hex[2] ?? '0', 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

const FORBIDDEN_TARGET = 'that address is not allowed for webhooks (link-local, unspecified or multicast)';

/**
 * DNS lookup for webhook connections: the addresses the socket will use, refused when any is one
 * webhooks may not target. Node calls it for every hostname it connects to (not for IP literals,
 * which `post` checks itself).
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  lookupCallback(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, '', 0);
      return;
    }
    const first = addresses[0];
    if (first === undefined || addresses.some((a) => isForbiddenAddress(a.address))) {
      callback(Object.assign(new Error(FORBIDDEN_TARGET), { code: 'EFORBIDDEN' }), '', 0);
      return;
    }
    if (options.all === true) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
};

/** POST over node:http(s) through guardedLookup; never follows redirects. Resolves with the status. */
function postGuarded(request: WebhookRequest): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(request.url);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0 && isForbiddenAddress(host)) {
      reject(new Error(FORBIDDEN_TARGET));
      return;
    }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: { ...request.headers, 'content-length': String(Buffer.byteLength(request.body)) },
        lookup: guardedLookup,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        // The body isn't needed: drain it so the socket is released.
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`no answer within ${String(REQUEST_TIMEOUT_MS / 1000)}s`));
    });
    req.on('error', reject);
    req.end(request.body);
  });
}

// ---------- transport (a Reference, so tests never touch the network) ----------

export interface WebhookRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface WebhookTransportShape {
  /** Every address `url`'s host resolves to (IP literals: themselves). */
  readonly resolve: (url: string) => Effect.Effect<readonly string[], string>;
  /** POST it; the HTTP status, or a failure message when there was no answer. */
  readonly post: (request: WebhookRequest) => Effect.Effect<number, string>;
}

const describeError = (cause: unknown): string => {
  if (cause instanceof Error) {
    const inner = cause.cause instanceof Error ? `: ${cause.cause.message}` : '';
    return `${cause.message}${inner}`;
  }
  return String(cause);
};

export const WebhookTransport = Context.Reference<WebhookTransportShape>('faceslop/server/WebhookTransport', {
  defaultValue: () => ({
    resolve: (url) =>
      Effect.tryPromise({
        try: async () => {
          const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
          if (isIP(host) !== 0) return [host];
          return (await lookup(host, { all: true, order: 'verbatim' })).map((entry) => entry.address);
        },
        catch: (cause) => `couldn't find the host (${describeError(cause)})`,
      }),
    post: (request) => Effect.tryPromise({ try: () => postGuarded(request), catch: describeError }),
  }),
});

/** Pacing of the delivery loop. A Reference, so tests can make it instant. */
export const WebhookTiming = Context.Reference<{ readonly pollInterval: Duration.Duration }>('faceslop/server/WebhookTiming', {
  defaultValue: () => ({ pollInterval: Duration.seconds(5) }),
});

// ---------- service ----------

export interface WebhooksShape {
  /** Queue a match for every enabled webhook of `owner`; the number queued. */
  readonly notifyGroupPost: (owner: OwnerKey, watch: GroupWatch, match: GroupWatchMatch) => Effect.Effect<number>;
  /** Send a test delivery now (logged, not retried). NOT_FOUND for another owner's or a missing webhook. */
  readonly sendTest: (owner: OwnerKey, id: WebhookId) => Effect.Effect<WebhookTestResult, AppError>;
  /** BAD_REQUEST when the URL's host can't be found or is an address webhooks may not target. */
  readonly checkTarget: (url: string) => Effect.Effect<void, AppError>;
  /** Send every delivery that is due now (the loop's work; exposed for tests). The number attempted. */
  readonly deliverDue: Effect.Effect<number>;
}

const make = Effect.gen(function* () {
  const repo = yield* WebhooksRepo;
  const transport = yield* WebhookTransport;
  const timing = yield* WebhookTiming;
  /** Deliveries being sent right now (the loop and "Send test" never send one twice at once). */
  const inFlight = new Set<number>();

  /** Why `url` can't be a target, or null. */
  const targetProblem = (url: string) =>
    Effect.match(transport.resolve(url), {
      onFailure: (message) => message,
      onSuccess: (addresses) =>
        addresses.length === 0
          ? "couldn't find the host"
          : addresses.some(isForbiddenAddress)
            ? FORBIDDEN_TARGET
            : null,
    });

  const checkTarget = Effect.fn('Webhooks.checkTarget')(function* (url: string) {
    const problem = yield* targetProblem(url);
    if (problem !== null) return yield* new AppError({ code: 'BAD_REQUEST', message: `Webhook URL: ${problem}.` });
  });

  /** One attempt at a delivery, recorded. Returns what was recorded. */
  const attempt = Effect.fnUntraced(function* (delivery: DueDelivery, retries: boolean) {
    const now = yield* Clock.currentTimeMillis;
    const number = delivery.attempts + 1;
    if (!delivery.webhook.enabled) {
      const outcome = attemptOutcome(number, null, 'the webhook is turned off', now, false);
      yield* repo.recordAttempt(delivery.id, outcome);
      return outcome;
    }
    const problem = yield* targetProblem(delivery.webhook.url);
    if (problem !== null) {
      const outcome = attemptOutcome(number, null, problem, now, retries && !problem.includes('not allowed'));
      yield* repo.recordAttempt(delivery.id, outcome);
      return outcome;
    }
    const timestamp = Math.floor(now / 1000);
    const sent = yield* Effect.result(
      transport.post({
        url: delivery.webhook.url,
        body: delivery.payloadJson,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'faceslop-webhooks/1',
          'x-faceslop-event': delivery.event,
          'x-faceslop-delivery': delivery.uuid,
          'x-faceslop-timestamp': String(timestamp),
          'x-faceslop-signature': signWebhook(delivery.webhook.secret, timestamp, delivery.payloadJson),
        },
      }),
    );
    const outcome =
      Result.isSuccess(sent)
        ? attemptOutcome(number, sent.success, null, yield* Clock.currentTimeMillis, retries)
        : attemptOutcome(number, null, sent.failure, yield* Clock.currentTimeMillis, retries && sent.failure !== FORBIDDEN_TARGET);
    yield* repo.recordAttempt(delivery.id, outcome);
    if (outcome.status !== 'delivered') {
      yield* Effect.logWarning(`[webhooks] delivery ${String(delivery.id)} to webhook ${String(delivery.webhook.id)}: ${outcome.error ?? ''} (${outcome.status})`);
    }
    return outcome;
  });

  /** Attempt it unless it's already being sent. */
  const attemptOnce = (delivery: DueDelivery, retries: boolean) =>
    Effect.suspend(() => {
      if (inFlight.has(delivery.id)) return Effect.succeedNone;
      inFlight.add(delivery.id);
      return attempt(delivery, retries).pipe(
        Effect.map(Option.some),
        Effect.ensuring(Effect.sync(() => inFlight.delete(delivery.id))),
      );
    });

  const deliverDue = Effect.gen(function* () {
    const due = yield* repo.due(yield* Clock.currentTimeMillis, DUE_BATCH);
    for (const delivery of due) yield* attemptOnce(delivery, true);
    return due.length;
  }).pipe(Effect.withSpan('Webhooks.deliverDue'));

  const notifyGroupPost = Effect.fn('Webhooks.notifyGroupPost')(function* (owner: OwnerKey, watch: GroupWatch, match: GroupWatchMatch) {
    const ids = yield* repo.enabledIds(owner);
    if (ids.length === 0) return 0;
    const now = yield* Clock.currentTimeMillis;
    const where = watch.groupName.trim() || 'a watched group';
    const keywords = match.matchedKeywords.length > 0 ? ` (${match.matchedKeywords.join(', ')})` : '';
    const queued = yield* repo.enqueue(
      ids,
      {
        event: 'group.post',
        summary: `New post in ${where}${keywords}`,
        payload: (uuid) => JSON.stringify(groupPostPayload(uuid, now, watch, match)),
      },
      now,
      now,
    );
    return queued.length;
  });

  const sendTest = Effect.fn('Webhooks.sendTest')(function* (owner: OwnerKey, id: WebhookId) {
    const webhook = yield* repo.get(owner, id);
    if (Option.isNone(webhook)) return yield* new AppError({ code: 'NOT_FOUND', message: 'That webhook no longer exists.' });
    const now = yield* Clock.currentTimeMillis;
    const [deliveryId] = yield* repo.enqueue(
      [id],
      { event: 'test', summary: 'Test delivery', payload: (uuid) => JSON.stringify(testPayload(uuid, now)) },
      now,
      null,
    );
    const delivery = deliveryId === undefined ? Option.none<DueDelivery>() : yield* repo.delivery(deliveryId);
    if (Option.isNone(delivery)) return yield* new AppError({ code: 'INTERNAL', message: "Couldn't record the test delivery." });
    // A test is about this webhook as it is now, even while it's turned off.
    const outcome = yield* attemptOnce({ ...delivery.value, webhook: { ...delivery.value.webhook, enabled: true } }, false);
    return Option.match(outcome, {
      onNone: (): WebhookTestResult => ({ ok: false, httpStatus: null, error: 'Already sending.' }),
      onSome: (o): WebhookTestResult => ({ ok: o.status === 'delivered', httpStatus: o.httpStatus, error: o.error }),
    });
  });

  const loop = Effect.gen(function* () {
    let lastPrune = 0;
    for (;;) {
      yield* Effect.sleep(timing.pollInterval);
      yield* Effect.gen(function* () {
        yield* deliverDue;
        const now = yield* Clock.currentTimeMillis;
        if (now - lastPrune >= PRUNE_EVERY_MS) {
          lastPrune = now;
          yield* repo.prune(now);
        }
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logError(`[webhooks] delivery loop failed:\n${Cause.pretty(cause)}`),
        ),
      );
    }
  });
  yield* Effect.forkScoped(loop);

  return Webhooks.of({ notifyGroupPost, sendTest, checkTarget, deliverDue });
});

export class Webhooks extends Context.Service<Webhooks, WebhooksShape>()('faceslop/server/Webhooks') {
  static readonly layerStub = Layer.succeed(
    Webhooks,
    Webhooks.of({
      notifyGroupPost: () => notImplemented('Webhooks.notifyGroupPost'),
      sendTest: () => notImplemented('Webhooks.sendTest'),
      checkTarget: () => notImplemented('Webhooks.checkTarget'),
      deliverDue: notImplemented('Webhooks.deliverDue'),
    }),
  );

  /** Needs WebhooksRepo (tests provide their own, and a WebhookTransport). */
  static readonly layerNoDeps = Layer.effect(Webhooks, make);

  /** The layer the app runs: starts the delivery loop. */
  static readonly layer = Webhooks.layerNoDeps.pipe(Layer.provide(WebhooksRepo.layer));
}
