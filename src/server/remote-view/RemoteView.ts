// The remote view: a headless interactive Chrome page streamed to our UI. OWNER: auth builder.
//
// Replaces legacy's headed windows (login window + Marketplace-only "focused window",
// legacy/src/server/fb/{browser,focus,focus-guards,focus-script,auth-window}.ts). Protocol and
// schemas: src/shared/remote-view.ts.
//
// - One view PER BROWSER SESSION (ClientSessionId), each with its own Scope, screencast, input
//   lock and idle timeout. `open` creates it from Browser.interactiveContext(profile) (scoped to a
//   Scope this service owns) or navigates the session's existing one; a different profile (the
//   browser logged in or out of Facebook meanwhile) closes it and opens a new one. Open, close
//   and the rest of a session's lifecycle are serialized per session (keyed-lock.ts), so one
//   browser's slow page never holds up another's.
// - At most AppConfig.maxRemoteViews views exist at once across all sessions (each one is a live
//   Chrome context): opening one more is refused with BAD_REQUEST. A view keeps its slot until its
//   context has closed; a session replacing its own view reuses its slot.
// - The Marketplace-only guards (focus-guards.ts) are installed before the first navigation, for
//   every target; their allowlist includes Facebook's login/2FA/checkpoint pages. 'login' always
//   opens with the anonymous profile (no cookies: Auth watches it and saves the new session).
//   inbox/selling/create need an account profile with a saved session (Browser.hasSession). Do NOT
//   depend on Auth: Auth depends on RemoteView, and a layer cycle crashes at module load.
// - Frames: CDP `Page.startScreencast` (JPEG) on the page's CDPSession; every frame is acked
//   (`Page.screencastFrameAck`) as it arrives. Only the latest frame is kept: a sliding queue of
//   one between CDP and the publisher, then a sliding PubSub of one per subscriber, published at
//   most every FRAME_INTERVAL. Nothing buffers frames without bound.
// - `events(sessionId)`: that session's channel only (a pair of PubSubs, created when its first
//   subscriber arrives and dropped when its last one leaves; a view nobody watches publishes
//   nowhere). Each subscriber first gets the current "state" (and latest frame), then live
//   events; "closed" when a view closes. The stream spans views and never completes on its own.
//   State/closed go through an unbounded PubSub (rare, never dropped); frames through a sliding
//   one (slow subscribers drop frames, never state).
// - Input: page.mouse / page.keyboard (CDP Input.*) on the caller's own view, coordinates clamped
//   to the viewport, one event at a time, superseded mouse moves dropped.
// - `close` (and idle timeout, the page dying, runtime disposal) closes the view's Scope. For an
//   ACCOUNT view, Browser saves its cookies back to the account's session file and resets that
//   account's hidden context (which kills its search pages): then Marketplace.closeAllSessions +
//   clearListingCache for that profile only. Anonymous views are simply discarded.
// - Stale logins are never written back: a view remembers the login (xs token) it was opened
//   with. If it still carries that login when it closes but the account's saved session no longer
//   is that login (Facebook ended it and Auth/Messaging deleted it, or a newer login on any device
//   replaced it), its session cookies are dropped before Browser's save, so nothing is saved. A
//   login made inside the view (a new token) is saved as usual.
// - Never log input events: the user types their Facebook password through them.
import '@tanstack/react-start/server-only';
import { Clock, Context, Effect, Exit, Layer, Option, PubSub, Queue, Scope, Semaphore, Stream } from 'effect';
import type { BrowserContext, CDPSession, Dialog, Frame, Page } from 'playwright';
import { sessionTokenFromCookies } from '@/server/auth/auth-parse';
import { Browser, DEFAULT_INTERACTIVE_VIEWPORT, FB_ORIGIN, type Viewport } from '@/server/browser/Browser';
import { AppConfig } from '@/server/config';
import { Marketplace } from '@/server/marketplace/Marketplace';
import { installFocusGuards, isAllowedFocusedUrl } from '@/server/remote-view/focus-guards';
import { makeKeyedLock } from '@/server/remote-view/keyed-lock';
import { REMOTE_TARGETS, clampPoint, heldModifiers, jpegSize, remoteTargetUrl } from '@/server/remote-view/targets';
import { ANONYMOUS_PROFILE, type ClientSessionId, type FbProfile, type FbUserId, accountProfile, sameProfile } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import { AppError } from '@/shared/errors';
import {
  CLOSED_REMOTE_VIEW_STATE,
  type OpenRemoteViewRequest,
  type RemoteFrame,
  type RemoteInputEvent,
  type RemoteStreamEvent,
  type RemoteTarget,
  type RemoteViewState,
} from '@/shared/remote-view';

