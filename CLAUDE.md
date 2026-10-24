# faceslop

A calm, Facebook-free front end for Facebook Marketplace, for a few people (a household) each with their own Facebook account. One TanStack Start app (React 19 SSR + server functions on Node via Nitro). On the server, a headless Chrome (Playwright) carries each account's Facebook session and reads Marketplace data from Facebook's own page payloads. Our UI shows it and never shows Facebook's feed, reels, or notifications. It runs on loopback by default, or publicly behind a reverse proxy (Dokploy/Traefik, see README). It replaced a single-user v1 (Hono + Vite SPA) that was never committed; comments saying "port of legacy/…" point at that deleted code. Don't edit `test/fixtures/` (trimmed, anonymized Facebook payloads).

## Stack

TanStack Start + Router (file routes) + Query, Effect v4 (`effect@4`), shadcn/ui on React Aria (`aria-vega`) + Tailwind v4, ESLint 10 (strict), Vitest 5, TypeScript 6.0, Node >= 22.13 (`node:sqlite`).

## Layout

- `src/shared/`: client-safe contracts. Server-only imports are not allowed here.
  - `domain.ts`: Effect Schemas plus derived types for every API type (with v1's validation rules).
  - `errors.ts`: `AppError`, `ApiErrorCode`, `appErrorOf`/`toClientError`, and the serialization adapter.
  - `remote-view.ts`: the remote view protocol (requests, input events, SSE events).
- `src/server/`: server only. Every file starts with `import '@tanstack/react-start/server-only'`, except `functions/*.ts` (client code imports them; Start's compiler turns them into RPC stubs, so the marker would break the client build) and the `node-server.ts` launcher.
  - `runtime.ts`: `AppLayer` → one `ManagedRuntime`, cached on `globalThis`, disposed on SIGINT/SIGTERM.
  - `bridge.ts`: `runEffect`, `runEffectResponse`, `validate`, `fail`. This is the only way server functions run Effects. It reads the request (cookie, addresses) BEFORE the Effect runs, provides `CurrentClient`, and sets the session cookie AFTER. Never call `getCookie`/`setCookie`/`getRequest` inside an Effect (Effect's scheduler does not reliably keep the request's AsyncLocalStorage context).
  - `config.ts`: `AppConfig` (Effect Config: PORT, HOST, FACESLOP_DATA_DIR, APP_PASSWORD, FACESLOP_PUBLIC_URL, FACESLOP_TRUST_PROXY, FACESLOP_MAX_REMOTE_VIEWS, NODE_ENV, FACESLOP_DOCKER, FACESLOP_CHROME_*).
  - `session/`: who is asking (see below). `identity.ts` (pure types and helpers), `Sessions.ts` (the service: browser sessions, the APP_PASSWORD gate, Facebook account binding), `CurrentClient.ts` (request-scoped, provided by the bridge, plus helpers for server functions).
  - Services, one directory each, each a `Context.Service` with `layer` (what the app runs) and `layerStub`: `browser/Browser.ts`, `marketplace/`, `auth/`, `messaging/`, `remote-view/` (+ `sse.ts`), `db/Database.ts` + `db/repositories/*` (local data repos keyed by `OwnerKey`, and `ClientSessionsRepo`), `checker/`, `security/` (`request-guard.ts`: the security hooks `src/start.ts` calls; `cookies.ts`: Cookie header parsing).
  - `functions/*.ts`: every `createServerFn`, grouped by feature. They are thin: they read `CurrentClient` and call services through the bridge.
  - `filters.ts`: local filtering per owner (hidden, blocked, excluded keywords).
  - `node-server.ts`: the production launcher (see Rules).
- `src/routes/`: file routes. App pages live under the pathless `_app` layout (`_app/index.tsx` home, `search`, `item.$id`, `saved`, `messages`, `selling`, `settings`, `login`); `closed.tsx` is the session-nudge exit page. `api/health.ts` and `api/remote/stream.ts` (SSE of the caller's own remote view; it re-checks the session itself) are server routes.
- `src/components/ui/`: generated shadcn components (`npx shadcn@latest add <name>`). Don't hand-edit them. Their lint exemptions are in `eslint.config.js`.
- `src/start.ts`: global middleware (request guard; the client adds `x-faceslop: 1` to every server-function call) and the AppError serialization adapter.
- `src/router.tsx`: router + QueryClient (`src/lib/query-client.ts`) + SSR query integration. `src/server.ts` is Start's server entry: it starts the runtime at boot, answers `//` paths 404 (Start would redirect them to an absolute http:// URL before any middleware), and gives responses that bypassed the guard the same security headers (`finishUnguarded`).
- `src/components/`: app components (`remote-viewer/` is the client side of the remote view); `src/hooks/`, `src/lib/` (search-param schema, formatting, query options).
- `scripts/smoke.ts`: live logged-out smoke test through the real Marketplace layer.
- `test/`: Vitest. `helpers/faceslop-http.ts` boots the real app for the `*-http.test.ts` files and gives each "browser" its own cookie jar (no Facebook traffic). `browser.test.ts` uses headless Chrome (`FACESLOP_SKIP_BROWSER_TESTS=1` to skip).

## Who is asking (multi-user)

`src/server/session/identity.ts` is the vocabulary:

- `ClientSession` `{ id, unlocked, fbUserId }`: one browser, the `faceslop_session` cookie (over HTTPS only `__Host-faceslop_session` counts, so sibling subdomains can't plant one; HttpOnly, SameSite=Lax, Secure over HTTPS, 400 days, set on creation and unlock and renewed by every POST from a known session (`CurrentClient.session`); only token hashes are stored). Created lazily on unlock or the first POST that needs one (`ensureSession`), never by GETs (they also run during SSR, too late to set a cookie). Without one, a request browses anonymously and reads empty lists.
- A Facebook login BINDS the session to the account (`FbUserId`, the `c_user` cookie). Logout unbinds this device only; the account's cookie file is deleted once no session is bound to it.
- `FbProfile` (`anonymous` | `account`): whose Facebook cookies a browser context carries. `profileOf(session)`; background work uses `profileOfOwner(owner)`.
- `OwnerKey`: who owns local data rows. `fb:<id>` for bound sessions (every device of that account shares it), `session:<id>` before login (moved to the account by `Sessions.bindAccount`), `UNCLAIMED_OWNER` (`''`) for rows from before multi-user support (claimed by the first account that logs in).
- `Sessions` (replaces v1's `AppAuth`; stored by `ClientSessionsRepo`, which replaces `AppSessionsRepo`): unlocks never expire but store an APP_PASSWORD fingerprint, so changing the password locks every browser; wrong passwords are throttled per address and globally.
- SERVICES NEVER READ `CurrentClient`. They take explicit `ClientSession` / `ClientSessionId` / `FbProfile` / `OwnerKey` / `FbUserId` arguments. Only `src/server/functions/*` and the `/api` routes read it, through `currentSession`, `currentProfile`, `currentOwner` (reads: `None` means empty), `ensureOwner` (writes, POST only), `requireAccount` (NOT_LOGGED_IN unless bound).
- Isolation lives in the services: Browser keeps a hidden context per profile (accounts from `fb-sessions/<c_user>.json`), Marketplace keys search sessions and listing caches by profile, RemoteView keeps one view per session (at most `maxRemoteViews`), Auth runs logins per session, Checker works per active owner.

## Effect conventions

Read `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/src/**` before writing Effect code. This is v4, not v3: `Context.Service`, `Effect.catch`, `Schema.TaggedError`, `Effect.fn`, `Layer.effect` (scoped), `Schema.Literals`, `Schema.optionalKey`, `.check(Schema.isPattern(...))`. When in doubt, check the `.d.ts` files.

- Services follow this pattern: `class X extends Context.Service<X, XShape>()('faceslop/server/X') { static readonly layer = Layer.effect(X, make).pipe(Layer.provide([Dep.layer])) }`. Each `layer` provides its own dependencies. Layers are memoized by reference, so Browser and the database are built once. `runtime.ts` just merges the layers and does not need edits.
- Errors are typed `AppError` in the error channel. Repository/database failures are defects (`Effect.orDie`). Fail with `return yield* new AppError({ code: 'NOT_FOUND', message: '...' })`.
- Wrap Playwright and other promises with `Effect.tryPromise({ try, catch: (cause) => new AppError(...) })`. Use resources with `Effect.acquireRelease` / `Scope`, never manual cleanup.
- Use `Effect.fn('Service.method')` for service methods. Put background loops in the layer with `Effect.forkScoped` (disposal stops them).
- Service dependencies must stay acyclic. Each `layer` statically references its dependencies' layers, so a cycle is a circular module import that crashes at load. Allowed directions: `Browser → AppConfig`; `Marketplace → Browser, AppConfig`; `RemoteView → Browser, Marketplace, AppConfig` (never Auth: check a session with `Browser.hasSession` + the `c_user` cookie from `Browser.getCookies`); `Sessions → AppConfig, ClientSessionsRepo`; `Auth → Browser, RemoteView, Marketplace, Sessions`; `Messaging → Browser, Marketplace`; repositories → `DatabaseLayer`; `Checker → repositories (incl. ClientSessionsRepo), Marketplace, AppConfig`. `CurrentClient` is not a layer: the bridge builds it per call (`makeCurrentClient`, from AppConfig + Sessions).
- Tests use `@effect/vitest` (`layer(...)`, `it.effect`; pass `excludeTestServices: true` when you need real time).

## Adding a server function

```ts
// src/server/functions/favorites.ts
export const listFavorites = createServerFn({ method: 'GET' }).handler(() =>   // GET for reads
  runEffect(Effect.flatMap(currentOwner, (owner) =>
    Option.isNone(owner) ? Effect.succeed([]) : FavoritesRepo.use((repo) => repo.list(owner.value)))));

export const addFavorite = createServerFn({ method: 'POST' })                  // POST for writes
  .validator(validate(FavoriteInput))                                           // Effect Schema; bad input -> AppError BAD_REQUEST
  .handler(({ data }) => runEffect(
    Effect.flatMap(ensureOwner, (owner) => FavoritesRepo.use((repo) => repo.save(owner, data, Date.now())))));
```

Facebook work passes `yield* currentProfile` (or the session from `requireAccount`) to the service. `validate` treats optional keys set to `undefined` as absent (TypeScript allows `{ query: undefined }` because `exactOptionalPropertyTypes` is off, and Seroval sends it). Keep all server logic inside `.handler(...)` or in server-only modules. Start strips handlers (and validators) from the client build. Don't put top-level Effect values in `functions/*.ts`. In the UI, call it through TanStack Query: `useQuery(queryOptions({ queryKey: [...], queryFn: () => getX({ data }) }))` / `useMutation({ mutationFn: ... })`. Show errors with `toClientError(error)` (`{ code, message }`).

## Error model

`AppError` (codes: BAD_REQUEST, NOT_FOUND, NOT_LOGGED_IN, FB_BLOCKED, FB_PARSE_FAILED, FB_TIMEOUT, SESSION_EXPIRED, FORBIDDEN, APP_LOCKED, INTERNAL) reaches the client unchanged, because `appErrorSerializationAdapter` is registered in `start.ts` (Start's default only keeps `message`). Any other failure or defect is logged on the server with its cause, and the client gets INTERNAL "Something went wrong on the faceslop server." Plain HTTP routes use `runEffectResponse` (JSON `ApiErrorBody` + status; it reads the given request's cookie and never sets one). Stubbed service methods are defects, so they show as INTERNAL until implemented.

## Server-only boundary

ESLint forbids `@/server/*` (except `@/server/functions/*`), `node:*`, `playwright`, `effect/sql`, and `@effect/sql-sqlite-node` in client-reachable code (routes, components, lib, shared). The exceptions are `src/routes/api/**` and `src/start.ts`, whose server parts are stripped from the client build. `server-only` markers make the production build fail if anything leaks. After builds, check with `grep -lE "playwright|node:sqlite|chromium" .output/public/assets/*.js` (it must print nothing).

## Remote view (replaces headed windows)

There are no visible browser windows: they can't work in Docker. Login and the Marketplace-only pages (inbox, selling, create, a listing) run in a headless "interactive" Chrome context (`Browser.interactiveContext(profile)`: no resource blocking, the profile's cookies loaded and, for an account, saved back when its scope closes). `RemoteView` keeps one view per browser session and streams it to that session only: CDP `Page.startScreencast` JPEG frames and state go over SSE from `GET /api/remote/stream` (events `state`, `frame`, `closed`). The UI sends input with the `remoteInput` server function (`RemoteInputEvent`: mouse/wheel/key/text/navigate, in remote-viewport CSS pixels). `openRemoteView({ target: 'login' })` goes through `Auth.openLoginView` (a cookie-less view; once Facebook lets the user in, Auth saves its cookies as the account's session and binds the browser). The protocol is in `src/shared/remote-view.ts`. Input events can contain the user's Facebook password, so never log them.

## How Facebook data is read

Marketplace pages embed their data as JSON in `<script type="application/json">` (Relay `__bbox.result.data`). Listings are objects with `marketplace_listing_title` (`__typename: "GroupCommerceProductItem"`). Search results sit under `marketplace_search.feed_units.edges[].node.listing` and item pages under `viewer.marketplace_product_details_page.target`. Pagination is the `CometMarketplaceSearchContentPaginationQuery` GraphQL request (Facebook fires it on scroll), and its body may hold several newline-separated JSON documents. Prefer walking parsed JSON for known keys over DOM scraping or hardcoded paths: Facebook's DOM and nesting change often, key names rarely. Logged-out browsing works (a login modal covers the page, but the data is there), so search/item/location code can be smoke-tested live without an account.

## Rules

- Never launch a visible (headed) browser. `Browser` is always headless and is the only place that imports `chromium` (tests may launch headless Chrome).
- Never log, persist, or return Facebook passwords, remote input events, session tokens, or cookie values. Facebook cookies live only in `.data/fb-sessions/<c_user>.json` (mode 0600, directory 0700; paths built only from FbUserIds). One account's cookies must never reach another account's file, context, or browser.
- Loopback only by default: dev binds 127.0.0.1:3000, and production `node .output/server/index.mjs` (`node-server.ts`) defaults HOST to 127.0.0.1 and refuses a non-loopback HOST without APP_PASSWORD (or FACESLOP_DOCKER=1 with the port published on the host's loopback only). FACESLOP_PUBLIC_URL always requires APP_PASSWORD (the launcher also warns without FACESLOP_TRUST_PROXY, for an http URL, and for a password under 12 characters).
- Security lives in `src/server/security/request-guard.ts`, called from `src/start.ts`: `guardRequest` (request middleware: Host, CSRF, body size, APP_PASSWORD for `/api/*` routes; return a Response for pages/routes, throw an AppError for server functions; its `secureResponse` adds the response headers) and `guardServerFn` (function middleware, which also runs for SSR loader calls: the APP_PASSWORD gate for server functions, exempting `src/server/functions/app-auth.ts` by `filename`; request middleware cannot tell which server function is called). Every server-function call carries `x-faceslop: 1`.
- Hosts: loopback, plus FACESLOP_PUBLIC_URL's host when set (even with a password); without a public URL, APP_PASSWORD lifts the rule (LAN use). Over HTTPS (`CurrentClient.secure`: an https public URL, or FACESLOP_TRUST_PROXY=1 and `X-Forwarded-Proto: https`) the cookie is Secure and responses carry HSTS. Only FACESLOP_TRUST_PROXY=1 makes forwarded headers count (client address = last `X-Forwarded-For` hop).
- Keep requests to Facebook modest: cache, de-duplicate, run background checks sequentially (one loop for every account), and don't refetch on focus or mount (see `query-client.ts`).
- Calm UX is the product: no infinite scroll (explicit "Load more"), no autoplay, no badges/notifications unless opted in, honor reduced motion. Style with theme tokens only (`bg-primary`, `text-muted-foreground`, `bg-success/10` …, defined in `src/styles.css`). Raw palette colors, arbitrary values, inline styles, and restyling components (other than layout: margins, size, placement) are lint errors.

## Lint

`eslint.config.js` is strict and every rule is an error (presets that ship warnings are promoted). The React rule sets (@eslint-react strict-type-checked, react-hooks with the compiler rules, react-you-might-not-need-an-effect strict) apply to every client-side file, `.ts` hooks included (`src/**` except `src/server/**`); jsx-a11y strict applies to `.tsx`. App code gets no exemptions; generated `src/components/ui/**` has per-file, documented ones. Don't add `eslint-disable` comments to get around a rule; fix the code (unused disables are errors too).

## Commands

- `npm run dev`: Vite dev server on http://127.0.0.1:3000 (SSR + HMR; a changed service module rebuilds the runtime and closes the old Chrome first).
- `npm run build`, then `npm start` (`node .output/server/index.mjs`, honors PORT/HOST).
- `npm run check` = `lint` (`eslint . --max-warnings 0`) + `typecheck` (`tsc --noEmit`, then the Effect language service's diagnostics in strict mode: floating Effects, missing `yield*`, layer requirement leaks, ...) + `test` (`vitest run`). All three must pass.
- `npm run smoke`: live smoke test against facebook.com (`scripts/smoke.ts`, logged-out browsing).
- Docker: `docker compose up --build -d` (loopback only); Dokploy: see README. One process per data dir (`Sessions` loads every session into memory once; SQLite and `fb-sessions/` have one writer), so deployments must stop the old container before starting the new one (Dokploy: Swarm Update/Rollback Config Order "Stop First"). A reverse proxy must keep the original `Host` and set `X-Forwarded-For`/`X-Forwarded-Proto` (nginx doesn't by default).
