import { Exit, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  FavoriteInput,
  ListingRequest,
  SavedSearchInput,
  SearchParams,
  SendMessageInput,
  SettingsPatch,
  normalizeKeywords,
} from '@/shared/domain';
import {
  OpenRemoteViewRequest,
  RemoteInputEvent,
  decodeRemoteSseMessage,
  encodeRemoteSseMessage,
  type RemoteStreamEvent,
} from '@/shared/remote-view';

const decode = <T, E>(schema: Schema.Codec<T, E, never, unknown>, input: unknown) =>
  Schema.decodeUnknownExit(schema)(input, { errors: 'all' });

const ok = <T, E>(schema: Schema.Codec<T, E, never, unknown>, input: unknown): T => {
  const exit = decode(schema, input);
  if (Exit.isFailure(exit)) throw new Error(`expected success: ${String(exit.cause)}`);
  return exit.value;
};

const fails = <T, E>(schema: Schema.Codec<T, E, never, unknown>, input: unknown) => {
  expect(Exit.isFailure(decode(schema, input))).toBe(true);
};

const listing = {
  id: '1234567890',
  title: 'Road bike',
  price: { amount: 60, formatted: '$60', currency: 'USD' },
  previousPrice: null,
  imageUrl: 'https://scontent.example/x.jpg',
  location: 'Brooklyn, NY',
  createdAt: 1_700_000_000_000,
  status: 'available',
  sellerId: '42',
  sellerName: 'Sam',
  deliveryTypes: ['IN_PERSON'],
  categoryId: null,
  url: 'https://www.facebook.com/marketplace/item/1234567890/',
};

describe('SearchParams', () => {
  it('trims the query, drops it when empty, de-duplicates conditions, drops unknown keys', () => {
    expect(ok(SearchParams, { query: '  bike ', conditions: ['new', 'new', 'used_good'], junk: 1 })).toEqual({
      query: 'bike',
      conditions: ['new', 'used_good'],
    });
    expect(ok(SearchParams, { query: '   ', conditions: [] })).toEqual({});
  });

  it('enforces legacy limits', () => {
    fails(SearchParams, { radiusKm: 0 });
    fails(SearchParams, { radiusKm: 501 });
    fails(SearchParams, { minPrice: -1 });
    fails(SearchParams, { minPrice: 1.5 });
    fails(SearchParams, { minPrice: 10, maxPrice: 5 });
    fails(SearchParams, { sortBy: 'random' });
    fails(SearchParams, { daysSinceListed: 2 });
    fails(SearchParams, { location: 'new york' });
    fails(SearchParams, { query: 'x'.repeat(201) });
    expect(ok(SearchParams, { location: 'nyc', radiusKm: 500, minPrice: 0, maxPrice: 0, exact: true })).toEqual({
      location: 'nyc',
      radiusKm: 500,
      minPrice: 0,
      maxPrice: 0,
      exact: true,
    });
  });
});

describe('ids and messages', () => {
  it('accepts numeric listing ids only', () => {
    ok(ListingRequest, { id: '1234567890123456' });
    fails(ListingRequest, { id: 'abc' });
    fails(ListingRequest, { id: '1'.repeat(26) });
  });

  it('trims messages and requires 1..1000 characters', () => {
    expect(ok(SendMessageInput, { listingId: '1', text: '  hi  ' }).text).toBe('hi');
    fails(SendMessageInput, { listingId: '1', text: '   ' });
    fails(SendMessageInput, { listingId: '1', text: 'x'.repeat(1001) });
  });
});

describe('local data inputs', () => {
  it('normalizes favorite notes to null and validates the listing', () => {
    expect(ok(FavoriteInput, { listing }).note).toBeNull();
    expect(ok(FavoriteInput, { listing, note: '  ' }).note).toBeNull();
    expect(ok(FavoriteInput, { listing, note: ' nice ' }).note).toBe('nice');
    fails(FavoriteInput, { listing: { ...listing, url: 'javascript:alert(1)' } });
  });

  it('defaults autoCheck to true and requires a name', () => {
    expect(ok(SavedSearchInput, { name: ' Bikes ', params: { query: 'bike' } })).toEqual({
      name: 'Bikes',
      params: { query: 'bike' },
      autoCheck: true,
    });
    fails(SavedSearchInput, { name: '  ', params: {} });
  });

  it('applies settings ranges and normalizes keywords', () => {
    expect(ok(SettingsPatch, { excludedKeywords: ['  Bike  Rack ', 'bike rack', ''] })).toEqual({
      excludedKeywords: ['bike rack'],
    });
    expect(ok(SettingsPatch, { checkIntervalMinutes: 0 }).checkIntervalMinutes).toBe(0);
    fails(SettingsPatch, { checkIntervalMinutes: 5 });
    fails(SettingsPatch, { checkIntervalMinutes: 1441 });
    fails(SettingsPatch, { sessionNudgeMinutes: 241 });
    fails(SettingsPatch, { defaultRadiusKm: 0 });
    fails(SettingsPatch, { excludedKeywords: Array.from({ length: 101 }, (_, i) => `k${String(i)}`) });
    expect(normalizeKeywords(['A  b', 'a b', ' '])).toEqual(['a b']);
  });
});

describe('remote view protocol', () => {
  it('requires a listing id for the listing target', () => {
    fails(OpenRemoteViewRequest, { target: 'listing' });
    ok(OpenRemoteViewRequest, { target: 'listing', listingId: '123' });
    ok(OpenRemoteViewRequest, { target: 'login' });
    fails(OpenRemoteViewRequest, { target: 'feed' });
  });

  it('decodes each input event kind', () => {
    ok(RemoteInputEvent, { _tag: 'mouse', action: 'click', x: 10, y: 20, button: 'left', clickCount: 1 });
    ok(RemoteInputEvent, { _tag: 'wheel', x: 10, y: 20, deltaX: 0, deltaY: -120 });
    ok(RemoteInputEvent, { _tag: 'key', action: 'press', key: 'Enter', modifiers: { alt: false, ctrl: false, meta: false, shift: false } });
    ok(RemoteInputEvent, { _tag: 'text', text: 'hello' });
    ok(RemoteInputEvent, { _tag: 'navigate', action: 'back' });
    fails(RemoteInputEvent, { _tag: 'mouse', action: 'click', x: -1, y: 0, button: 'left', clickCount: 1 });
    fails(RemoteInputEvent, { _tag: 'text', text: '' });
    fails(RemoteInputEvent, { _tag: 'scroll' });
  });

  it('round-trips SSE messages', () => {
    const events: RemoteStreamEvent[] = [
      { _tag: 'frame', data: 'AAAA', width: 1100, height: 860 },
      { _tag: 'state', open: true, target: 'inbox', url: 'https://www.facebook.com/marketplace/inbox/', title: 'Inbox', width: 1100, height: 860 },
      { _tag: 'closed' },
    ];
    for (const event of events) {
      const message = encodeRemoteSseMessage(event);
      const name = /^event: (\w+)\n/.exec(message)?.[1] ?? '';
      const data = /\ndata: (.*)\n\n$/.exec(message)?.[1] ?? '';
      expect(decodeRemoteSseMessage(name, data)).toEqual(event);
    }
    expect(decodeRemoteSseMessage('frame', '{"data":1}')).toBeNull();
    expect(decodeRemoteSseMessage('frame', 'not json')).toBeNull();
  });
});