export interface RemoteViewShape {
  /**
   * Open (or navigate) this session's view on a target, with `profile`'s cookies (an open view with
   * a different profile is closed and reopened). NOT_LOGGED_IN for inbox/selling/create when
   * `profile` is anonymous or its account has no saved session. BAD_REQUEST when
   * AppConfig.maxRemoteViews views are already open for other sessions.
   */
  readonly open: (
    sessionId: ClientSessionId,
    profile: FbProfile,
    request: OpenRemoteViewRequest,
  ) => Effect.Effect<RemoteViewState, AppError>;
  /** Close this session's view (no-op when closed). An account view saves its cookies back (Browser.interactiveContext). */
  readonly close: (sessionId: ClientSessionId) => Effect.Effect<RemoteViewState>;
  /** Dispatch one input event to this session's page. BAD_REQUEST when it has no view open. */
  readonly input: (sessionId: ClientSessionId, event: RemoteInputEvent) => Effect.Effect<void, AppError>;
  /** This session's state (CLOSED_REMOTE_VIEW_STATE when closed). */
  readonly state: (sessionId: ClientSessionId) => Effect.Effect<RemoteViewState>;
  /**
   * Live events of THIS session's view for GET /api/remote/stream: current state first (plus the
   * latest frame), then frames/state changes, and "closed" when a view closes. Never completes on
   * its own: it spans views (open, close, open again) until the client disconnects. Never carries
   * another session's frames.
   */
  readonly events: (sessionId: ClientSessionId) => Stream.Stream<RemoteStreamEvent>;
  /** This session's open page, for Auth's login watcher (cookies, URL). None when closed. */
  readonly page: (sessionId: ClientSessionId) => Effect.Effect<Option.Option<Page>>;
}

export interface RemoteViewOptions {
  /** Close the view after this long without input (default 15 minutes). */
  readonly idleTimeoutMs?: number;
  /** How often the idle timeout is checked (default 30 seconds). */
  readonly idleCheckMs?: number;
}

const IDLE_TIMEOUT_MS = 15 * 60_000;
const IDLE_CHECK_MS = 30_000;
/** At most ~20 frames per second reach the viewer; the screencast itself may run faster. */
const FRAME_INTERVAL = '50 millis';
const JPEG_QUALITY = 70;
/** Re-read the title (and URL) this often; Facebook changes titles without navigating. */
const REFRESH_INTERVAL = '1 second';
/** No frame this long after a page load: the screencast stopped with the old document; restart it. */
const SCREENCAST_STALL_MS = 2000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const INPUT_TIMEOUT = '5 seconds';

type StateEvent = Extract<RemoteStreamEvent, { readonly _tag: 'state' | 'closed' }>;
type FrameEvent = Extract<RemoteStreamEvent, { readonly _tag: 'frame' }>;

interface ScreencastFrame {
  readonly data: string;
  readonly metadata: { readonly deviceWidth: number; readonly deviceHeight: number };
}

type PageEvent =
  | { readonly _tag: 'navigated' }
  | { readonly _tag: 'loaded' }
  | { readonly _tag: 'closed' }
  | { readonly _tag: 'popup'; readonly popup: Page };

/** One open view (one per session). Mutable fields are only touched from this service's fibers. */
interface View {
  readonly id: number;
  readonly sessionId: ClientSessionId;
  /** Whose cookies the view's context carries. */
  readonly profile: FbProfile;
  readonly scope: Scope.Closeable;
  readonly context: BrowserContext;
  /** The login (xs token) the context was opened with: the account's saved session then. Null for anonymous views. */
  readonly loadedToken: string | null;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly viewport: Viewport;
  /** Input events are dispatched one at a time, in arrival order. */
  readonly inputLock: Semaphore.Semaphore;
  /** Sequence number of the latest mouse move (older queued moves are dropped). */
  moveSeq: number;
  target: RemoteTarget;
  title: string;
  lastActivityAt: number;
  latestFrame: RemoteFrame | null;
  lastFrameAt: number;
  loadedAt: number;
  screencastRestartedAt: number;
  /** JSON of the last published state, to publish only changes. */
  publishedState: string;
}

