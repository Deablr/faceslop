// The pure parts of webhooks and group feeds: signing, retry decisions, forbidden targets, input
// validation, and how a feed session advances.
import { createHmac } from 'node:crypto';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { advanceFeed, type FeedState } from '@/server/groups/feed';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Effect } from 'effect';
import { RETRY_DELAYS_MS, WebhookTransport, attemptOutcome, isForbiddenAddress, isRetryable, signWebhook } from '@/server/webhooks/Webhooks';
import { GroupWatchInput, WebhookInput, type GroupPost } from '@/shared/domain';

describe('signWebhook', () => {
  it('is HMAC-SHA256 over "<timestamp>.<body>", hex, prefixed', () => {
    const expected = createHmac('sha256', 'whsec_test').update('1700000000.{"a":1}').digest('hex');
    expect(signWebhook('whsec_test', 1_700_000_000, '{"a":1}')).toBe(`sha256=${expected}`);
    expect(signWebhook('whsec_other', 1_700_000_000, '{"a":1}')).not.toBe(`sha256=${expected}`);
  });
});

describe('attemptOutcome', () => {
  it('delivers on 2xx', () => {
    expect(attemptOutcome(1, 204, null, 5)).toEqual({ status: 'delivered', httpStatus: 204, error: null, at: 5, nextAttemptAt: null });
  });

  it('retries server errors, timeouts and rate limits on the schedule, then fails', () => {
    for (const status of [500, 503, 408, 429, null]) expect(isRetryable(status)).toBe(true);
    for (const status of [400, 401, 404, 410, 301]) expect(isRetryable(status)).toBe(false);
    RETRY_DELAYS_MS.forEach((delay, i) => {
      expect(attemptOutcome(i + 1, 503, null, 0)).toMatchObject({ status: 'pending', nextAttemptAt: delay });
    });
    expect(attemptOutcome(RETRY_DELAYS_MS.length + 1, 503, null, 0)).toMatchObject({ status: 'failed', nextAttemptAt: null });
    expect(attemptOutcome(1, null, 'no answer within 10s', 0)).toMatchObject({ status: 'pending', error: 'no answer within 10s' });
    expect(attemptOutcome(1, 503, null, 0, false)).toMatchObject({ status: 'failed' });
  });

  it("fails client errors and redirects at once (redirects aren't followed)", () => {
    expect(attemptOutcome(1, 404, null, 0)).toMatchObject({ status: 'failed', error: 'HTTP 404' });
    expect(attemptOutcome(1, 302, null, 0)).toMatchObject({ status: 'failed', error: expect.stringContaining('redirects') as string });
  });
});

describe('isForbiddenAddress', () => {
  it.each([
    '169.254.169.254',
    '169.254.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    'fe80::1',
    '[fe80::1]',
    'ff02::1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '::a9fe:a9fe',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::169.254.169.254',
    'fd00:ec2::254',
  ])(
    'forbids %s',
    (address) => {
      expect(isForbiddenAddress(address)).toBe(true);
    },
  );
  it.each(['192.168.1.20', '10.0.0.5', '127.0.0.1', '93.184.216.34', '::1', 'fd00::1', '2606:4700::1111', '::ffff:192.168.1.1'])(
    'allows %s',
    (address) => {
      expect(isForbiddenAddress(address)).toBe(false);
    },
  );
});

describe('the real transport', () => {
  const transport = Effect.runSync(WebhookTransport);

  it('POSTs the body with its headers, and never follows redirects', async () => {
    const seen: { method?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        seen.push({ method: req.method, headers: req.headers, body });
        res.writeHead(req.url === '/redirect' ? 302 : 204, { location: 'http://169.254.169.254/' }).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://localhost:${String((server.address() as AddressInfo).port)}`;
    try {
      const request = { url: `${base}/hook`, headers: { 'content-type': 'application/json', 'x-faceslop-event': 'test' }, body: '{"a":1}' };
      expect(await Effect.runPromise(transport.post(request))).toBe(204);
      expect(seen[0]).toMatchObject({ method: 'POST', body: '{"a":1}', headers: { 'x-faceslop-event': 'test' } });
      expect(await Effect.runPromise(transport.post({ ...request, url: `${base}/redirect` }))).toBe(302);
      expect(seen).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    }
  });

  it('refuses forbidden IP literals without connecting', async () => {
    const error = await Effect.runPromise(Effect.flip(transport.post({ url: 'http://169.254.169.254/latest', headers: {}, body: '' })));
    expect(error).toContain('not allowed');
  });
});

describe('inputs', () => {
  const decodeWebhook = Schema.decodeUnknownSync(WebhookInput);
  const decodeWatch = Schema.decodeUnknownSync(GroupWatchInput);

  it('webhooks need an http(s) URL without credentials', () => {
    expect(decodeWebhook({ name: ' Phone ', url: ' https://ntfy.example/puppies ' })).toEqual({
      name: 'Phone',
      url: 'https://ntfy.example/puppies',
      enabled: true,
    });
    for (const url of ['ftp://x.example/', 'not a url', 'https://user:pw@x.example/', 'javascript:alert(1)']) {
      expect(() => decodeWebhook({ name: 'x', url })).toThrow();
    }
  });

  it('watches default to every post, every 15 minutes; keywords are normalized; intervals are 5..1440', () => {
    expect(decodeWatch({ groupId: '123', groupName: 'Pups' })).toEqual({
      groupId: '123',
      groupName: 'Pups',
      keywords: [],
      excludeKeywords: [],
      intervalMinutes: 15,
      enabled: true,
    });
    expect(decodeWatch({ groupId: '123', groupName: 'Pups', keywords: [' Golden ', 'golden', 'LAB  mix', ''] }).keywords).toEqual([
      'golden',
      'lab mix',
    ]);
    expect(() => decodeWatch({ groupId: '123', groupName: 'Pups', intervalMinutes: 4 })).toThrow();
    expect(() => decodeWatch({ groupId: 'okpuppies', groupName: 'Pups' })).toThrow();
  });
});

describe('advanceFeed', () => {
  const post = (id: string) => ({ id }) as GroupPost;
  const state: FeedState = { seen: new Set(['1']), cursor: 'a', hasMore: true, template: null, pagesFetched: 0 };

  it('returns only posts not returned before and moves the cursor', () => {
    const step = advanceFeed(state, { posts: [post('1'), post('2'), post('3')], pageInfo: { endCursor: 'b', hasNextPage: true } });
    expect(step.fresh.map((p) => p.id)).toEqual(['2', '3']);
    expect(step.state).toMatchObject({ cursor: 'b', hasMore: true, pagesFetched: 1 });
    expect([...step.state.seen]).toEqual(['1', '2', '3']);
  });

  it("ends the feed when Facebook says so or the cursor doesn't move", () => {
    expect(advanceFeed(state, { posts: [], pageInfo: { endCursor: 'b', hasNextPage: false } }).state.hasMore).toBe(false);
    expect(advanceFeed(state, { posts: [post('2')], pageInfo: { endCursor: 'a', hasNextPage: true } }).state.hasMore).toBe(false);
    expect(advanceFeed(state, { posts: [post('2')], pageInfo: null }).state.hasMore).toBe(false);
  });
});
