// The app's single Effect runtime. OWNER: foundation (builders don't need to edit this file:
// each service's own `static layer` provides its dependencies, and layers are memoized by
// reference, so shared ones such as Browser and the database are built once).
//
// - Built lazily on first use (or eagerly by src/server.ts), from AppLayer.
// - Cached on globalThis: Vite dev/HMR re-evaluates modules, and two runtimes would mean two
//   Chromes and two database connections. When a service module changes in dev, AppLayer is a new
//   object, so the old runtime is disposed first and a new one is built after it has closed.
// - Disposed on SIGINT/SIGTERM/SIGHUP (closes Chrome, saves the remote view's cookies, stops the checker,
//   closes SQLite).
import '@tanstack/react-start/server-only';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { Auth } from '@/server/auth/Auth';
import { Browser } from '@/server/browser/Browser';
import { Checker } from '@/server/checker/Checker';
import { AppConfig } from '@/server/config';
import { DatabaseLayer } from '@/server/db/Database';
import { ClientSessionsRepo } from '@/server/db/repositories/ClientSessionsRepo';
import { BlockedSellersRepo } from '@/server/db/repositories/BlockedSellersRepo';
import { FavoritesRepo } from '@/server/db/repositories/FavoritesRepo';
import { HiddenListingsRepo } from '@/server/db/repositories/HiddenListingsRepo';
import { SavedSearchesRepo } from '@/server/db/repositories/SavedSearchesRepo';
import { SettingsRepo } from '@/server/db/repositories/SettingsRepo';
import { Marketplace } from '@/server/marketplace/Marketplace';
import { Messaging } from '@/server/messaging/Messaging';
import { RemoteView } from '@/server/remote-view/RemoteView';
import { Sessions } from '@/server/session/Sessions';

/** Every service a server function can use. */
export const AppLayer = Layer.mergeAll(
  AppConfig.layer,
  Browser.layer,
  DatabaseLayer,
  SettingsRepo.layer,
  FavoritesRepo.layer,
  SavedSearchesRepo.layer,
  HiddenListingsRepo.layer,
  BlockedSellersRepo.layer,
  ClientSessionsRepo.layer,
  Marketplace.layer,
  Auth.layer,
  Messaging.layer,
  RemoteView.layer,
  Sessions.layer,
  Checker.layer,
);

/** The services available to effects run through the bridge (src/server/bridge.ts). */
export type AppServices = Layer.Success<typeof AppLayer>;
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, Layer.Error<typeof AppLayer>>;

interface RuntimeHolder {
  readonly layer: unknown;
  readonly runtime: AppRuntime;
}

const RUNTIME_KEY = Symbol.for('faceslop/server/runtime');
const SIGNALS_KEY = Symbol.for('faceslop/server/runtime-signals');
const SHUTDOWN_TIMEOUT_MS = 5000;

const globals = globalThis as typeof globalThis & {
  [RUNTIME_KEY]?: RuntimeHolder;
  [SIGNALS_KEY]?: true;
};

/** The current runtime, creating it on first use (and replacing a stale one after HMR). */
export function getRuntime(): AppRuntime {
  const held = globals[RUNTIME_KEY];
  if (held?.layer === AppLayer) return held.runtime;

  // A previous module instance built a runtime from an older AppLayer: close it before the new
  // one starts building, so Chrome/SQLite never run twice.
  const previousClosed = held ? held.runtime.dispose() : Promise.resolve();
  const layer = Layer.unwrap(Effect.promise(() => previousClosed).pipe(Effect.as(AppLayer)));
  const runtime: AppRuntime = ManagedRuntime.make(layer);
  globals[RUNTIME_KEY] = { layer: AppLayer, runtime };
  installSignalHandlers();
  return runtime;
}

/** Build every layer now (database migrations, background checker) instead of on the first request. */
export function startRuntime(): void {
  getRuntime()
    .runPromise(Effect.void)
    .catch((error: unknown) => {
      console.error('[runtime] failed to start:', error);
    });
}

/** Dispose the current runtime (no-op when none was built). */
export async function disposeRuntime(): Promise<void> {
  const held = globals[RUNTIME_KEY];
  if (!held) return;
  globals[RUNTIME_KEY] = undefined;
  await held.runtime.dispose();
}

function installSignalHandlers(): void {
  if (globals[SIGNALS_KEY]) return;
  globals[SIGNALS_KEY] = true;
  const shutdown = (signal: NodeJS.Signals) => {
    console.log(`[runtime] ${signal}: closing Chrome and the database`);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref());
    void Promise.race([disposeRuntime(), timeout])
      .catch((error: unknown) => {
        console.error('[runtime] shutdown failed:', error);
      })
      .finally(() => {
        // Nitro closes the HTTP server on the same signal; exit once that settles, even if a
        // connection (e.g. an SSE stream) would keep the event loop alive.
        setTimeout(() => process.exit(0), 1000).unref();
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGHUP', shutdown);
}
