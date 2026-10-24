// The repositories (port of legacy/test/db.test.ts): settings defaults/merging, favorites
// (originalPrice and savedAt kept on re-save), saved searches (seen rows, newCount after local
// filters, params change resets), hidden listings, blocked sellers, and lenient reads of a file
// database with corrupt rows. Multi-user: every repository keeps owners apart (owner A never sees
// or changes B's rows), and ClientSessionsRepo stores sessions, lists active owners and moves data
// between owners (reassignOwner: the target's row wins a conflict).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { layerFor } from '@/server/db/Database';
import { RepositoriesLayerMemory, repositoriesFor } from '@/server/db/layers';
import { BlockedSellersRepo } from '@/server/db/repositories/BlockedSellersRepo';
import { ClientSessionsRepo, type ClientSessionRow } from '@/server/db/repositories/ClientSessionsRepo';
import { FavoritesRepo } from '@/server/db/repositories/FavoritesRepo';
import { HiddenListingsRepo } from '@/server/db/repositories/HiddenListingsRepo';
import { SavedSearchesRepo, sameSearchParams } from '@/server/db/repositories/SavedSearchesRepo';
import { SettingsRepo } from '@/server/db/repositories/SettingsRepo';
import { loadLocalFilters } from '@/server/filters';
import {
  type ClientSessionId,
  type FbUserId,
  type OwnerKey,
  UNCLAIMED_OWNER,
  accountOwner,
  sessionOwner,
} from '@/server/session/identity';
import { DEFAULT_SETTINGS, type ListingSummary, type SavedSearch, type SearchParams } from '@/shared/domain';

/** The owner most tests use, and a second one for isolation checks. */
const A = accountOwner('1001' as FbUserId);
const B = sessionOwner('browser-b' as ClientSessionId);

const listing = (id: string, overrides: Partial<ListingSummary> = {}): ListingSummary => ({
  id,
  title: `Listing ${id}`,
  price: { amount: 100, formatted: '$100', currency: 'USD' },
  previousPrice: null,
  imageUrl: null,
  location: 'Brooklyn, NY',
  createdAt: null,
  status: 'available',
  sellerId: `seller-${id}`,
  sellerName: 'Sam',
  deliveryTypes: ['IN_PERSON'],
  categoryId: null,
  url: `https://www.facebook.com/marketplace/item/${id}/`,
  ...overrides,
});

const getSaved = (id: number, owner: OwnerKey = A) =>
  Effect.flatMap(SavedSearchesRepo.use((repo) => repo.get(owner, id)), (found) => Effect.sync(() => Option.getOrThrow(found)));

const create = (name: string, params: SearchParams, now: number, autoCheck = true, owner: OwnerKey = A) =>
  SavedSearchesRepo.use((repo) => repo.create(owner, { name, params, autoCheck }, now));

