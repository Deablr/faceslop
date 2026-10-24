// Server configuration, read once through Effect Config (environment variables).
// OWNER: shared. Add new keys here (with a comment) instead of reading process.env elsewhere.
// (src/server/node-server.ts is the one exception: it runs before the runtime exists.)
import '@tanstack/react-start/server-only';
import path from 'node:path';
import { Config, Context, Effect, Layer, Option, Redacted } from 'effect';

export type ChromeChannel = 'auto' | 'chrome' | 'chromium' | 'headless-shell';

export interface AppConfigShape {
  /** PORT (default 3000). The listener itself is Nitro's; this is informational. */
  readonly port: number;
  /** HOST (default 127.0.0.1). Non-loopback requires APP_PASSWORD (or FACESLOP_DOCKER=1 without FACESLOP_PUBLIC_URL). */
  readonly host: string;
  /** FACESLOP_DATA_DIR (default ./.data): SQLite db, Facebook session cookies. Created 0700. */
  readonly dataDir: string;
  /** `<dataDir>/faceslop.db` */
  readonly databaseFile: string;
  /** `<dataDir>/fb-sessions/`: one Playwright storageState per Facebook account, `<c_user>.json` (mode 0600, dir 0700). */
  readonly sessionsDir: string;
  /** `<dataDir>/fb-session.json`: the single-user session file from before multi-user support (migrated at startup). */
  readonly legacySessionFile: string;
  /** APP_PASSWORD: password gate for the app itself (unrelated to Facebook). Entered once per browser. */
  readonly appPassword: Option.Option<Redacted.Redacted>;
  /**
   * FACESLOP_PUBLIC_URL (e.g. https://faceslop.example.com): where browsers reach faceslop when it
   * is deployed publicly (behind a reverse proxy such as Dokploy's Traefik). Its host is accepted
   * in the Host header (as well as loopback), cookies are Secure when it is https, and the server
   * refuses to start without APP_PASSWORD.
   */
  readonly publicUrl: Option.Option<URL>;
  /**
   * FACESLOP_TRUST_PROXY=1: a reverse proxy sits in front (Dokploy/Traefik). Trust its
   * X-Forwarded-For (last hop: per-address throttling) and X-Forwarded-Proto (Secure cookies, HSTS).
   */
  readonly trustProxy: boolean;
  /** FACESLOP_MAX_REMOTE_VIEWS (default 3): remote views (live Facebook pages) open at once, across all browsers. */
  readonly maxRemoteViews: number;
  /** NODE_ENV === 'production' */
  readonly isProduction: boolean;
  /**
   * FACESLOP_DOCKER=1: running in a container. Allows binding 0.0.0.0 without APP_PASSWORD (the
   * compose file must publish the port on the host's loopback only) and adds container-friendly
   * Chrome flags. The Host-header loopback check still applies.
   */
  readonly docker: boolean;
  readonly chrome: {
    /**
     * FACESLOP_CHROME_CHANNEL: 'auto' (default: installed Google Chrome, else Playwright's
     * Chromium, else chromium-headless-shell), or force one of them. Always headless.
     */
    readonly channel: ChromeChannel;
    /**
     * FACESLOP_CHROME_NO_SANDBOX: run Chrome without its sandbox. Default: on as root or in
     * Docker (FACESLOP_DOCKER=1: the default seccomp profile blocks the namespaces the sandbox
     * needs, so the container is the isolation boundary), off otherwise (sandboxed).
     */
    readonly noSandbox: boolean;
    /** FACESLOP_CHROME_ARGS: extra launch flags, space-separated. */
    readonly extraArgs: readonly string[];
  };
  /** FACESLOP_LOCATION_DOC_ID: override for Facebook's location typeahead query doc id (engine). */
  readonly locationDocId: Option.Option<string>;
  /** FACESLOP_DISABLE_CHECKER=1: don't start the background checker (tests, smoke runs). */
  readonly disableChecker: boolean;
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const load = Effect.gen(function* () {
  const port = yield* Config.Port('PORT').pipe(Config.withDefault(3000));
  const host = yield* Config.String('HOST').pipe(Config.withDefault('127.0.0.1'));
  const dataDir = path.resolve(yield* Config.String('FACESLOP_DATA_DIR').pipe(Config.withDefault('.data')));
  const appPassword = yield* Config.Redacted('APP_PASSWORD').pipe(
    Config.option,
    Config.map(Option.filter((value) => Redacted.value(value).length > 0)),
  );
  const publicUrl = yield* Config.URL('FACESLOP_PUBLIC_URL').pipe(Config.option);
  const trustProxy = yield* Config.Boolean('FACESLOP_TRUST_PROXY').pipe(Config.withDefault(false));
  const maxRemoteViews = yield* Config.Int('FACESLOP_MAX_REMOTE_VIEWS').pipe(Config.withDefault(3));
  const nodeEnv = yield* Config.String('NODE_ENV').pipe(Config.withDefault('development'));
  const docker = yield* Config.Boolean('FACESLOP_DOCKER').pipe(Config.withDefault(false));
  const channel = yield* Config.Literals(['auto', 'chrome', 'chromium', 'headless-shell'], 'FACESLOP_CHROME_CHANNEL').pipe(
    Config.withDefault('auto' as const),
  );
  const noSandbox = yield* Config.Boolean('FACESLOP_CHROME_NO_SANDBOX').pipe(Config.withDefault(isRoot || docker));
  const extraArgs = yield* Config.String('FACESLOP_CHROME_ARGS').pipe(Config.withDefault(''));
  const locationDocId = yield* Config.String('FACESLOP_LOCATION_DOC_ID').pipe(Config.option);
  const disableChecker = yield* Config.Boolean('FACESLOP_DISABLE_CHECKER').pipe(Config.withDefault(false));

  return {
    port,
    host,
    dataDir,
    databaseFile: path.join(dataDir, 'faceslop.db'),
    sessionsDir: path.join(dataDir, 'fb-sessions'),
    legacySessionFile: path.join(dataDir, 'fb-session.json'),
    appPassword,
    publicUrl,
    trustProxy,
    maxRemoteViews: Math.max(1, maxRemoteViews),
    isProduction: nodeEnv === 'production',
    docker,
    chrome: {
      channel,
      noSandbox,
      extraArgs: extraArgs.split(/\s+/).filter((arg) => arg.length > 0),
    },
    locationDocId,
    disableChecker,
  } satisfies AppConfigShape;
});

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()('faceslop/server/AppConfig') {
  static readonly layer = Layer.effect(AppConfig, load);

  /** A config for tests: everything default except what you pass. */
  static readonly layerTest = (overrides: Partial<AppConfigShape> & Pick<AppConfigShape, 'dataDir'>) =>
    Layer.succeed(AppConfig, {
      port: 3000,
      host: '127.0.0.1',
      databaseFile: path.join(overrides.dataDir, 'faceslop.db'),
      sessionsDir: path.join(overrides.dataDir, 'fb-sessions'),
      legacySessionFile: path.join(overrides.dataDir, 'fb-session.json'),
      appPassword: Option.none(),
      publicUrl: Option.none(),
      trustProxy: false,
      maxRemoteViews: 3,
      isProduction: false,
      docker: false,
      chrome: { channel: 'auto', noSandbox: false, extraArgs: [] },
      locationDocId: Option.none(),
      disableChecker: true,
      ...overrides,
    });
}
