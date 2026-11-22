// One permit for ALL background Facebook work (the Checker's saved searches and favorites, the
// GroupWatcher's group checks, and their seeds), so the server never runs two background Facebook
// requests at once, however many loops there are. Built once (layers are memoized by reference).
// Work a person is waiting for ("run now", "check now") doesn't take it.
import '@tanstack/react-start/server-only';
import { Context, Effect, Layer, Semaphore } from 'effect';

export interface BackgroundLaneShape {
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export class BackgroundLane extends Context.Service<BackgroundLane, BackgroundLaneShape>()('faceslop/server/BackgroundLane') {
  static readonly layer = Layer.effect(
    BackgroundLane,
    Effect.map(Semaphore.make(1), (lane) => BackgroundLane.of({ withPermit: (effect) => lane.withPermits(1)(effect) })),
  );
}
