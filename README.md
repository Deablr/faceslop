<img src="assets/icon.svg" width="64" height="64" alt="">

# faceslop

A calm, Facebook-free front end for Facebook Marketplace.

Marketplace is useful. Facebook around it is built to keep you scrolling. faceslop runs on your own
machine (or your own server) and gives you only the useful part: search, listing details,
favorites with price-drop tracking, saved searches that quietly check for new listings, and
messaging sellers. You never see the feed, reels, stories, notifications or suggested posts.

How it works: a headless Chrome on the server (Playwright) carries each person's Facebook session
and reads Marketplace data from the JSON Facebook embeds in its own pages. faceslop's UI shows that
data. Nothing goes anywhere except your faceslop server and facebook.com.

Calm by design: an explicit "Load more" instead of infinite scroll, no autoplay, no badges or
notifications unless you turn them on, an optional "you've been browsing a while" nudge, and
reduced motion respected.

## Quick start (npm)

Needs Node.js 22.13 or newer, plus Google Chrome or Playwright's Chromium.

```sh
npm ci
npx playwright install chromium   # only if Google Chrome isn't installed
npm run dev                       # http://127.0.0.1:3000
```

For everyday use, run the production build:

```sh
npm run build
npm start                         # http://127.0.0.1:3000 (PORT=... to change it)
```

## Quick start (Docker)

```sh
docker compose up --build -d      # http://127.0.0.1:3000
FACESLOP_PORT=3300 docker compose up --build -d   # another host port
docker compose logs -f faceslop
docker compose down               # your data stays in the "faceslop-data" volume
docker compose down -v            # ...and this deletes it (Facebook sessions, favorites, everything)
```

The image is Node 22 (Debian bookworm slim) plus Playwright's Chromium and its system libraries,
`tini` as the init process, and the built server (`.output`). Nothing else from the repository
goes in: no source, no dev dependencies. It runs as the unprivileged `node` user, with
`/app/.data` on a named volume (mode 0700). Compose gives Chromium 1 GB of shared memory and
health-checks `/api/health`. `compose.yaml` publishes no port (for Dokploy); locally, `docker
compose up` also reads `compose.override.yaml`, which publishes it on the host's **loopback only**
(`127.0.0.1:...`).
`APP_PASSWORD`, `FACESLOP_PUBLIC_URL` and `FACESLOP_TRUST_PROXY` are passed through from your
shell or an `.env` file (see [Configuration](#configuration)).

## People, accounts and data

One faceslop can serve a few people (a household, roommates), each with their own Facebook
account:

- **Each browser has its own session** (a cookie). Before you log in to Facebook, faceslop shows
  Marketplace logged out, and what you save (favorites, saved searches, hidden listings, blocked
  sellers, settings) stays in that browser.
- **Logging in to Facebook connects the browser to your account.** What you saved in that browser
  moves to your account, and from then on your data follows the account: every device where you
  log in with the same Facebook account sees the same favorites and saved searches. Other people
  never see your data, your Facebook session, or your messages.
- **Logging out disconnects this device only.** Other devices logged in to the same account stay
  logged in; faceslop deletes the account's Facebook cookies once no device uses them.
- **The app password** (`APP_PASSWORD`, if set) is entered once per browser, and faceslop never
  expires it: the session cookie is renewed whenever the browser saves or changes something, so
  only a browser left unused for 400 days (the most browsers allow a cookie to last) asks again.
  Changing `APP_PASSWORD` signs every browser out of faceslop (not out of Facebook): everyone
  enters the new one, and their data and Facebook connection are still there.
- Upgrading from a single-user faceslop: the existing favorites, saved searches and settings go to
  the first Facebook account that logs in.

## Logging in to Facebook

Browsing works without logging in: Facebook shows Marketplace to logged-out visitors, using a
location guessed from the server's IP address (on a rented server, that's the data center: set a
default location in Settings). Messaging sellers, and your account's own Marketplace location,
need a login.

There are no browser windows. faceslop's Chrome is always headless, which is also what makes it work
in Docker. To log in, faceslop opens Facebook's real login page in its headless Chrome and streams it
into faceslop's own page (the remote view). You type into Facebook's own form, including any
two-factor or checkpoint steps. Once Facebook lets you in, the view closes by itself and the
session cookies are saved to `.data/fb-sessions/<your Facebook user id>.json` (mode 0600). Your
password is never logged, stored, or sent anywhere but Facebook. There is also a plain
email-and-password form: faceslop types your details into Facebook's login page and asks for a code
if Facebook wants one. The few Marketplace pages faceslop doesn't rebuild (inbox, your listings,
creating a listing) open the same way, limited to Marketplace. Each browser gets its own remote
view; at most `FACESLOP_MAX_REMOTE_VIEWS` (3) are open at once.

