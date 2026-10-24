// Per-key mutual exclusion: one lock per browser session (RemoteView's open/close, Auth's login
// steps), so one browser's slow Facebook page never makes another browser wait. A key's lock
// exists only while someone holds or waits for it (nothing piles up for sessions seen once).
import '@tanstack/react-start/server-only';
import { Effect, Semaphore } from 'effect';

export interface KeyedLock<K> {
  /** Run `effect` while holding `key`'s lock. Callers with other keys don't wait. */
  readonly withLock: <A, E, R>(key: K, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** True while someone holds or waits for `key`'s lock. */
  readonly isBusy: (key: K) => boolean;
}

interface Entry {
  readonly lock: Semaphore.Semaphore;
  users: number;
}

export function makeKeyedLock<K>(): KeyedLock<K> {
  const entries = new Map<K, Entry>();

  const withLock = <A, E, R>(key: K, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    // Uninterruptible between counting the user in and installing the release, so the count
    // can't leak (a leaked count would report the key busy forever).
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        let entry = entries.get(key);
        if (entry === undefined) {
          entry = { lock: Semaphore.makeUnsafe(1), users: 0 };
          entries.set(key, entry);
        }
        const held = entry;
        held.users++;
        return restore(held.lock.withPermits(1)(effect)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              held.users--;
              if (held.users === 0 && entries.get(key) === held) entries.delete(key);
            }),
          ),
        );
      }),
    );

  return { withLock, isBusy: (key) => (entries.get(key)?.users ?? 0) > 0 };
}
