// Pure helpers of the search engine and the facebook.com page loader (no browser, no network).
// Ported from legacy/test/search.test.ts, plus the pagination state machine and error mapping.
import { describe, expect, it } from 'vitest';
import {
  blockedReason,
  graphqlRequest,
  interactionError,
  looksLikeLoginWall,
  looksRateLimited,
  navigationError,
} from '@/server/marketplace/fb-page';
import { advance, replayForm, requestedCursor, type Pagination } from '@/server/marketplace/search';
import type { ListingSummary } from '@/shared/domain';
import { AppError } from '@/shared/errors';

describe('blockedReason', () => {
  it('flags login walls and checkpoints', () => {
    expect(blockedReason('https://www.facebook.com/login/?next=%2Fmarketplace%2F')).toMatch(/log in/);
    expect(blockedReason('https://www.facebook.com/checkpoint/1501092823525282/')).toMatch(/verify/);
    expect(blockedReason('https://www.facebook.com/two_step_verification/authentication/')).not.toBeNull();
    expect(blockedReason('https://example.com/')).toMatch(/away/);
  });

  it('allows Marketplace pages', () => {
    expect(blockedReason('https://www.facebook.com/marketplace/nyc/search/?query=login')).toBeNull();
    expect(blockedReason('https://www.facebook.com/marketplace/item/1/')).toBeNull();
    expect(blockedReason('https://m.facebook.com/marketplace/')).toBeNull();
    expect(blockedReason('not a url')).toBeNull();
  });
});

describe('looksRateLimited', () => {
  it("detects Facebook's soft-block pages", () => {
    expect(looksRateLimited('<h2>You’re Temporarily Blocked</h2>')).toBe(true);
    expect(looksRateLimited('<div>You can&#039;t use this feature right now</div>')).toBe(true);
    expect(looksRateLimited('<div>Marketplace</div>')).toBe(false);
  });
});

describe('looksLikeLoginWall', () => {
  it("recognizes Facebook's login page but not logged-out Marketplace pages", () => {
    expect(looksLikeLoginWall('<title>Facebook</title><form id="login_form" method="POST"><input name="pass">')).toBe(true);
    expect(looksLikeLoginWall('<form id="login_form"></form><script type="application/json">{"initialRouteInfo":{}}</script>')).toBe(false);
    expect(looksLikeLoginWall('<div>Marketplace</div>')).toBe(false);
  });
});

describe('graphqlRequest', () => {
  it('builds a logged-out request like the web client', () => {
    const { form, headers } = graphqlRequest({ lsd: 'AdS-0hm34juynpWJhQPoeviQpgk', fbDtsg: null, userId: '0' }, 'SomeQuery', '123', { a: 1 });
    expect(Object.fromEntries(form)).toEqual({
      av: '0',
      __user: '0',
      __a: '1',
      __comet_req: '15',
      lsd: 'AdS-0hm34juynpWJhQPoeviQpgk',
      jazoest: '22487',
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'SomeQuery',
      server_timestamps: 'true',
      variables: '{"a":1}',
      doc_id: '123',
    });
    expect(headers).toEqual({ 'x-fb-friendly-name': 'SomeQuery', 'x-fb-lsd': 'AdS-0hm34juynpWJhQPoeviQpgk' });
  });

  it('includes fb_dtsg (and derives jazoest from it) when logged in', () => {
    const { form } = graphqlRequest({ lsd: 'L', fbDtsg: 'D', userId: '100001' }, 'Q', '1', {});
    expect(form.get('fb_dtsg')).toBe('D');
    expect(form.get('jazoest')).toBe(`2${'D'.charCodeAt(0)}`);
    expect(form.get('av')).toBe('100001');
  });
});

