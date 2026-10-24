// Sessions on its own (replaces the AppAuth tests): browser sessions and their tokens (only
// hashes stored), the APP_PASSWORD gate (throttled per address and globally, unlocks that never
// expire but end when the password changes), binding a browser to a Facebook account (its data
// moves to the account; rows from before multi-user support go to the first account), and what
// counts as a browser in use (seen unlocked within 30 days: the checker's active owners, and the
// bound browsers that keep an account's Facebook cookies on logout elsewhere).
import { describe, expect, it } from '@effect/vitest';
import { Clock, Context, Effect, Layer, Option, Redacted } from 'effect';
import { TestClock } from 'effect/testing';
import { AppConfig } from '@/server/config';
import { RepositoriesLayerMemory } from '@/server/db/layers';
import { ACTIVE_SESSION_WINDOW_MS, ClientSessionsRepo } from '@/server/db/repositories/ClientSessionsRepo';
import { FavoritesRepo } from '@/server/db/repositories/FavoritesRepo';
import { HiddenListingsRepo } from '@/server/db/repositories/HiddenListingsRepo';
import { SettingsRepo } from '@/server/db/repositories/SettingsRepo';
import { type FbUserId, UNCLAIMED_OWNER, accountOwner, sessionOwner } from '@/server/session/identity';
import { Sessions, hashToken } from '@/server/session/Sessions';
import type { ListingSummary } from '@/shared/domain';

const DAY_MS = 24 * 60 * 60 * 1000;
const ALICE = '1001' as FbUserId;
const BOB = '2002' as FbUserId;

/** A fresh Sessions (as after a restart) over the test's database. */
const buildSessions = (password: string | null) =>
  Effect.map(
    Layer.build(
      Layer.fresh(
        Sessions.layerNoDeps.pipe(
          Layer.provide(
            AppConfig.layerTest({
              dataDir: '/nonexistent/faceslop-test',
              appPassword: password === null ? Option.none() : Option.some(Redacted.make(password)),
            }),
          ),
        ),
      ),
    ),
    (context) => Context.get(context, Sessions),
  );

const unlock = (sessions: Sessions['Service'], token: string | undefined, password: string, address: string | null = '10.0.0.1') =>
  sessions.unlock(token, Redacted.make(password), address);

const resolved = (sessions: Sessions['Service'], token: string | undefined) =>
  Effect.map(sessions.resolve(token), Option.getOrNull);

const storedRows = ClientSessionsRepo.use((repo) => repo.list);

/** The owners the checker works for right now. */
const activeOwnersNow = Effect.flatMap(Clock.currentTimeMillis, (now) =>
  ClientSessionsRepo.use((repo) => repo.activeOwners(now - ACTIVE_SESSION_WINDOW_MS)),
);