## Deploy on Dokploy

[Dokploy](https://dokploy.com) builds the Dockerfile from your Git repository and puts it behind
Traefik with a Let's Encrypt certificate. You need a server with Dokploy installed (Chromium wants
memory: 2 GB of RAM or more), and a domain name.

> **Facebook and data-center IP addresses.** Your Facebook login comes from the server, not from
> your phone or laptop. Facebook may find a login from a VPS or data-center IP suspicious: expect a
> security checkpoint ("Was this you?"), a request to approve the login in the Facebook app or with
> a code, and possibly a temporary restriction on the account. To keep it smooth:
>
> - Log in through the remote view (it shows Facebook's real pages, so you can finish any
>   checkpoint), and keep the Facebook app on your phone at hand to approve the login.
> - Then leave the session alone. faceslop keeps it alive; don't log out and back in repeatedly,
>   and don't log in from many devices at once just to try it.
> - If Facebook restricts the account, sort it out in the Facebook app first, then log in to
>   faceslop again once.

1. **DNS first.** Point an A record for your domain (say `faceslop.example.com`) at the server.
   Do this before adding the domain in Dokploy, or the certificate may not be issued.
2. **Create the application.** Push this repository to GitHub (or any Git host Dokploy can reach:
   GitHub through Dokploy's GitHub App, any other repository by its HTTPS URL, private ones over
   SSH with a key Dokploy generates). In Dokploy, open a project and add a service of type
   **Application**.
3. **General**: choose the provider, repository and branch. Set **Build Type** to **Dockerfile**,
   **Dockerfile Path** `Dockerfile`, **Docker Context Path** `.`, and leave **Docker Build Stage**
   empty (the last stage is the runtime image). Save.
4. **Environment**: add these and save.

   ```sh
   APP_PASSWORD=<a long random value, e.g. from: openssl rand -base64 24>
   FACESLOP_PUBLIC_URL=https://faceslop.example.com
   FACESLOP_TRUST_PROXY=1
   ```

   The image already sets `HOST`, `PORT=3000`, `FACESLOP_DOCKER` and `FACESLOP_DATA_DIR`.
   faceslop refuses to start with `FACESLOP_PUBLIC_URL` but no `APP_PASSWORD`.
5. **Advanced → Volumes** (mounts): add a **Volume Mount** with **Volume Name** `faceslop-data` and
   **Mount Path** `/app/.data`. Use a volume mount, not a bind mount: a new named volume starts
   as a copy of the image's data directory (owned by the `node` user, mode 0700), while a bind
   mount would be owned by root and faceslop couldn't write to it. Leave **Ports** empty: Traefik
   reaches the container over Dokploy's network, and a published port would skip HTTPS.
6. **Advanced → Cluster Settings → Swarm Settings**: in **Update Config**, set **Parallelism**
   `1`, **Failure Action** `rollback` and **Order** **Stop First**, then **Save Update Config**;
   in **Rollback Config**, set **Parallelism** `1` and **Order** **Stop First**, then **Save
   Rollback Config**. Dokploy's default is "start first": the new container starts while the old
   one still serves the same volume. Only one faceslop may use the data volume at a time (it keeps
   browser sessions in memory and owns the database and the Facebook cookie files), or logins,
   unlocks and logouts made during the switch get lost. With Stop First, a redeploy means a few
   seconds of downtime instead.
7. **Domains**: add a domain with **Host** `faceslop.example.com`, **Path** `/`,
   **Container Port** `3000`, **HTTPS** on and **Certificate** `letsencrypt`.
8. **Deploy** (General tab). Follow the build in **Deployments** and the server in **Logs**; the
   image's health check (`/api/health`) tells Dokploy when it's up. Then open
   `https://faceslop.example.com`, enter the app password, and log in to Facebook. Your roommate
   does the same in their own browser, with their own Facebook account.
9. **Back up the volume.** It holds everything: the database and every account's Facebook
   cookies (treat backups like passwords). Dokploy's **Volume Backups** copy a named volume to an
   S3 destination on a schedule; turn on **Turn off Container** so the database is copied while
   nothing writes to it. Restoring needs a volume that doesn't exist yet and the app stopped.