describe('Playwright failures as AppError', () => {
  const timeout = Object.assign(new Error('page.goto: Timeout 30000ms exceeded.'), { name: 'TimeoutError' });
  const codeOf = (error: AppError) => [error.code, error.message];

  it('maps navigation failures', () => {
    expect(codeOf(navigationError(timeout))).toEqual(['FB_TIMEOUT', 'Facebook took too long to respond.']);
    expect(navigationError(new Error('net::ERR_TOO_MANY_REDIRECTS at https://www.facebook.com/')).code).toBe('FB_BLOCKED');
    // A redirect loop on an item page means the listing is gone.
    const notFound = () => new AppError({ code: 'NOT_FOUND', message: 'gone' });
    expect(navigationError(new Error('net::ERR_TOO_MANY_REDIRECTS'), notFound).code).toBe('NOT_FOUND');
    expect(codeOf(navigationError(new Error('page.goto: net::ERR_INTERNET_DISCONNECTED')))).toEqual([
      'FB_TIMEOUT',
      'Could not reach Facebook (net::ERR_INTERNET_DISCONNECTED).',
    ]);
    expect(codeOf(navigationError(new Error('page.goto: Target page, context or browser has been closed')))).toEqual([
      'INTERNAL',
      'The hidden browser closed unexpectedly.',
    ]);
    expect(navigationError(new Error('something else')).code).toBe('INTERNAL');
    const own = new AppError({ code: 'FB_BLOCKED', message: 'x' });
    expect(navigationError(own)).toBe(own);
  });

  it('maps in-page interaction failures', () => {
    expect(codeOf(interactionError(timeout, 'x', 'Too slow.'))).toEqual(['FB_TIMEOUT', 'Too slow.']);
    expect(interactionError(new Error('Target closed'), 'x').code).toBe('INTERNAL');
    expect(codeOf(interactionError(new Error('Evaluation failed\nstack'), "Couldn't read it"))).toEqual([
      'FB_PARSE_FAILED',
      "Couldn't read it (Evaluation failed)",
    ]);
  });
});

// ---------- pagination ----------

const listing = (id: string): ListingSummary => ({
  id,
  title: `Listing ${id}`,
  price: { amount: 1, formatted: '$1', currency: 'USD' },
  previousPrice: null,
  imageUrl: null,
  location: null,
  createdAt: null,
  status: 'available',
  sellerId: null,
  sellerName: null,
  deliveryTypes: [],
  categoryId: null,
  url: `https://www.facebook.com/marketplace/item/${id}/`,
});

const start: Pagination = { seen: new Set(['1', '2']), cursor: 'c1', hasMore: true, template: null, pagesFetched: 0 };

describe('advance', () => {
  it('returns only listings the session has not returned yet, and moves the cursor', () => {
    const step = advance(start, { listings: [listing('2'), listing('3'), listing('3'), listing('4')], pageInfo: { endCursor: 'c2', hasNextPage: true } });
    expect(step.fresh.map((l) => l.id)).toEqual(['3', '4']);
    expect(step.state).toMatchObject({ cursor: 'c2', hasMore: true, pagesFetched: 1 });
    expect([...step.state.seen]).toEqual(['1', '2', '3', '4']);
    // the input state is not mutated
    expect([...start.seen]).toEqual(['1', '2']);
  });

  it('ends the feed when Facebook says so, when the cursor is missing, or when it did not move', () => {
    expect(advance(start, { listings: [], pageInfo: { endCursor: 'c2', hasNextPage: false } }).state.hasMore).toBe(false);
    expect(advance(start, { listings: [], pageInfo: null }).state).toMatchObject({ hasMore: false, cursor: null });
    expect(advance(start, { listings: [listing('9')], pageInfo: { endCursor: 'c1', hasNextPage: true } }).state.hasMore).toBe(false);
  });
});

describe('replayForm / requestedCursor', () => {
  const captured = new URLSearchParams({
    __req: 'z',
    fb_api_req_friendly_name: 'CometMarketplaceSearchContentPaginationQuery',
    variables: JSON.stringify({ count: 24, cursor: 'c1', params: { bqf: { query: 'bike' } } }),
    doc_id: '42',
  }).toString();

  it("puts our cursor into Facebook's captured request and keeps __req moving", () => {
    const form = replayForm(captured, 'c7', 3);
    expect(form?.get('doc_id')).toBe('42');
    expect(JSON.parse(form?.get('variables') ?? '')).toEqual({ count: 24, cursor: 'c7', params: { bqf: { query: 'bike' } } });
    expect(form?.get('__req')).toBe((parseInt('z', 36) + 3).toString(36));
  });

  it('refuses a request whose variables are not JSON', () => {
    expect(replayForm('variables=%7Bbroken', 'c', 0)).toBeNull();
  });

  it('reads the cursor a captured request asked for', () => {
    expect(requestedCursor(captured)).toBe('c1');
    expect(requestedCursor('variables=%7B%7D')).toBeNull();
    expect(requestedCursor('variables=%7Bbroken')).toBeNull();
    expect(requestedCursor('')).toBeNull();
  });
});