const listing = (id: string): ListingSummary => ({
  id,
  title: `Listing ${id}`,
  price: { amount: 10, formatted: '$10', currency: 'USD' },
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

describe('Sessions: browser sessions', () => {
  it.effect('creates sessions with random tokens, stores only their SHA-256, and resolves them', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const sessions = yield* buildSessions(null);
      expect(sessions.passwordRequired).toBe(false);

      const first = yield* sessions.create;
      const second = yield* sessions.create;
      expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first.session.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(first.token).not.toBe(second.token);
      expect(first.session.id).not.toBe(second.session.id);
      // No password: every session is unlocked.
      expect(first.session).toEqual({ id: first.session.id, unlocked: true, fbUserId: null });

      expect(yield* resolved(sessions, first.token)).toEqual(first.session);
      expect(yield* resolved(sessions, 'forged')).toBeNull();
      expect(yield* resolved(sessions, '')).toBeNull();
      expect(yield* resolved(sessions, undefined)).toBeNull();
      expect(yield* sessions.get(second.session.id)).toEqual(Option.some(second.session));
      expect(Option.isNone(yield* sessions.get(first.token as never))).toBe(true);

      const rows = yield* storedRows;
      expect(rows.map((row) => row.tokenHash).sort()).toEqual([hashToken(first.token), hashToken(second.token)].sort());
      expect(rows.some((row) => row.tokenHash === first.token || row.id === first.token)).toBe(false);
      expect(hashToken(first.token)).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]).toMatchObject({ unlockedWith: null, fbUserId: null, createdAt: 1_000, lastSeenAt: 1_000 });
    }).pipe(Effect.scoped, Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('keeps sessions across restarts and refreshes last_seen_at at most once a day', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const first = yield* buildSessions(null);
      const issued = yield* first.create;
      yield* first.bindAccount(issued.session.id, ALICE);

      yield* TestClock.adjust(400 * DAY_MS); // unlocks and sessions never expire
      const restarted = yield* buildSessions(null);
      expect(yield* resolved(restarted, issued.token)).toEqual({ id: issued.session.id, unlocked: true, fbUserId: ALICE });
      const seen = 1_000 + 400 * DAY_MS;
      expect((yield* storedRows)[0]?.lastSeenAt).toBe(seen);

      yield* TestClock.adjust(DAY_MS - 1);
      yield* restarted.resolve(issued.token);
      expect((yield* storedRows)[0]?.lastSeenAt).toBe(seen);
      yield* TestClock.adjust(2);
      yield* restarted.resolve(issued.token);
      expect((yield* storedRows)[0]?.lastSeenAt).toBe(seen + DAY_MS + 1);
    }).pipe(Effect.scoped, Effect.provide(RepositoriesLayerMemory)),
  );
});

