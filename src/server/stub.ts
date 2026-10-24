// Placeholder implementation for service methods a builder hasn't written yet. The app compiles,
// boots, and serves pages; calling a stubbed method is a defect, which the server-function bridge
// logs and reports to the client as AppError INTERNAL.
import '@tanstack/react-start/server-only';
import { Effect } from 'effect';

export const notImplemented = (name: string): Effect.Effect<never> =>
  Effect.suspend(() => Effect.die(new Error(`not implemented: ${name}`)));