/** A session's event channel; exists while it has subscribers. */
interface Channel {
  readonly control: PubSub.PubSub<StateEvent>;
  readonly frames: PubSub.PubSub<FrameEvent>;
  subscribers: number;
}

/** BAD_REQUEST message when AppConfig.maxRemoteViews views are already open. */
export const REMOTE_VIEWS_FULL_MESSAGE =
  'faceslop is already showing the most Facebook pages it can at once. Try again in a few minutes.';

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const attempt = <A>(what: string, run: () => Promise<A>): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AppError({ code: 'INTERNAL', message: `${what}: ${messageOf(cause)}` }),
  });

/** Best effort: Playwright calls on a page that may be closing. Never logs (input carries passwords). */
const quietly = (run: () => Promise<unknown>): Effect.Effect<void> =>
  Effect.tryPromise(run).pipe(Effect.timeoutOption(INPUT_TIMEOUT), Effect.ignore);

function stateOf(view: View): RemoteViewState {
  const url = view.page.isClosed() ? null : view.page.url();
  return {
    open: true,
    target: view.target,
    url: url === null || url === '' ? null : url,
    title: view.title,
    width: view.viewport.width,
    height: view.viewport.height,
  };
}

function frameOf(event: ScreencastFrame): RemoteFrame {
  const size = jpegSize(event.data) ?? {
    width: Math.round(event.metadata.deviceWidth),
    height: Math.round(event.metadata.deviceHeight),
  };
  return { data: event.data, width: size.width, height: size.height };
}

// ---------- input (plain Playwright; never log the event) ----------

async function pressKey(page: Page, key: string, code: string | undefined, action: 'down' | 'up' | 'press'): Promise<void> {
  const run = (name: string) =>
    action === 'down' ? page.keyboard.down(name) : action === 'up' ? page.keyboard.up(name) : page.keyboard.press(name);
  try {
    await run(key);
  } catch (error) {
    // KeyboardEvent.key values Playwright doesn't know: try the physical key instead.
    if (code === undefined || code === '') throw error;
    await run(code);
  }
}

async function dispatch(view: View, event: RemoteInputEvent): Promise<void> {
  const { page } = view;
  switch (event._tag) {
    case 'mouse': {
      const { x, y } = clampPoint(event.x, event.y, view.viewport);
      const options = { button: event.button, clickCount: Math.max(1, event.clickCount) };
      await page.mouse.move(x, y);
      if (event.action === 'down') await page.mouse.down(options);
      else if (event.action === 'up') await page.mouse.up(options);
      else if (event.action === 'click') {
        // One press with the given count (2 = the second press of a double click), not
        // Playwright's click(), which would replay every press up to clickCount.
        await page.mouse.down(options);
        await page.mouse.up(options);
      }
      return;
    }
    case 'wheel': {
      const { x, y } = clampPoint(event.x, event.y, view.viewport);
      await page.mouse.move(x, y);
      await page.mouse.wheel(event.deltaX, event.deltaY);
      return;
    }
    case 'key': {
      if (event.action !== 'press') {
        // down/up: the viewer sends modifier keys as their own events.
        await pressKey(page, event.key, event.code, event.action);
        return;
      }
      const modifiers = heldModifiers(event.key, event.modifiers);
      const pressed: string[] = [];
      try {
        for (const modifier of modifiers) {
          await page.keyboard.down(modifier);
          pressed.push(modifier);
        }
        await pressKey(page, event.key, event.code, 'press');
      } finally {
        for (const modifier of pressed.reverse()) await page.keyboard.up(modifier).catch(() => undefined);
      }
      return;
    }
    case 'text':
      await page.keyboard.insertText(event.text);
      return;
    case 'navigate': {
      const options = { waitUntil: 'commit' as const, timeout: 15_000 };
      if (event.action === 'back') {
        await page.goBack(options);
        // The first history entry is the blank page the view was created on: a dead end the
        // guards can't send back to Marketplace (no request). Step forward again.
        if (page.url() === 'about:blank') await page.goForward(options);
      } else if (event.action === 'forward') await page.goForward(options);
      else await page.reload(options);
      return;
    }
  }
}