**Or as a Compose service.** Instead of steps 2 to 7: add a service of type **Compose** (Compose
Type **Docker Compose**), choose the repository and branch, and set **Compose Path**
`./compose.yaml`. Put the same three variables in **Environment** (Dokploy writes them to an `.env`
file that compose reads). In **Domains**, add the domain with **Service Name** `faceslop`,
**Container Port** `3000`, **HTTPS** on and **Certificate** `letsencrypt`: Dokploy adds the
Traefik labels and its network to the service when it deploys. `compose.yaml` publishes no port
(the loopback port in `compose.override.yaml` is for local use, and Dokploy doesn't read that
file) and declares the `faceslop-data` volume itself (Dokploy prefixes its name with the app's).
There is no Swarm setting to change: `docker compose up` stops the old container before it starts
the new one.

With the GitHub provider, Dokploy redeploys on every push to the branch. With Stop First (step
6) or Compose, redeploys keep the volume and every session, so nobody has to log in again. Unknown host
names are refused (only your domain and `localhost` are answered), every response carries HSTS,
and the session cookie is `Secure`.

## Configuration

Environment variables (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `HOST` | `127.0.0.1` | Address to listen on. Any non-loopback address needs `APP_PASSWORD` (or `FACESLOP_DOCKER=1`). |
| `APP_PASSWORD` | unset | A password for faceslop itself (not Facebook), entered once per browser. Required for LAN access and with `FACESLOP_PUBLIC_URL`; use a long random value. Changing it signs every browser out of faceslop. |
| `FACESLOP_PUBLIC_URL` | unset | The public URL when faceslop is deployed behind a reverse proxy, e.g. `https://faceslop.example.com`. Only that host name (and loopback) is answered, cookies are `Secure` and HSTS is sent when it's https, and the server refuses to start without `APP_PASSWORD`. |
| `FACESLOP_TRUST_PROXY` | unset | `1` when a reverse proxy is in front: trust its `X-Forwarded-For` (last hop: per-address password throttling) and `X-Forwarded-Proto` (HTTPS). Don't set it without a proxy: clients could fake those headers. The proxy must pass the browser's original `Host` header and set both of those headers. Traefik (Dokploy) and Caddy do by default; nginx needs `proxy_set_header Host $host;`, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` and `proxy_set_header X-Forwarded-Proto $scheme;` (with its default `Host`, every POST is refused as cross-origin). |
| `FACESLOP_MAX_REMOTE_VIEWS` | `3` | How many remote views (live Facebook pages: logins, inbox, ...) can be open at once, across all browsers. |
| `FACESLOP_DATA_DIR` | `./.data` | SQLite database and Facebook sessions (created with mode 0700). |
| `FACESLOP_DOCKER` | unset | `1` inside the container: allows binding `0.0.0.0` without `APP_PASSWORD` (the port must be published on loopback only) and adds container-friendly Chrome flags. |
| `FACESLOP_CHROME_CHANNEL` | `auto` | `auto` (Google Chrome, then Playwright's Chromium, then chromium-headless-shell), `chrome`, `chromium` or `headless-shell`. The image sets `chromium`. Always headless. |
| `FACESLOP_CHROME_NO_SANDBOX` | on as root or in Docker, else off | Run Chrome without its sandbox. In Docker the container is the isolation boundary (its default seccomp profile blocks the sandbox). Set it if Chrome can't start its sandbox on your host. |
| `FACESLOP_CHROME_ARGS` | empty | Extra Chrome flags, space-separated. |
| `FACESLOP_LOCATION_DOC_ID` | built in | Override the GraphQL document id of Facebook's location typeahead if Facebook changes it. |
| `FACESLOP_DISABLE_CHECKER` | unset | `1`: no background Facebook work (no saved-search checks, favorite refreshes or saved-search baselines). For tests and smoke runs. |
| `NODE_ENV` | `production` under `npm start` | |

Local compose (`compose.override.yaml`) also reads `FACESLOP_PORT` (the host port, default 3000).

At startup, `npm start` (and the image) refuses a public URL without a password, and warns about a
public URL without `FACESLOP_TRUST_PROXY`, a public URL that isn't https, and an app password
shorter than 12 characters on anything reachable beyond loopback.

In the app's settings (per account, or per browser before logging in): default search location
and radius, excluded keywords (listings whose titles contain them are hidden, whole words, plurals
included), how often saved searches and favorites are checked (15 minutes to 24 hours, or off),
the browsing nudge, and desktop notifications for new saved-search results (off by default).

## Security model

faceslop holds logged-in Facebook sessions, so by default it only talks to your own machine:

- **Loopback only by default.** It listens on 127.0.0.1. `npm start` refuses a non-loopback
  `HOST` unless `APP_PASSWORD` is set. In Docker the server binds 0.0.0.0 *inside* the
  container, and compose publishes it on the host's 127.0.0.1 only.
- **Public deployments.** With `FACESLOP_PUBLIC_URL`, `APP_PASSWORD` is mandatory, only that host
  and loopback are answered (whatever the password), and over HTTPS the session cookie is
  `Secure` and every response carries `Strict-Transport-Security: max-age=31536000`. With
  `FACESLOP_TRUST_PROXY=1`, the client address is the last `X-Forwarded-For` hop (the one your
  proxy added) and HTTPS comes from `X-Forwarded-Proto`.
- **DNS-rebinding defense.** Requests whose `Host` header isn't `localhost`, `127.0.0.1`, `[::1]`
  (any port) or the public URL's host are refused. Without a public URL, `APP_PASSWORD` lifts
  this rule for LAN use.
- **CSRF defense.** Every server-function call, and every request that isn't a GET, must carry the
  `x-faceslop: 1` header. A cross-site page can't add that header without a CORS preflight, and
  faceslop never answers one. An `Origin` header, when present, must match `Host`. Request bodies
  are capped at 256 KB.
- **App password.** With `APP_PASSWORD` set, every server function and `/api` route needs an
  unlocked browser session, except `/api/health` and the app-password status, unlock and lock
  calls. Pages still load, so the UI can show its password screen. faceslop never expires an
  unlock (see Sessions for the cookie's lifetime); the session remembers a
  fingerprint of the password it was unlocked with, so changing `APP_PASSWORD` locks every
  browser. After 5 wrong passwords in a minute from one address (30 from all addresses
  together), attempts are refused for the rest of that minute. Passwords are compared in
  constant time. To use faceslop on your LAN: set `APP_PASSWORD` and listen on your LAN address
  (`HOST=0.0.0.0 APP_PASSWORD=... npm start`, or change compose's published address); anywhere
  else, put HTTPS in front of it (see Dokploy above).
- **Sessions.** The `faceslop_session` cookie (over HTTPS `__Host-faceslop_session`, which other
  sites on the same domain can't set) is HttpOnly, SameSite=Lax, `Secure` over HTTPS, and lasts
  400 days (the most browsers allow), renewed on every write from that browser (any POST), so a
  browser in use never runs out. One left unused for 400 days starts over (app password, then
  Facebook login); the account's data is kept. Only SHA-256 hashes of session tokens are stored. A
  browser gets a session when it first saves something, unlocks, logs in or opens a remote view;
  reading never creates one.
- **Isolation.** Each Facebook account has its own cookie file, its own hidden Chrome context,
  search sessions and listing cache. A remote view belongs to the browser that opened it, and its
  frames stream only to that browser. Local data is filtered by owner (account, or browser before
  logging in) on every query.
- **Headers.** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
  `Referrer-Policy: no-referrer` on everything; `Cache-Control: no-store` on API responses; HSTS
  over HTTPS.
- **Facebook traffic stays modest.** Results are cached and de-duplicated. Background checks run
  one at a time for everyone, with 3–8 s pauses between requests. When Facebook pushes back, the
  checker backs off (doubling, up to 6 hours).

## Background checks

One background loop starts about a minute after boot. For each account (and each browser that
hasn't logged in yet) used in the last 30 days, it follows that owner's own check interval (every
60 minutes by default, or off): it re-runs their saved searches that have auto-check on (first
page only, as their Facebook account) and refreshes their favorites (price and status). A favorite
that disappears from Marketplace is marked sold. New saved searches record a baseline right away,
so only listings posted later count as new. "Run now" on a saved search shows everything that's
new since you last looked.

## Data

Everything lives in `FACESLOP_DATA_DIR` (`./.data`, or the `faceslop-data` volume):

- `faceslop.db` (SQLite): settings, favorites, saved searches and the listings they've seen,
  hidden listings and blocked sellers (each belonging to a Facebook account, or to a browser that
  hasn't logged in yet), and browser sessions (token hashes, and which account each is logged in
  with). A legacy v1 database is reused as is.
- `fb-sessions/<Facebook user id>.json`: each account's Facebook session cookies (mode 0600,
  directory 0700). A single-user `fb-session.json` from an older faceslop is moved here at
  startup.

Delete the directory (or the volume) to forget everything.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with SSR and HMR on http://127.0.0.1:3000. |
| `npm run build` | Production build into `.output/`. |
| `npm start` | Run the production build (`node .output/server/index.mjs`). |
| `npm run lint` | ESLint, strict, zero warnings. |
| `npm run typecheck` | `tsc` plus the Effect language service's diagnostics. |
| `npm test` | Vitest (`FACESLOP_SKIP_BROWSER_TESTS=1` skips the headless-Chrome tests). |
| `npm run check` | lint + typecheck + test. |
| `npm run smoke` | Live smoke test against facebook.com (logged-out browsing). |

Built with TanStack Start (React 19, SSR, server functions), Effect, shadcn/ui on React Aria,
Tailwind CSS and Playwright. See `CLAUDE.md` for the architecture.