describe('settings', () => {
  it.effect('starts with defaults', () =>
    Effect.gen(function* () {
      expect(yield* SettingsRepo.use((repo) => repo.get(A))).toEqual(DEFAULT_SETTINGS);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('merges updates and keeps the rest', () =>
    Effect.gen(function* () {
      const repo = yield* SettingsRepo;
      const updated = yield* repo.update(A, { checkIntervalMinutes: 15, excludedKeywords: ['crib'] });
      expect(updated).toEqual({ ...DEFAULT_SETTINGS, checkIntervalMinutes: 15, excludedKeywords: ['crib'] });
      yield* repo.update(A, { defaultLocation: { id: 'nyc', name: 'New York' }, defaultRadiusKm: 10 });
      expect(yield* repo.get(A)).toMatchObject({ checkIntervalMinutes: 15, defaultRadiusKm: 10, defaultLocation: { id: 'nyc' } });
      expect((yield* repo.update(A, { defaultRadiusKm: null })).defaultRadiusKm).toBeNull();
      expect((yield* repo.update(A, { defaultLocation: null })).defaultLocation).toBeNull();
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('ignores unknown keys', () =>
    Effect.gen(function* () {
      const repo = yield* SettingsRepo;
      yield* repo.update(A, { bogus: 1 } as never);
      expect(yield* repo.get(A)).toEqual(DEFAULT_SETTINGS);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );
});

describe('favorites', () => {
  it.effect('saves with the original price, newest first', () =>
    Effect.gen(function* () {
      const repo = yield* FavoritesRepo;
      yield* repo.save(A, { listing: listing('1'), note: null }, 1000);
      const fav = yield* repo.save(A, { listing: listing('2'), note: 'ask about delivery' }, 2000);
      expect(fav).toEqual({
        listing: listing('2'),
        savedAt: 2000,
        originalPrice: { amount: 100, formatted: '$100', currency: 'USD' },
        lastCheckedAt: null,
        note: 'ask about delivery',
      });
      expect((yield* repo.list(A)).map((f) => f.listing.id)).toEqual(['2', '1']);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('keeps originalPrice and savedAt when re-saved or refreshed', () =>
    Effect.gen(function* () {
      const repo = yield* FavoritesRepo;
      yield* repo.save(A, { listing: listing('1'), note: null }, 1000);
      const cheaper = listing('1', { price: { amount: 80, formatted: '$80', currency: 'USD' }, status: 'pending' });
      yield* repo.updateListing(A, cheaper, 5000);
      let fav = Option.getOrThrow(yield* repo.get(A, '1'));
      expect(fav.listing.price.amount).toBe(80);
      expect(fav.listing.status).toBe('pending');
      expect(fav.originalPrice.amount).toBe(100);
      expect(fav.lastCheckedAt).toBe(5000);

      fav = yield* repo.save(A, { listing: cheaper, note: 'note' }, 9000);
      expect(fav.savedAt).toBe(1000);
      expect(fav.originalPrice.amount).toBe(100);
      expect(fav.note).toBe('note');
      expect(fav.lastCheckedAt).toBe(5000);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('deletes (idempotently)', () =>
    Effect.gen(function* () {
      const repo = yield* FavoritesRepo;
      yield* repo.save(A, { listing: listing('1'), note: null }, 1);
      expect(yield* repo.remove(A, '1')).toBe(true);
      expect(yield* repo.remove(A, '1')).toBe(false);
      expect(yield* repo.list(A)).toEqual([]);
      expect(Option.isNone(yield* repo.get(A, '1'))).toBe(true);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('refreshing a favorite that is gone is a no-op', () =>
    Effect.gen(function* () {
      const repo = yield* FavoritesRepo;
      yield* repo.updateListing(A, listing('9'), 1);
      expect(yield* repo.list(A)).toEqual([]);
      expect(yield* repo.listAll).toEqual([]);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );
});

describe('saved searches', () => {
  it.effect('creates, lists newest first, patches, and deletes', () =>
    Effect.gen(function* () {
      const repo = yield* SavedSearchesRepo;
      const a = yield* create('Bikes', { query: 'bike' }, 1000);
      expect(a).toEqual({
        id: a.id,
        name: 'Bikes',
        params: { query: 'bike' },
        createdAt: 1000,
        autoCheck: true,
        lastCheckedAt: null,
        lastViewedAt: null,
        newCount: 0,
      } satisfies SavedSearch);
      const b = yield* create('Desks', { query: 'desk' }, 2000, false);
      expect(b.autoCheck).toBe(false);
      expect((yield* repo.list(A)).map((s) => s.id)).toEqual([b.id, a.id]);

      const patched = Option.getOrThrow(yield* repo.update(A, a.id, { name: 'Road bikes', autoCheck: false }));
      expect(patched).toMatchObject({ name: 'Road bikes', autoCheck: false, params: { query: 'bike' } });
      expect(Option.isNone(yield* repo.update(A, 999, { name: 'x' }))).toBe(true);
      expect(yield* repo.remove(A, a.id)).toBe(true);
      expect(yield* repo.remove(A, a.id)).toBe(false);
      expect(Option.isNone(yield* repo.get(A, a.id))).toBe(true);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('counts listings first seen after the last view', () =>
    Effect.gen(function* () {
      const repo = yield* SavedSearchesRepo;
      const s = yield* create('Bikes', { query: 'bike' }, 0);
      // Seed: what exists now is the baseline.
      expect(yield* repo.recordSeen(s.id, [listing('1'), listing('2')], 100)).toBe(2);
      expect(yield* repo.markSeeded(s.id, 100)).toBe(true);
      expect(yield* repo.markSeeded(s.id, 150)).toBe(false);
      expect((yield* getSaved(s.id)).newCount).toBe(0);

      // A later check finds one new listing; already-seen ones keep their first_seen_at.
      expect(yield* repo.recordSeen(s.id, [listing('2'), listing('3')], 200)).toBe(1);
      expect((yield* getSaved(s.id)).newCount).toBe(1);
      expect((yield* repo.seenSince(s.id, 100)).map((l) => l.id)).toEqual(['3']);

      yield* repo.recordSeen(s.id, [listing('4')], 300);
      expect((yield* repo.seenSince(s.id, 100)).map((l) => l.id)).toEqual(['4', '3']);

      yield* repo.markViewed(s.id, 300);
      expect((yield* getSaved(s.id)).newCount).toBe(0);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('applies local filters to newCount', () =>
    Effect.gen(function* () {
      const repo = yield* SavedSearchesRepo;
      const s = yield* create('x', {}, 0);
      yield* repo.markSeeded(s.id, 0);
      yield* repo.recordSeen(s.id, [listing('1', { title: 'Crib' }), listing('2'), listing('3'), listing('4')], 10);
      yield* SettingsRepo.use((settings) => settings.update(A, { excludedKeywords: ['crib'] }));
      yield* HiddenListingsRepo.use((hidden) => hidden.hide(A, { id: '2', title: 'Listing 2' }, 1));
      yield* BlockedSellersRepo.use((blocked) => blocked.block(A, { id: 'seller-3', name: 'Spammer' }, 1));
      expect((yield* getSaved(s.id)).newCount).toBe(1);
      expect((yield* repo.list(A))[0]?.newCount).toBe(1);
      // Another owner's filters don't count.
      yield* HiddenListingsRepo.use((hidden) => hidden.hide(B, { id: '4', title: 'Listing 4' }, 1));
      expect((yield* getSaved(s.id)).newCount).toBe(1);
      expect((yield* repo.listAll).map((entry) => [entry.owner, entry.search.newCount])).toEqual([[A, 1]]);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('refreshes listing data for already-seen rows', () =>
    Effect.gen(function* () {
      const repo = yield* SavedSearchesRepo;
      const s = yield* create('x', {}, 0);
      yield* repo.markSeeded(s.id, 0);
      yield* repo.recordSeen(s.id, [listing('1')], 10);
      expect(yield* repo.recordSeen(s.id, [listing('1', { title: 'Renamed' })], 20)).toBe(0);
      expect(yield* repo.seenSince(s.id, 0)).toEqual([listing('1', { title: 'Renamed' })]);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('forgets seen listings when params change (in any key order)', () =>
    Effect.gen(function* () {
      const repo = yield* SavedSearchesRepo;
      const s = yield* create('x', { query: 'a', maxPrice: 50 }, 0);
      yield* repo.recordSeen(s.id, [listing('1')], 10);
      yield* repo.markSeeded(s.id, 10);
      yield* repo.markChecked(s.id, 10);
      // Same params, keys reordered: nothing is reset.
      const same = Option.getOrThrow(yield* repo.update(A, s.id, { params: { maxPrice: 50, query: 'a' } }));
      expect(same).toMatchObject({ lastViewedAt: 10, lastCheckedAt: 10 });
      const changed = Option.getOrThrow(yield* repo.update(A, s.id, { params: { query: 'b' } }));
      expect(changed).toMatchObject({ lastViewedAt: null, lastCheckedAt: null, params: { query: 'b' } });
      expect(yield* repo.seenSince(s.id, -1)).toEqual([]);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('deletes seen rows with the saved search', () =>
    Effect.gen(function* () {
      const repo = yield* SavedSearchesRepo;
      const s = yield* create('x', {}, 0);
      yield* repo.recordSeen(s.id, [listing('1')], 10);
      yield* repo.remove(A, s.id);
      const again = yield* create('y', {}, 0);
      expect(yield* repo.seenSince(again.id, -1)).toEqual([]);
      expect(yield* repo.seenSince(s.id, -1)).toEqual([]);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('recordCheck: seeds an unseeded search at the current time, then records new listings', () =>
    Effect.gen(function* () {
      const repo = yield* SavedSearchesRepo;
      const s = yield* create('x', { query: 'a' }, 0);
      yield* TestClock.setTime(1000);
      const first = Option.getOrThrow(yield* repo.recordCheck(s, [listing('1'), listing('2')]));
      expect(first).toEqual({ added: 2, seeded: true, at: 1000 });
      expect(yield* getSaved(s.id)).toMatchObject({ lastCheckedAt: 1000, lastViewedAt: 1000, newCount: 0 });

      yield* TestClock.setTime(2000);
      const second = Option.getOrThrow(yield* repo.recordCheck(yield* getSaved(s.id), [listing('2'), listing('3')]));
      expect(second).toEqual({ added: 1, seeded: false, at: 2000 });
      expect(yield* getSaved(s.id)).toMatchObject({ lastCheckedAt: 2000, lastViewedAt: 1000, newCount: 1 });
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('recordCheck records nothing for a deleted search or one whose params changed meanwhile', () =>
    Effect.gen(function* () {
      const repo = yield* SavedSearchesRepo;
      const s = yield* create('x', { query: 'a' }, 0);
      yield* repo.update(A, s.id, { params: { query: 'b' } });
      expect(Option.isNone(yield* repo.recordCheck(s, [listing('1')]))).toBe(true);
      expect(yield* repo.seenSince(s.id, -1)).toEqual([]);
      yield* repo.remove(A, s.id);
      expect(Option.isNone(yield* repo.recordCheck(s, [listing('1')]))).toBe(true);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('viewNew returns what is new since the last view and marks it viewed; unseeded stays unseeded', () =>
    Effect.gen(function* () {
      const repo = yield* SavedSearchesRepo;
      const s = yield* create('x', {}, 0);
      expect(yield* repo.viewNew(A, s.id)).toEqual([]);
      expect((yield* getSaved(s.id)).lastViewedAt).toBeNull();

      yield* repo.recordSeen(s.id, [listing('1')], 10);
      yield* repo.markSeeded(s.id, 10);
      yield* repo.recordSeen(s.id, [listing('2')], 20);
      yield* repo.recordSeen(s.id, [listing('3')], 30);
      yield* TestClock.setTime(40);
      expect((yield* repo.viewNew(A, s.id)).map((l) => l.id)).toEqual(['3', '2']);
      expect(yield* getSaved(s.id)).toMatchObject({ lastViewedAt: 40, newCount: 0 });
      expect(yield* repo.viewNew(A, s.id)).toEqual([]);
      expect(yield* repo.viewNew(A, 12345)).toEqual([]);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('a check in the same millisecond as a view (or after the clock stepped back) still counts as new', () =>
    Effect.gen(function* () {
      const repo = yield* SavedSearchesRepo;
      const s = yield* create('x', { query: 'a' }, 0);
      yield* TestClock.setTime(1000);
      yield* repo.recordCheck(s, [listing('1')]); // baseline at 1000
      expect(yield* repo.viewNew(A, s.id)).toEqual([]); // viewed at 1000 too

      // Same millisecond: recorded at lastViewedAt + 1, so it is new.
      const sameMs = Option.getOrThrow(yield* repo.recordCheck(yield* getSaved(s.id), [listing('2')]));
      expect(sameMs).toEqual({ added: 1, seeded: false, at: 1001 });
      expect((yield* getSaved(s.id)).newCount).toBe(1);

      // The clock steps back: the view still moves past what it reported, so it isn't reported twice.
      yield* TestClock.setTime(500);
      expect((yield* repo.viewNew(A, s.id)).map((l) => l.id)).toEqual(['2']);
      expect(yield* getSaved(s.id)).toMatchObject({ lastViewedAt: 1001, newCount: 0 });
      expect(yield* repo.viewNew(A, s.id)).toEqual([]);
      const afterStepBack = Option.getOrThrow(yield* repo.recordCheck(yield* getSaved(s.id), [listing('3')]));
      expect(afterStepBack.at).toBe(1002);
      expect((yield* repo.viewNew(A, s.id)).map((l) => l.id)).toEqual(['3']);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it('compares params regardless of key order', () => {
    expect(sameSearchParams({ query: 'a', maxPrice: 5 }, { maxPrice: 5, query: 'a' })).toBe(true);
    expect(sameSearchParams({ query: 'a' }, { query: 'a', exact: true })).toBe(false);
    expect(sameSearchParams({ conditions: ['new', 'used_good'] }, { conditions: ['used_good', 'new'] })).toBe(false);
  });
});

describe('hidden listings and blocked sellers', () => {
  it.effect('hides, lists newest first, unhides, clears', () =>
    Effect.gen(function* () {
      const repo = yield* HiddenListingsRepo;
      yield* repo.hide(A, { id: '1', title: 'Old couch' }, 100);
      yield* repo.hide(A, { id: '2', title: 'Lamp' }, 200);
      expect(yield* repo.list(A)).toEqual([
        { id: '2', title: 'Lamp', hiddenAt: 200 },
        { id: '1', title: 'Old couch', hiddenAt: 100 },
      ]);
      expect(yield* repo.hide(A, { id: '1', title: 'Old sofa' }, 300)).toEqual({ id: '1', title: 'Old sofa', hiddenAt: 100 });
      expect([...(yield* repo.ids(A))].sort()).toEqual(['1', '2']);
      expect(yield* repo.unhide(A, '1')).toBe(true);
      expect(yield* repo.unhide(A, '1')).toBe(false);
      yield* repo.clear(A);
      expect(yield* repo.list(A)).toEqual([]);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('blocks and unblocks sellers', () =>
    Effect.gen(function* () {
      const repo = yield* BlockedSellersRepo;
      expect(yield* repo.block(A, { id: 's1', name: 'Spammer' }, 100)).toEqual({ id: 's1', name: 'Spammer', blockedAt: 100 });
      expect(yield* repo.block(A, { id: 's1', name: 'Spam Inc' }, 200)).toEqual({ id: 's1', name: 'Spam Inc', blockedAt: 100 });
      expect(yield* repo.list(A)).toHaveLength(1);
      expect((yield* loadLocalFilters(A)).blockedSellerIds.has('s1')).toBe(true);
      expect(yield* repo.unblock(A, 's1')).toBe(true);
      expect(yield* repo.unblock(A, 's1')).toBe(false);
      expect(yield* repo.list(A)).toEqual([]);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );
});

describe('owner isolation', () => {
  it.effect('settings: each owner has their own', () =>
    Effect.gen(function* () {
      const repo = yield* SettingsRepo;
      yield* repo.update(A, { checkIntervalMinutes: 15 });
      yield* repo.update(B, { excludedKeywords: ['crib'] });
      expect(yield* repo.get(A)).toEqual({ ...DEFAULT_SETTINGS, checkIntervalMinutes: 15 });
      expect(yield* repo.get(B)).toEqual({ ...DEFAULT_SETTINGS, excludedKeywords: ['crib'] });
      expect([...(yield* repo.owners)].sort()).toEqual([A, B].sort());
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect("favorites: owners save the same listing separately; a refresh updates only that owner's copy", () =>
    Effect.gen(function* () {
      const repo = yield* FavoritesRepo;
      yield* repo.save(A, { listing: listing('1'), note: 'mine' }, 10);
      yield* repo.save(B, { listing: listing('1', { price: { amount: 90, formatted: '$90', currency: 'USD' } }), note: null }, 20);
      yield* repo.save(B, { listing: listing('2'), note: null }, 30);
      expect((yield* repo.list(A)).map((f) => [f.listing.id, f.note])).toEqual([['1', 'mine']]);
      expect((yield* repo.list(B)).map((f) => f.listing.id)).toEqual(['2', '1']);
      expect(Option.isNone(yield* repo.get(A, '2'))).toBe(true);

      // B can't remove A's favorite (its own copy goes).
      expect(yield* repo.remove(B, '1')).toBe(true);
      expect(yield* repo.remove(B, '1')).toBe(false);
      expect(Option.isSome(yield* repo.get(A, '1'))).toBe(true);
      yield* repo.save(B, { listing: listing('1'), note: null }, 40);

      yield* repo.updateListing(A, listing('1', { status: 'sold', title: 'A copy' }), 99);
      // listAll: ordered by owner ("fb:..." before "session:..."), then newest first.
      const all = yield* repo.listAll;
      expect(all.map((entry) => [entry.owner, entry.favorite.listing.id])).toEqual([
        [A, '1'],
        [B, '1'],
        [B, '2'],
      ]);
      // B's copy of the same listing is untouched by A's refresh.
      expect(all.map((entry) => [entry.favorite.listing.status, entry.favorite.listing.title])).toEqual([
        ['sold', 'A copy'],
        [listing('1').status, listing('1').title],
        [listing('2').status, listing('2').title],
      ]);
      expect(all.map((entry) => entry.favorite.lastCheckedAt)).toEqual([99, null, null]);
      // Each copy keeps its own originalPrice and note.
      expect(Option.getOrThrow(yield* repo.get(A, '1'))).toMatchObject({ note: 'mine', originalPrice: { amount: 100 } });
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('saved searches: another owner\'s id is missing for get/update/remove/viewNew', () =>
    Effect.gen(function* () {
      const repo = yield* SavedSearchesRepo;
      const mine = yield* create('Bikes', { query: 'bike' }, 10, true, A);
      const theirs = yield* create('Desks', { query: 'desk' }, 20, false, B);
      yield* repo.recordSeen(mine.id, [listing('1')], 30);
      yield* repo.markSeeded(mine.id, 30);
      yield* repo.recordSeen(mine.id, [listing('2')], 40);

      expect((yield* repo.list(A)).map((s) => s.id)).toEqual([mine.id]);
      expect((yield* repo.list(B)).map((s) => s.id)).toEqual([theirs.id]);
      expect(Option.isNone(yield* repo.get(B, mine.id))).toBe(true);
      expect(Option.isNone(yield* repo.update(B, mine.id, { name: 'Stolen', params: { query: 'x' } }))).toBe(true);
      expect(yield* repo.remove(B, mine.id)).toBe(false);
      expect(yield* repo.viewNew(B, mine.id)).toEqual([]);

      // Untouched: same name and params, still one new listing, not viewed.
      expect(yield* getSaved(mine.id, A)).toMatchObject({ name: 'Bikes', params: { query: 'bike' }, newCount: 1, lastViewedAt: 30 });
      expect((yield* repo.viewNew(A, mine.id)).map((l) => l.id)).toEqual(['2']);
      expect((yield* repo.listAll).map((entry) => [entry.owner, entry.search.id, entry.search.newCount])).toEqual([
        [A, mine.id, 0],
        [B, theirs.id, 0],
      ]);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('hidden listings and blocked sellers are per owner', () =>
    Effect.gen(function* () {
      const hidden = yield* HiddenListingsRepo;
      const blocked = yield* BlockedSellersRepo;
      yield* hidden.hide(A, { id: '1', title: 'Couch' }, 10);
      yield* hidden.hide(B, { id: '1', title: 'Sofa' }, 20);
      yield* hidden.hide(B, { id: '2', title: 'Lamp' }, 30);
      expect(yield* hidden.list(A)).toEqual([{ id: '1', title: 'Couch', hiddenAt: 10 }]);
      expect(yield* hidden.unhide(A, '2')).toBe(false);
      yield* hidden.clear(A);
      expect(yield* hidden.list(A)).toEqual([]);
      expect([...(yield* hidden.ids(B))].sort()).toEqual(['1', '2']);

      yield* blocked.block(A, { id: 's1', name: 'Spammer' }, 10);
      expect(yield* blocked.list(B)).toEqual([]);
      expect(yield* blocked.unblock(B, 's1')).toBe(false);
      expect([...(yield* blocked.ids(A))]).toEqual(['s1']);
      expect((yield* loadLocalFilters(B)).blockedSellerIds.size).toBe(0);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );
});

describe('client sessions', () => {
  const row = (id: string, overrides: Partial<ClientSessionRow> = {}): ClientSessionRow => ({
    id: id as ClientSessionId,
    tokenHash: `hash-${id}`,
    unlockedWith: null,
    fbUserId: null,
    createdAt: 0,
    lastSeenAt: 0,
    ...overrides,
  });

  it.effect('stores sessions and changes them field by field', () =>
    Effect.gen(function* () {
      const repo = yield* ClientSessionsRepo;
      yield* repo.insert(row('a'));
      yield* repo.insert(row('b', { createdAt: 5 }));
      yield* repo.setTokenHash('a' as ClientSessionId, 'hash-a2');
      yield* repo.setUnlockedWith('a' as ClientSessionId, 'fingerprint');
      yield* repo.setAccount('a' as ClientSessionId, '42' as FbUserId);
      yield* repo.touch('a' as ClientSessionId, 77);
      expect(yield* repo.list).toEqual([
        row('a', { tokenHash: 'hash-a2', unlockedWith: 'fingerprint', fbUserId: '42' as FbUserId, lastSeenAt: 77 }),
        row('b', { createdAt: 5 }),
      ]);
      yield* repo.setAccount('a' as ClientSessionId, null);
      yield* repo.setUnlockedWith('a' as ClientSessionId, null);
      yield* repo.remove('b' as ClientSessionId);
      yield* repo.remove('never-existed' as ClientSessionId);
      expect(yield* repo.list).toEqual([row('a', { tokenHash: 'hash-a2', lastSeenAt: 77 })]);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('activeOwners: accounts with a recently seen session, and recently seen unbound sessions', () =>
    Effect.gen(function* () {
      const repo = yield* ClientSessionsRepo;
      yield* repo.insert(row('phone', { fbUserId: '7' as FbUserId, lastSeenAt: 100 }));
      yield* repo.insert(row('laptop', { fbUserId: '7' as FbUserId, lastSeenAt: 500 }));
      yield* repo.insert(row('old', { fbUserId: '8' as FbUserId, lastSeenAt: 10 }));
      yield* repo.insert(row('guest', { lastSeenAt: 300 }));
      yield* repo.insert(row('stale-guest', { lastSeenAt: 20 }));
      expect(yield* repo.activeOwners(100)).toEqual(['fb:7', 'session:guest']);
      expect(yield* repo.activeOwners(0)).toEqual(['fb:7', 'fb:8', 'session:guest', 'session:stale-guest']);
      expect(yield* repo.activeOwners(1000)).toEqual([]);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('meta: getOrInsertMeta keeps the first value', () =>
    Effect.gen(function* () {
      const repo = yield* ClientSessionsRepo;
      expect(Option.isNone(yield* repo.getMeta('unlock_salt'))).toBe(true);
      expect(yield* repo.getOrInsertMeta('unlock_salt', 'first')).toBe('first');
      expect(yield* repo.getOrInsertMeta('unlock_salt', 'second')).toBe('first');
      expect(yield* repo.getMeta('unlock_salt')).toEqual(Option.some('first'));
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('reassignOwner moves every kind of row; the target wins a conflict', () =>
    Effect.gen(function* () {
      const sessions = yield* ClientSessionsRepo;
      const settings = yield* SettingsRepo;
      const favorites = yield* FavoritesRepo;
      const hidden = yield* HiddenListingsRepo;
      const blocked = yield* BlockedSellersRepo;
      const searches = yield* SavedSearchesRepo;

      // B (the browser) has data; A (the account) already has some of the same keys.
      yield* settings.update(B, { checkIntervalMinutes: 15, sessionNudgeMinutes: 5 });
      yield* settings.update(A, { checkIntervalMinutes: 120 });
      yield* favorites.save(B, { listing: listing('1'), note: 'from the browser' }, 10);
      yield* favorites.save(B, { listing: listing('2'), note: null }, 11);
      yield* favorites.save(A, { listing: listing('1'), note: 'from the account' }, 5);
      yield* hidden.hide(B, { id: '3', title: 'Lamp' }, 12);
      yield* blocked.block(B, { id: 's9', name: 'Spammer' }, 13);
      yield* blocked.block(A, { id: 's9', name: 'Known spammer' }, 6);
      const search = yield* create('Bikes', { query: 'bike' }, 14, true, B);
      yield* searches.recordSeen(search.id, [listing('5')], 15);

      // settings.sessionNudgeMinutes, favorite 2, hidden 3, the saved search = 4 rows moved.
      expect(yield* sessions.reassignOwner(B, A)).toBe(4);

      expect(yield* settings.get(A)).toMatchObject({ checkIntervalMinutes: 120, sessionNudgeMinutes: 5 });
      expect(yield* settings.get(B)).toEqual(DEFAULT_SETTINGS);
      expect((yield* favorites.list(A)).map((f) => [f.listing.id, f.note])).toEqual([
        ['2', null],
        ['1', 'from the account'],
      ]);
      expect(yield* favorites.list(B)).toEqual([]);
      expect((yield* hidden.list(A)).map((h) => h.id)).toEqual(['3']);
      expect(yield* blocked.list(A)).toEqual([{ id: 's9', name: 'Known spammer', blockedAt: 6 }]);
      expect(yield* blocked.list(B)).toEqual([]);
      // The saved search keeps its id and seen listings.
      expect((yield* searches.list(A)).map((s) => s.id)).toEqual([search.id]);
      expect((yield* searches.seenSince(search.id, 0)).map((l) => l.id)).toEqual(['5']);
      expect(yield* searches.list(B)).toEqual([]);

      expect(yield* sessions.reassignOwner(B, A)).toBe(0);
      expect(yield* sessions.reassignOwner(A, A)).toBe(0);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('reassignOwner keeps the earlier save of a shared favorite and drops duplicate saved searches', () =>
    Effect.gen(function* () {
      const sessions = yield* ClientSessionsRepo;
      const favorites = yield* FavoritesRepo;
      const searches = yield* SavedSearchesRepo;

      // The browser saved listing 1 first, at $100; the account saved it later at $80.
      yield* favorites.save(B, { listing: listing('1'), note: 'watching' }, 10);
      const later = listing('1', { price: { amount: 80, formatted: '$80', currency: 'USD' } });
      yield* favorites.save(A, { listing: later, note: null }, 50);
      // Both saved "bike" (keys in another order); only the browser saved "desk".
      yield* create('Bikes', { query: 'bike', radiusKm: 10 }, 60, true, A);
      const duplicate = yield* create('My bikes', { radiusKm: 10, query: 'bike' }, 61, true, B);
      yield* searches.recordSeen(duplicate.id, [listing('7')], 62);
      const desk = yield* create('Desks', { query: 'desk' }, 63, true, B);

      yield* sessions.reassignOwner(B, A);

      const [merged] = yield* favorites.list(A);
      expect(merged).toMatchObject({ savedAt: 10, originalPrice: { amount: 100 }, note: 'watching', listing: { price: { amount: 80 } } });
      expect((yield* searches.list(A)).map((s) => s.name).sort()).toEqual(['Bikes', 'Desks']);
      expect(Option.isNone(yield* searches.get(A, duplicate.id))).toBe(true);
      expect(yield* searches.seenSince(duplicate.id, 0)).toEqual([]);
      expect(Option.isSome(yield* searches.get(A, desk.id))).toBe(true);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('hasUnclaimedData sees rows from before multi-user support until they are claimed', () =>
    Effect.gen(function* () {
      const sessions = yield* ClientSessionsRepo;
      expect(yield* sessions.hasUnclaimedData).toBe(false);
      yield* HiddenListingsRepo.use((repo) => repo.hide(UNCLAIMED_OWNER, { id: '1', title: 'Old' }, 1));
      expect(yield* sessions.hasUnclaimedData).toBe(true);
      expect(yield* sessions.reassignOwner(UNCLAIMED_OWNER, A)).toBe(1);
      expect(yield* sessions.hasUnclaimedData).toBe(false);
      yield* create('Old search', {}, 1, true, UNCLAIMED_OWNER);
      expect(yield* sessions.hasUnclaimedData).toBe(true);
    }).pipe(Effect.provide(RepositoriesLayerMemory)),
  );
});

describe('file database', () => {
  const withDir = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), 'faceslop-repo-'))),
      use,
      (dir) =>
        Effect.sync(() => {
          fs.rmSync(dir, { recursive: true, force: true });
        }),
    );
  /** A fresh connection to the file each time (like a restart). */
  const openFile = (file: string) => Layer.fresh(repositoriesFor(layerFor(file)));

  it.effect('migrates once and persists across reopen', () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, 'faceslop.db');
        yield* FavoritesRepo.use((repo) => repo.save(A, { listing: listing('1'), note: null }, 1)).pipe(Effect.provide(openFile(file)));
        const favorites = yield* FavoritesRepo.use((repo) => repo.list(A)).pipe(Effect.provide(openFile(file)));
        expect(favorites).toHaveLength(1);
      }),
    ),
  );

  it.effect('skips rows with corrupt JSON and ignores bad setting values instead of failing', () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, 'faceslop.db');
        const created = yield* Effect.gen(function* () {
          yield* FavoritesRepo.use((repo) => repo.save(A, { listing: listing('1'), note: null }, 1));
          yield* FavoritesRepo.use((repo) => repo.save(A, { listing: listing('2'), note: null }, 2));
          yield* SettingsRepo.use((repo) => repo.update(A, { checkIntervalMinutes: 30, sessionNudgeMinutes: 10 }));
          const saved = yield* create('x', { query: 'a' }, 0);
          yield* SavedSearchesRepo.use((repo) => repo.recordSeen(saved.id, [listing('7'), listing('8')], 5));
          return saved;
        }).pipe(Effect.provide(openFile(file)));

        const raw = new DatabaseSync(file);
        raw.prepare("UPDATE favorites SET listing_json = '{oops' WHERE listing_id = '1'").run();
        raw.prepare("UPDATE favorites SET original_price_json = 'nope' WHERE listing_id = '2'").run();
        raw.prepare("UPDATE saved_searches SET params_json = 'nope'").run();
        raw.prepare("UPDATE saved_search_seen SET listing_json = '[]' WHERE listing_id = '7'").run();
        raw.prepare("UPDATE settings SET value = '\"sixty\"' WHERE key = 'checkIntervalMinutes'").run();
        raw.prepare(`INSERT INTO settings (owner, key, value) VALUES ('${A}', 'bogus', '1')`).run();
        raw.close();

        yield* Effect.gen(function* () {
          const favorites = yield* FavoritesRepo.use((repo) => repo.list(A));
          expect(favorites.map((f) => f.listing.id)).toEqual(['2']);
          // Unusable original price: falls back to the listing's price.
          expect(favorites[0]?.originalPrice).toEqual(listing('2').price);
          expect((yield* getSaved(created.id)).params).toEqual({});
          expect((yield* SavedSearchesRepo.use((repo) => repo.seenSince(created.id, 0))).map((l) => l.id)).toEqual(['8']);
          const settings = yield* SettingsRepo.use((repo) => repo.get(A));
          expect(settings.checkIntervalMinutes).toBe(DEFAULT_SETTINGS.checkIntervalMinutes);
          expect(settings.sessionNudgeMinutes).toBe(10);
        }).pipe(Effect.provide(openFile(file)));
      }),
    ),
  );

  it.effect('reads a listing stored without the optional fields (legacy rows)', () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, 'faceslop.db');
        yield* SettingsRepo.use((repo) => repo.get(A)).pipe(Effect.provide(openFile(file)));
        const raw = new DatabaseSync(file);
        raw
          .prepare('INSERT INTO favorites (owner, listing_id, listing_json, original_price_json, note, saved_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(A, '5', JSON.stringify({ id: '5', title: 'Old', price: { amount: 3, formatted: '$3' }, url: 'https://www.facebook.com/marketplace/item/5/' }), JSON.stringify({ amount: 3, formatted: '$3', currency: null }), null, 7);
        raw.close();
        const [favorite] = yield* FavoritesRepo.use((repo) => repo.list(A)).pipe(Effect.provide(openFile(file)));
        expect(favorite?.listing).toEqual({
          id: '5',
          title: 'Old',
          price: { amount: 3, formatted: '$3', currency: null },
          previousPrice: null,
          imageUrl: null,
          location: null,
          createdAt: null,
          status: 'unknown',
          sellerId: null,
          sellerName: null,
          deliveryTypes: [],
          categoryId: null,
          url: 'https://www.facebook.com/marketplace/item/5/',
        });
      }),
    ),
  );
});