// ---------- the service ----------

const make = Effect.fnUntraced(function* (options: RemoteViewOptions = {}) {
  const browser = yield* Browser;
  const marketplace = yield* Marketplace;
  const config = yield* AppConfig;
  const layerScope = yield* Effect.scope;
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const idleCheckMs = options.idleCheckMs ?? IDLE_CHECK_MS;

  /** The open view of each session. */
  const views = new Map<ClientSessionId, View>();
  /** Event channels of sessions someone is watching. */
  const channels = new Map<ClientSessionId, Channel>();
  /** Serializes open / close per session. */
  const locks = makeKeyedLock<ClientSessionId>();
  /** Views open or being opened, across all sessions (a closing view counts until its context is closed). */
  let slots = 0;
  let nextId = 1;

  const isCurrent = (view: View) => views.get(view.sessionId)?.id === view.id;

  const publishControl = (sessionId: ClientSessionId, event: StateEvent) =>
    Effect.suspend(() => {
      const channel = channels.get(sessionId);
      return channel ? PubSub.publish(channel.control, event).pipe(Effect.asVoid) : Effect.void;
    });

  const publishFrame = (sessionId: ClientSessionId, event: FrameEvent) =>
    Effect.suspend(() => {
      const channel = channels.get(sessionId);
      return channel ? PubSub.publish(channel.frames, event).pipe(Effect.asVoid) : Effect.void;
    });

  const publishState = (view: View) =>
    Effect.suspend(() => {
      if (!isCurrent(view)) return Effect.void;
      const state = stateOf(view);
      const json = JSON.stringify(state);
      if (json === view.publishedState) return Effect.void;
      view.publishedState = json;
      return publishControl(view.sessionId, { _tag: 'state', ...state });
    });

  const refreshTitle = (view: View) =>
    Effect.tryPromise(() => view.page.title()).pipe(
      Effect.timeoutOption('2 seconds'),
      Effect.map(Option.getOrElse(() => view.title)),
      Effect.orElseSucceed(() => view.title),
      Effect.tap((title) =>
        Effect.sync(() => {
          view.title = title;
        }),
      ),
      Effect.andThen(publishState(view)),
    );

  /**
   * (Re)start the screencast. Stopping first makes Chrome restart it for the current renderer
   * (a cross-process navigation can silently end it) and send the current picture right away.
   */
  const restartScreencast = (view: View) =>
    Effect.tryPromise(async () => {
      await view.cdp.send('Page.stopScreencast').catch(() => undefined);
      await view.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: JPEG_QUALITY,
        maxWidth: view.viewport.width,
        maxHeight: view.viewport.height,
        everyNthFrame: 1,
      });
    }).pipe(Effect.timeoutOption('5 seconds'), Effect.ignore);

  /** An account view saved new cookies for `profile`: its search sessions and cached listings are stale. */
  const accountChanged = (profile: FbProfile) =>
    Effect.andThen(marketplace.closeAllSessions(profile), marketplace.clearListingCache(profile)).pipe(
      Effect.catchCause((cause) => Effect.logWarning('[remote-view] could not reset Marketplace sessions', cause)),
    );

  const reserveSlot = Effect.suspend(() => {
    if (slots >= config.maxRemoteViews) return Effect.fail(new AppError({ code: 'BAD_REQUEST', message: REMOTE_VIEWS_FULL_MESSAGE }));
    slots++;
    return Effect.void;
  });

  const releaseSlot = Effect.sync(() => {
    slots = Math.max(0, slots - 1);
  });

  /**
   * Before an account view closes (Browser then saves it if its c_user is still the account): if it
   * still carries the login it was opened with, but the account's saved session is no longer that
   * login (deleted as dead, or replaced by a newer login, possibly from another browser), drop its
   * session cookies so that dead or older login isn't written back. Best effort: if the cookies
   * can't be read, Browser decides as before.
   */
  const dropStaleLogin = (view: View, userId: FbUserId) =>
    Effect.gen(function* () {
      const current = sessionTokenFromCookies(yield* attempt('Could not read the session', () => view.context.cookies(FB_ORIGIN)));
      // No session in the view, or a login made inside it: Browser decides.
      if (current === null || current !== view.loadedToken) return;
      const saved = (yield* browser.hasSession(userId)) ? sessionTokenFromCookies(yield* browser.getCookies(accountProfile(userId))) : null;
      if (saved === current) return;
      yield* attempt('Could not drop the old session', async () => {
        await view.context.clearCookies({ name: 'c_user' });
        await view.context.clearCookies({ name: 'xs' });
      });
    }).pipe(Effect.catch((error) => Effect.logWarning(`[remote-view] ${error.message}`)));

  /**
   * Close `view` if it is still its session's open one. Must run while holding the session's lock.
   * Uninterruptible: the closers are background fibers (idle timer, page-died handler, Auth's
   * login watcher) that runtime disposal interrupts, and a close cut short after the view left
   * `views` would leave the context open with its cookies unsaved (the disposal finalizer would
   * no longer see it). `keepSlot`: the caller reuses the slot for the session's next view.
   */
  const closeLocked = (view: View, options: { readonly resetMarketplace: boolean; readonly keepSlot?: boolean }) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (!isCurrent(view)) return;
        views.delete(view.sessionId);
        yield* Effect.tryPromise(() => view.cdp.send('Page.stopScreencast')).pipe(Effect.timeoutOption('2 seconds'), Effect.ignore);
        // An account view: Browser saves its cookies as the account's session (unless they are a
        // stale login) and resets the account's hidden context. Then Chrome's context closes.
        if (view.profile.kind === 'account') yield* dropStaleLogin(view, view.profile.userId);
        yield* Scope.close(view.scope, Exit.void);
        if (options.keepSlot !== true) yield* releaseSlot;
        yield* publishControl(view.sessionId, { _tag: 'state', ...CLOSED_REMOTE_VIEW_STATE });
        yield* publishControl(view.sessionId, { _tag: 'closed' });
        if (options.resetMarketplace && view.profile.kind === 'account') yield* accountChanged(view.profile);
      }),
    );

  const closeView = (view: View) => locks.withLock(view.sessionId, closeLocked(view, { resetMarketplace: true }));

  /** From the view's own fibers (page closed, idle): close in the service scope, not the view's. */
  const closeViewInBackground = (view: View) => Effect.forkIn(closeView(view), layerScope).pipe(Effect.asVoid);

  const navigate = (view: View, url: string) =>
    Effect.tryPromise(() => view.page.goto(url, { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS })).pipe(
      Effect.catch(() => Effect.logWarning(`[remote-view] ${new URL(url).pathname} did not start loading in time`)),
    );

  /** Popups (target=_blank links, window.open) would be invisible: open their page in the view instead. */
  const adoptPopup = (view: View, popup: Page) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => popup.waitForURL((u) => u.href !== 'about:blank', { timeout: 10_000 })).pipe(Effect.ignore);
      const url = popup.url();
      yield* Effect.promise(() => popup.close().catch(() => undefined));
      if (isCurrent(view) && isAllowedFocusedUrl(url)) yield* navigate(view, url);
    });

  const handlePageEvent = (view: View, event: PageEvent) =>
    Effect.gen(function* () {
      switch (event._tag) {
        case 'navigated':
          yield* refreshTitle(view);
          return;
        case 'loaded':
          view.loadedAt = yield* Clock.currentTimeMillis;
          yield* refreshTitle(view);
          return;
        case 'popup':
          yield* adoptPopup(view, event.popup);
          return;
        case 'closed':
          yield* closeViewInBackground(view);
          return;
      }
    });

  /** Title changes, and restarting the screencast if it stopped with a cross-document navigation. */
  const refresher = (view: View) =>
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(REFRESH_INTERVAL);
        yield* refreshTitle(view);
        const now = yield* Clock.currentTimeMillis;
        const stalled = view.lastFrameAt < view.loadedAt && now - view.loadedAt >= SCREENCAST_STALL_MS;
        if (stalled && view.screencastRestartedAt < view.loadedAt) {
          view.screencastRestartedAt = now;
          yield* restartScreencast(view);
        }
      }),
    );

  const framePump = (view: View, queue: Queue.Queue<ScreencastFrame>) =>
    Effect.forever(
      Effect.gen(function* () {
        const frame = frameOf(yield* Queue.take(queue));
        view.latestFrame = frame;
        view.lastFrameAt = yield* Clock.currentTimeMillis;
        if (isCurrent(view)) yield* publishFrame(view.sessionId, { _tag: 'frame', ...frame });
        // Frames arriving meanwhile replace each other in the sliding queue.
        yield* Effect.sleep(FRAME_INTERVAL);
      }),
    );

  const pagePump = (view: View, queue: Queue.Queue<PageEvent>) =>
    Effect.forever(Effect.flatMap(Queue.take(queue), (event) => handlePageEvent(view, event)));

  /** Build a view in `scope` (the caller closes the scope if this fails). */
  const createView = (scope: Scope.Closeable, sessionId: ClientSessionId, profile: FbProfile, target: RemoteTarget) =>
    Effect.gen(function* () {
      const context = yield* browser.interactiveContext(profile).pipe(Scope.provide(scope));
      const loadedToken =
        profile.kind === 'account' ? sessionTokenFromCookies(yield* attempt('Could not read the session', () => context.cookies(FB_ORIGIN))) : null;
      yield* attempt('Could not set up the Marketplace-only guards', () => installFocusGuards(context));
      const page = yield* attempt('Could not open the remote view', () => context.newPage());
      const cdp = yield* attempt('Could not stream the remote view', () => context.newCDPSession(page));
      const now = yield* Clock.currentTimeMillis;
      const view: View = {
        id: nextId++,
        sessionId,
        profile,
        scope,
        context,
        loadedToken,
        page,
        cdp,
        viewport: page.viewportSize() ?? DEFAULT_INTERACTIVE_VIEWPORT,
        inputLock: yield* Semaphore.make(1),
        moveSeq: 0,
        target,
        title: '',
        lastActivityAt: now,
        latestFrame: null,
        lastFrameAt: 0,
        loadedAt: now,
        screencastRestartedAt: now,
        publishedState: '',
      };

      // Callbacks only enqueue; fibers in the view's scope do the work (and stop when it closes).
      const frameQueue = yield* Queue.sliding<ScreencastFrame>(1);
      const pageQueue = yield* Queue.unbounded<PageEvent>();
      const onFrame = (event: ScreencastFrame & { readonly sessionId: number }) => {
        cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
        Queue.offerUnsafe(frameQueue, event);
      };
      const onNavigated = (frame: Frame) => {
        if (frame === page.mainFrame()) Queue.offerUnsafe(pageQueue, { _tag: 'navigated' });
      };
      const onLoaded = () => Queue.offerUnsafe(pageQueue, { _tag: 'loaded' });
      const onClosed = () => Queue.offerUnsafe(pageQueue, { _tag: 'closed' });
      const onPopup = (popup: Page) => Queue.offerUnsafe(pageQueue, { _tag: 'popup', popup });
      const onDialog = (dialog: Dialog) => {
        // Nobody can see a dialog: let pages leave ("Leave site?"), dismiss the rest.
        (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
      };
      cdp.on('Page.screencastFrame', onFrame);
      page.on('framenavigated', onNavigated);
      page.on('domcontentloaded', onLoaded);
      page.on('close', onClosed);
      page.on('crash', onClosed);
      page.on('popup', onPopup);
      page.on('dialog', onDialog);
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          cdp.off('Page.screencastFrame', onFrame);
          page.off('framenavigated', onNavigated);
          page.off('domcontentloaded', onLoaded);
          page.off('close', onClosed);
          page.off('crash', onClosed);
          page.off('popup', onPopup);
          page.off('dialog', onDialog);
        }),
      );

      yield* Effect.forkIn(framePump(view, frameQueue), scope);
      yield* Effect.forkIn(pagePump(view, pageQueue), scope);
      yield* Effect.forkIn(refresher(view), scope);
      return view;
    });

  /**
   * A new view for the session, registered as its open one. Takes a slot unless the caller already
   * holds one (`haveSlot`: the session's previous view was closed keeping it). On failure the slot
   * and the half-built view are released. Must run while holding the session's lock.
   */
  const addView = (sessionId: ClientSessionId, profile: FbProfile, target: RemoteTarget, haveSlot: boolean) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (!haveSlot) yield* reserveSlot;
        const scope = yield* Scope.make();
        const view = yield* restore(createView(scope, sessionId, profile, target)).pipe(
          Effect.onError(() => Effect.andThen(Scope.close(scope, Exit.void), releaseSlot)),
        );
        views.set(sessionId, view);
        return view;
      }),
    );

  /** True when `profile` is an account with a saved Facebook session. */
  const hasAccountSession = (profile: FbProfile) =>
    profile.kind === 'account' ? browser.hasSession(profile.userId) : Effect.succeed(false);

  const open = Effect.fn('RemoteView.open')(function* (
    sessionId: ClientSessionId,
    requestedProfile: FbProfile,
    request: OpenRemoteViewRequest,
  ) {
    const url = remoteTargetUrl(request.target, request.listingId);
    if (url === null) return yield* new AppError({ code: 'BAD_REQUEST', message: 'Facebook has no listing with that id.' });
    // The login page starts without cookies: Auth saves whichever account logs in there.
    const profile = request.target === 'login' ? ANONYMOUS_PROFILE : requestedProfile;
    const info = REMOTE_TARGETS[request.target];
    if (info.needsLogin && !(yield* hasAccountSession(profile))) {
      return yield* new AppError({ code: 'NOT_LOGGED_IN', message: `Log in to Facebook first to open ${info.label}.` });
    }

    return yield* locks.withLock(
      sessionId,
      Effect.gen(function* () {
        let view = views.get(sessionId);
        let haveSlot = false;
        if (view !== undefined && (view.page.isClosed() || !sameProfile(view.profile, profile))) {
          // Its page died (the close event hasn't been handled yet), or it carries another
          // profile's cookies (this browser logged in or out of Facebook since): start over.
          yield* closeLocked(view, { resetMarketplace: true, keepSlot: true });
          haveSlot = true;
          view = undefined;
        }
        const created = view === undefined;
        view ??= yield* addView(sessionId, profile, request.target, haveSlot);
        view.target = request.target;
        // A retargeted view says so right away; a new one once its first page has committed.
        if (!created) yield* publishState(view);
        yield* navigate(view, url);
        // Started once the first page has committed: the swap from about:blank to facebook.com's
        // renderer would end a screencast started earlier.
        if (created) yield* restartScreencast(view);
        yield* refreshTitle(view);
        view.lastActivityAt = yield* Clock.currentTimeMillis;
        return stateOf(view);
      }),
    );
  });

  const close = Effect.fn('RemoteView.close')(function* (sessionId: ClientSessionId) {
    // Under the session's lock, looked up inside it: a close that arrives while an open is still
    // starting waits for it and closes the view it created (logout must not leave one behind).
    yield* locks.withLock(
      sessionId,
      Effect.suspend(() => {
        const view = views.get(sessionId);
        return view ? closeLocked(view, { resetMarketplace: true }) : Effect.void;
      }),
    );
    return CLOSED_REMOTE_VIEW_STATE;
  });

  const input = Effect.fn('RemoteView.input')(function* (sessionId: ClientSessionId, event: RemoteInputEvent) {
    const view = views.get(sessionId);
    if (!view) return yield* new AppError({ code: 'BAD_REQUEST', message: 'The Facebook view is not open.' });
    view.lastActivityAt = yield* Clock.currentTimeMillis;
    const seq = event._tag === 'mouse' && event.action === 'move' ? ++view.moveSeq : 0;
    yield* view.inputLock.withPermits(1)(
      Effect.suspend(() => {
        // A newer move arrived while this one waited: only the latest position matters.
        if ((seq !== 0 && seq !== view.moveSeq) || !isCurrent(view)) return Effect.void;
        return quietly(() => dispatch(view, event));
      }),
    );
  });

  const state = (sessionId: ClientSessionId) =>
    Effect.sync(() => {
      const view = views.get(sessionId);
      return view ? stateOf(view) : CLOSED_REMOTE_VIEW_STATE;
    });

  const page = (sessionId: ClientSessionId) =>
    Effect.sync(() => {
      const view = views.get(sessionId);
      return view ? Option.some(view.page) : Option.none<Page>();
    });

  /** Join (or start) the session's channel. */
  const joinChannel = (sessionId: ClientSessionId) =>
    Effect.gen(function* () {
      // Made up front and thrown away if the session already has a channel: the check-and-set
      // below is synchronous, so two subscribers arriving together share one channel.
      const fresh: Channel = { control: yield* PubSub.unbounded<StateEvent>(), frames: yield* PubSub.sliding<FrameEvent>(1), subscribers: 0 };
      return yield* Effect.sync(() => {
        const channel = channels.get(sessionId) ?? fresh;
        channels.set(sessionId, channel);
        channel.subscribers++;
        return channel;
      });
    });

  const leaveChannel = (sessionId: ClientSessionId, channel: Channel) =>
    Effect.sync(() => {
      channel.subscribers--;
      if (channel.subscribers <= 0 && channels.get(sessionId) === channel) channels.delete(sessionId);
    });

  const events = (sessionId: ClientSessionId): Stream.Stream<RemoteStreamEvent> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const channel = yield* Effect.acquireRelease(joinChannel(sessionId), (joined) => leaveChannel(sessionId, joined));
        // Subscribe before reading the snapshot, so nothing published in between is missed.
        const controlEvents = yield* PubSub.subscribe(channel.control);
        const frameEvents = yield* PubSub.subscribe(channel.frames);
        const view = views.get(sessionId);
        const initial: RemoteStreamEvent[] = view
          ? [
              { _tag: 'state', ...stateOf(view) },
              ...(view.latestFrame ? [{ _tag: 'frame' as const, ...view.latestFrame }] : []),
            ]
          : [{ _tag: 'state', ...CLOSED_REMOTE_VIEW_STATE }];
        return Stream.fromIterable(initial).pipe(
          Stream.concat(Stream.merge(Stream.fromSubscription(controlEvents), Stream.fromSubscription(frameEvents))),
        );
      }),
    );

  // Auto-close views after a while without input (a forgotten view keeps a Facebook page open).
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(idleCheckMs);
        const now = yield* Clock.currentTimeMillis;
        const idle = [...views.values()].filter((view) => now - view.lastActivityAt >= idleTimeoutMs);
        for (const view of idle) {
          yield* Effect.logInfo('[remote-view] closing a Facebook view after inactivity');
          yield* closeView(view);
        }
      }),
    ),
  );

  // Runtime disposal: save the account views' cookies (Browser is finalized after this service),
  // then end every subscriber's stream.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        [...views.values()],
        (view) => locks.withLock(view.sessionId, closeLocked(view, { resetMarketplace: false })),
        { concurrency: 'unbounded', discard: true },
      );
      for (const channel of channels.values()) {
        yield* PubSub.shutdown(channel.control);
        yield* PubSub.shutdown(channel.frames);
      }
      channels.clear();
    }),
  );

  return RemoteView.of({ open, close, input, state, events, page });
});

export class RemoteView extends Context.Service<RemoteView, RemoteViewShape>()('faceslop/server/RemoteView') {
  static readonly layerStub = Layer.succeed(
    RemoteView,
    RemoteView.of({
      open: () => notImplemented('RemoteView.open'),
      close: () => notImplemented('RemoteView.close'),
      input: () => notImplemented('RemoteView.input'),
      state: () => notImplemented('RemoteView.state'),
      events: () => Stream.fromEffect(notImplemented('RemoteView.events')),
      page: () => notImplemented('RemoteView.page'),
    }),
  );

  /** Requires Browser, Marketplace and AppConfig. Options are for tests (shorter idle timeout). */
  static readonly layerNoDeps = (options?: RemoteViewOptions) => Layer.effect(RemoteView, make(options));

  /** The layer the app runs (never depends on Auth: Auth depends on this). */
  static readonly layer = Layer.effect(RemoteView, make()).pipe(
    Layer.provide([Browser.layer, Marketplace.layer, AppConfig.layer]),
  );
}
