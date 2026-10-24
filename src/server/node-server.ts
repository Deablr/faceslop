// Production launcher (`node .output/server/index.mjs`). OWNER: security/deploy builder.
//
// Nitro's stock node-server listens on every interface when HOST is unset. faceslop carries its
// users' Facebook sessions, so this launcher checks the deployment before anything listens:
// - FACESLOP_PUBLIC_URL set (a public deployment, e.g. Dokploy behind Traefik): it must be an
//   http(s) URL, and APP_PASSWORD is required, whatever HOST is, in Docker or not.
// - Otherwise it defaults to loopback and refuses a non-loopback HOST unless APP_PASSWORD is set
//   (or FACESLOP_DOCKER=1, where the container's port is expected to be published to the host's
//   loopback only).
// - Warnings (it still starts): a public URL without FACESLOP_TRUST_PROXY=1 (client addresses and
//   HTTPS come from the proxy's headers), a public URL that isn't https, and an APP_PASSWORD
//   shorter than 12 characters when faceslop is reachable beyond loopback.
// It then hands over to Nitro's own node-server runtime, unchanged.
//
// Runs before the Effect runtime exists, so it reads process.env directly; everything else reads
// configuration through `AppConfig` (src/server/config.ts). Kept free of imports other than
// Nitro's runtime, so test/docker-config.test.ts can run its checks with plain Node.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MIN_PUBLIC_PASSWORD_LENGTH = 12;
/** The truthy spellings Effect's Config.Boolean accepts (AppConfig.docker, AppConfig.trustProxy). */
const TRUTHY = new Set(['true', 'yes', 'on', '1', 'y']);

const env = process.env;
// This launcher only ever runs the production build; AppConfig.isProduction reads NODE_ENV.
env.NODE_ENV ??= 'production';
const host = (env.NITRO_HOST ?? env.HOST ?? '').trim() || '127.0.0.1';
env.NITRO_HOST = host;
// AppConfig reads HOST/PORT; keep them in step with what Nitro actually binds.
env.HOST = host;
if (env.NITRO_PORT !== undefined && env.PORT === undefined) env.PORT = env.NITRO_PORT;

const appPassword = env.APP_PASSWORD ?? '';
const hasAppPassword = appPassword !== '';
const inDocker = TRUTHY.has(env.FACESLOP_DOCKER ?? '');
const trustProxy = TRUTHY.has(env.FACESLOP_TRUST_PROXY ?? '');
const publicUrl = (env.FACESLOP_PUBLIC_URL ?? '').trim();
const loopbackBind = LOOPBACK_HOSTS.has(host);

function refuse(message: string): never {
  console.error(message);
  process.exit(1);
}

if (publicUrl !== '') {
  const parsed = URL.canParse(publicUrl) ? new URL(publicUrl) : null;
  if (parsed === null || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    refuse(`Refusing to start: FACESLOP_PUBLIC_URL must be an http(s) URL such as https://faceslop.example.com (got "${publicUrl}").`);
  }
  if (!hasAppPassword) {
    refuse(
      `Refusing to start: FACESLOP_PUBLIC_URL is set (${parsed.origin}), so faceslop is reachable from the internet, but APP_PASSWORD is not.\n` +
        'Anyone who found it could use the Facebook accounts logged in to it. Set APP_PASSWORD to a long random value\n' +
        '(for example the output of `openssl rand -base64 24`).',
    );
  }
  if (!trustProxy) {
    console.warn(
      '[faceslop] FACESLOP_PUBLIC_URL is set but FACESLOP_TRUST_PROXY is not. Behind a reverse proxy (Dokploy, Traefik, ...)\n' +
        "  set FACESLOP_TRUST_PROXY=1: without it every visitor looks like the proxy's address and they share one wrong-password limit.",
    );
  }
  if (parsed.protocol !== 'https:') {
    console.warn('[faceslop] FACESLOP_PUBLIC_URL is not https: cookies (and the app password) cross the network unencrypted.');
  }
} else if (!loopbackBind && !hasAppPassword && !inDocker) {
  refuse(
    `Refusing to listen on ${host}: anyone on your network could use your Facebook session.\n` +
      'Set APP_PASSWORD=... to require a password, or leave HOST unset to stay on 127.0.0.1.',
  );
}

if (hasAppPassword && appPassword.length < MIN_PUBLIC_PASSWORD_LENGTH && (publicUrl !== '' || !loopbackBind)) {
  console.warn(
    `[faceslop] APP_PASSWORD is shorter than ${String(MIN_PUBLIC_PASSWORD_LENGTH)} characters. faceslop is reachable beyond this machine:\n` +
      '  use a long random password (for example the output of `openssl rand -base64 24`).',
  );
}

// node:sqlite logs an ExperimentalWarning on load (Node 22); drop only that one. (No previous
// listener means warnings are off: --no-warnings or NODE_NO_WARNINGS=1.)
const previousWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  for (const listener of previousWarningListeners) listener.call(process, warning);
});

await import('#faceslop/nitro-node-server');

// Nitro loads the app bundle on the first request. Make that request now (an open route) so the
// Effect runtime starts at boot: database migrated, background checker scheduled (src/server.ts).
const port = Number.parseInt(env.NITRO_PORT ?? env.PORT ?? '', 10) || 3000;
const warmHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
setTimeout(() => {
  fetch(`http://${warmHost}:${String(port)}/api/health`).catch((error: unknown) => {
    console.warn('[faceslop] warm-up request failed:', error);
  });
}, 100);