describe('Sessions: APP_PASSWORD', () => {
  it.effect('refuses to unlock when no password is set', () =>
    Effect.gen(function* () {
      const sessions = yield* buildSessions(null);
      expect(yield* Effect.flip(unlock(sessions, undefined, 'x'))).toMatchObject({ code: 'BAD_REQUEST' });
    }).pipe(Effect.scoped, Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('new sessions start locked; unlocking re-issues the token (or creates a session)', () =>
    Effect.gen(function* () {
      const sessions = yield* buildSessions('hunter2');
      expect(sessions.passwordRequired).toBe(true);

      const locked = yield* sessions.create;
      expect(locked.session.unlocked).toBe(false);
      expect(yield* Effect.flip(unlock(sessions, locked.token, 'wrong'))).toMatchObject({
        code: 'FORBIDDEN',
        message: 'Wrong password.',
      });
      expect((yield* resolved(sessions, locked.token))?.unlocked).toBe(false);

      const unlocked = yield* unlock(sessions, locked.token, 'hunter2');
      expect(unlocked.session).toEqual({ id: locked.session.id, unlocked: true, fbUserId: null });
      expect(unlocked.token).not.toBe(locked.token);
      // The old token is gone: whoever held it doesn't inherit the unlock.
      expect(yield* resolved(sessions, locked.token)).toBeNull();
      expect(yield* resolved(sessions, unlocked.token)).toEqual(unlocked.session);

      // No (or an unknown) token: a new, unlocked session.
      const fresh = yield* unlock(sessions, undefined, 'hunter2');
      expect(fresh.session.unlocked).toBe(true);
      expect(fresh.session.id).not.toBe(locked.session.id);
      const unknown = yield* unlock(sessions, 'forged', 'hunter2');
      expect(unknown.session.id).not.toBe(fresh.session.id);
      expect((yield* storedRows).length).toBe(3);
    }).pipe(Effect.scoped, Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('throttles 5 failures a minute per address, even for the right password, then recovers', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const sessions = yield* buildSessions('hunter2');
      for (let i = 0; i < 5; i++) {
        expect(yield* Effect.flip(unlock(sessions, undefined, `wrong${String(i)}`, '10.0.0.1'))).toMatchObject({
          code: 'FORBIDDEN',
          message: 'Wrong password.',
        });
        yield* TestClock.adjust(1000);
      }
      // The oldest failure was 5 s ago: 55 s to wait.
      expect(yield* Effect.flip(unlock(sessions, undefined, 'hunter2', '10.0.0.1'))).toMatchObject({
        code: 'FORBIDDEN',
        message: 'Too many wrong passwords. Try again in 55s.',
      });
      // Another address isn't affected.
      expect((yield* unlock(sessions, undefined, 'hunter2', '10.0.0.2')).session.unlocked).toBe(true);

      yield* TestClock.adjust(56_000);
      // The oldest failures aged out: the right password works again and clears this address's failures.
      expect((yield* unlock(sessions, undefined, 'hunter2', '10.0.0.1')).session.unlocked).toBe(true);
      for (let i = 0; i < 4; i++) yield* Effect.flip(unlock(sessions, undefined, 'nope', '10.0.0.1'));
      expect((yield* unlock(sessions, undefined, 'hunter2', '10.0.0.1')).session.unlocked).toBe(true);

      // Unknown addresses share one bucket.
      for (let i = 0; i < 5; i++) yield* Effect.flip(unlock(sessions, undefined, 'nope', null));
      expect(yield* Effect.flip(unlock(sessions, undefined, 'hunter2', null))).toMatchObject({ code: 'FORBIDDEN' });
    }).pipe(Effect.scoped, Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('caps wrong passwords at 30 a minute across all addresses', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const sessions = yield* buildSessions('hunter2');
      for (let i = 0; i < 30; i++) {
        expect(yield* Effect.flip(unlock(sessions, undefined, 'guess', `10.0.1.${String(i)}`))).toMatchObject({
          message: 'Wrong password.',
        });
      }
      yield* TestClock.adjust(10_000);
      expect(yield* Effect.flip(unlock(sessions, undefined, 'hunter2', '192.168.1.1'))).toMatchObject({
        code: 'FORBIDDEN',
        message: 'Too many wrong passwords. Try again in 50s.',
      });
      yield* TestClock.adjust(50_000);
      expect((yield* unlock(sessions, undefined, 'hunter2', '192.168.1.1')).session.unlocked).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('an unlock lasts until APP_PASSWORD changes (a scrypt fingerprint with a per-install salt)', () =>
    Effect.gen(function* () {
      const underX = yield* buildSessions('correct horse');
      const issued = yield* unlock(underX, undefined, 'correct horse');
      const [row] = yield* storedRows;
      expect(row?.unlockedWith).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.unlockedWith).not.toContain('correct horse');
      const salt = yield* ClientSessionsRepo.use((repo) => repo.getMeta('unlock_salt'));
      expect(Option.isSome(salt)).toBe(true);

      // Same password after a restart: still unlocked.
      expect((yield* resolved(yield* buildSessions('correct horse'), issued.token))?.unlocked).toBe(true);
      // A new password: locked (the session itself survives) until the new one is entered.
      const underY = yield* buildSessions('battery staple');
      expect(yield* resolved(underY, issued.token)).toEqual({ id: issued.session.id, unlocked: false, fbUserId: null });
      expect(yield* Effect.flip(unlock(underY, issued.token, 'correct horse'))).toMatchObject({ code: 'FORBIDDEN' });
      const again = yield* unlock(underY, issued.token, 'battery staple');
      expect(again.session).toEqual({ id: issued.session.id, unlocked: true, fbUserId: null });
      // Back to the old password: locked again. No password at all: unlocked.
      expect((yield* resolved(yield* buildSessions('correct horse'), again.token))?.unlocked).toBe(false);
      expect((yield* resolved(yield* buildSessions(null), again.token))?.unlocked).toBe(true);
      // The salt was created once.
      expect(yield* ClientSessionsRepo.use((repo) => repo.getMeta('unlock_salt'))).toEqual(salt);
    }).pipe(Effect.scoped, Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('only unlocked browsers count as seen: one locked out by a new APP_PASSWORD stops keeping its account active', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const underX = yield* buildSessions('hunter2');
      const roommate = yield* unlock(underX, undefined, 'hunter2');
      yield* underX.bindAccount(roommate.session.id, BOB);
      expect(yield* activeOwnersNow).toEqual([accountOwner(BOB)]);

      // APP_PASSWORD changes. The roommate's browser keeps loading the password screen: that isn't
      // using the app, so last_seen_at stays put and the account drops out after 30 days.
      const underY = yield* buildSessions('new password');
      yield* TestClock.adjust(2 * DAY_MS);
      expect(yield* resolved(underY, roommate.token)).toEqual({ id: roommate.session.id, unlocked: false, fbUserId: BOB });
      expect((yield* storedRows)[0]?.lastSeenAt).toBe(1_000);
      expect(yield* activeOwnersNow).toEqual([accountOwner(BOB)]);
      yield* TestClock.adjust(29 * DAY_MS);
      yield* underY.resolve(roommate.token);
      expect((yield* storedRows)[0]?.lastSeenAt).toBe(1_000);
      expect(yield* activeOwnersNow).toEqual([]);

      // Entering the new password: in use (and seen) again.
      const again = yield* unlock(underY, roommate.token, 'new password');
      yield* underY.resolve(again.token);
      expect((yield* storedRows)[0]?.lastSeenAt).toBe(1_000 + 31 * DAY_MS);
      expect(yield* activeOwnersNow).toEqual([accountOwner(BOB)]);
    }).pipe(Effect.scoped, Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('lock: this browser has to enter the password again; its Facebook binding stays', () =>
    Effect.gen(function* () {
      const sessions = yield* buildSessions('hunter2');
      const issued = yield* unlock(sessions, undefined, 'hunter2');
      yield* sessions.bindAccount(issued.session.id, ALICE);
      yield* sessions.lock(issued.session.id);
      expect(yield* resolved(sessions, issued.token)).toEqual({ id: issued.session.id, unlocked: false, fbUserId: ALICE });
      expect((yield* storedRows)[0]?.unlockedWith).toBeNull();
      yield* sessions.lock(issued.session.id);
      yield* sessions.lock('unknown' as never);
      expect((yield* resolved(yield* buildSessions('hunter2'), issued.token))?.unlocked).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(RepositoriesLayerMemory)),
  );
});

describe('Sessions: Facebook accounts', () => {
  it.effect('binding moves the browser\'s data to the account; the first account claims unclaimed rows', () =>
    Effect.gen(function* () {
      const sessions = yield* buildSessions(null);
      const favorites = yield* FavoritesRepo;
      const hidden = yield* HiddenListingsRepo;
      const settings = yield* SettingsRepo;

      // Data from before multi-user support, and what two browsers saved before logging in.
      yield* favorites.save(UNCLAIMED_OWNER, { listing: listing('1'), note: 'old' }, 1);
      yield* settings.update(UNCLAIMED_OWNER, { checkIntervalMinutes: 15 });
      const phone = yield* sessions.create;
      const laptop = yield* sessions.create;
      yield* favorites.save(sessionOwner(phone.session.id), { listing: listing('2'), note: null }, 2);
      yield* hidden.hide(sessionOwner(laptop.session.id), { id: '3', title: 'Lamp' }, 3);

      yield* sessions.bindAccount(phone.session.id, ALICE);
      expect(yield* resolved(sessions, phone.token)).toEqual({ id: phone.session.id, unlocked: true, fbUserId: ALICE });
      expect((yield* favorites.list(accountOwner(ALICE))).map((f) => f.listing.id).sort()).toEqual(['1', '2']);
      expect((yield* settings.get(accountOwner(ALICE))).checkIntervalMinutes).toBe(15);
      expect(yield* favorites.list(sessionOwner(phone.session.id))).toEqual([]);
      expect(yield* ClientSessionsRepo.use((repo) => repo.hasUnclaimedData)).toBe(false);

      // A second account only gets its own browser's data.
      yield* sessions.bindAccount(laptop.session.id, BOB);
      expect(yield* favorites.list(accountOwner(BOB))).toEqual([]);
      expect((yield* hidden.list(accountOwner(BOB))).map((h) => h.id)).toEqual(['3']);
      expect((yield* settings.get(accountOwner(BOB))).checkIntervalMinutes).toBe(60);

      // Binding is stored, and binding again is harmless.
      yield* sessions.bindAccount(phone.session.id, ALICE);
      expect((yield* storedRows).map((row) => row.fbUserId).sort()).toEqual([ALICE, BOB].sort());
      yield* sessions.bindAccount('unknown' as never, ALICE);
    }).pipe(Effect.scoped, Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('unbinding reports how many other browsers are still bound to the account', () =>
    Effect.gen(function* () {
      const sessions = yield* buildSessions(null);
      const phone = yield* sessions.create;
      const laptop = yield* sessions.create;
      const other = yield* sessions.create;
      yield* sessions.bindAccount(phone.session.id, ALICE);
      yield* sessions.bindAccount(laptop.session.id, ALICE);
      yield* sessions.bindAccount(other.session.id, BOB);
      yield* FavoritesRepo.use((repo) => repo.save(accountOwner(ALICE), { listing: listing('1'), note: null }, 1));

      expect(yield* sessions.unbindAccount(phone.session.id)).toEqual({ userId: ALICE, remaining: 1 });
      expect((yield* resolved(sessions, phone.token))?.fbUserId).toBeNull();
      expect(yield* sessions.unbindAccount(phone.session.id)).toEqual({ userId: null, remaining: 0 });
      expect(yield* sessions.unbindAccount(laptop.session.id)).toEqual({ userId: ALICE, remaining: 0 });
      expect(yield* sessions.unbindAccount('unknown' as never)).toEqual({ userId: null, remaining: 0 });

      // The account's data stays with the account (it is back when a browser logs in again).
      expect(yield* FavoritesRepo.use((repo) => repo.list(sessionOwner(phone.session.id)))).toEqual([]);
      expect(yield* FavoritesRepo.use((repo) => repo.list(accountOwner(ALICE)))).toHaveLength(1);
      // Stored too.
      const restarted = yield* buildSessions(null);
      expect((yield* resolved(restarted, laptop.token))?.fbUserId).toBeNull();
      expect((yield* resolved(restarted, other.token))?.fbUserId).toBe(BOB);
    }).pipe(Effect.scoped, Effect.provide(RepositoriesLayerMemory)),
  );

  it.effect('browsers not seen for 30 days no longer keep the account bound for logout', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const sessions = yield* buildSessions(null);
      const phone = yield* sessions.create;
      const laptop = yield* sessions.create;
      // A private window that logged in once and was closed: never seen again.
      const privateWindow = yield* sessions.create;
      for (const issued of [phone, laptop, privateWindow]) yield* sessions.bindAccount(issued.session.id, ALICE);

      yield* TestClock.adjust(31 * DAY_MS);
      yield* sessions.resolve(phone.token);
      yield* sessions.resolve(laptop.token);
      expect(yield* sessions.unbindAccount(phone.session.id)).toEqual({ userId: ALICE, remaining: 1 });

      // The laptop was last seen exactly 30 days ago: still counts; a moment later it doesn't.
      yield* TestClock.adjust(30 * DAY_MS);
      yield* sessions.bindAccount(phone.session.id, ALICE);
      expect(yield* sessions.unbindAccount(phone.session.id)).toEqual({ userId: ALICE, remaining: 1 });
      yield* TestClock.adjust(1);
      yield* sessions.bindAccount(phone.session.id, ALICE);
      expect(yield* sessions.unbindAccount(phone.session.id)).toEqual({ userId: ALICE, remaining: 0 });

      // A stale browser that comes back is still bound (logged out of Facebook if its cookies went).
      expect(yield* resolved(sessions, privateWindow.token)).toEqual({
        id: privateWindow.session.id,
        unlocked: true,
        fbUserId: ALICE,
      });
    }).pipe(Effect.scoped, Effect.provide(RepositoriesLayerMemory)),
  );
});
