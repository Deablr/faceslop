// Remote view protocol: the only way the user sees real facebook.com pages (login, Marketplace
// inbox, selling, create listing, a listing). A headless "interactive" Chrome page on the server is
// streamed to our UI as JPEG frames (CDP Page.startScreencast) over Server-Sent Events, and the UI
// sends mouse/keyboard/wheel/text input back through the `remoteInput` server function.
//
//   UI (viewer)                                   server (RemoteView service)
//   openRemoteView(OpenRemoteViewRequest) ──────► opens/navigates the interactive page
//   GET /api/remote/stream  (EventSource) ◄────── "state" RemoteViewState, "frame" RemoteFrame, "closed" {}
//   remoteInput(RemoteInputEvent) ───────────────► dispatched to the page (CDP Input.*)
//   closeRemoteView() ───────────────────────────► saves session cookies, closes the page
//
// Coordinates are CSS pixels of the remote viewport (RemoteViewState.width/height); the viewer
// scales pointer positions from its rendered <img>/<canvas> size to these.
//
// Input events can carry passwords (the user types into Facebook's login form): never log them.
import { Schema } from 'effect';
import { ListingId } from './domain';

/** Places the focused (Marketplace-only) view can open to (legacy FocusTarget). */
export const FocusTarget = Schema.Literals(['inbox', 'selling', 'create', 'listing']);
export type FocusTarget = typeof FocusTarget.Type;

/** Everything the remote view can show: Facebook login, or a Marketplace-only page. */
export const RemoteTarget = Schema.Literals(['login', 'inbox', 'selling', 'create', 'listing']);
export type RemoteTarget = typeof RemoteTarget.Type;

export const OpenRemoteViewRequest = Schema.Struct({
  target: RemoteTarget,
  /** Required when target is 'listing'. */
  listingId: Schema.optionalKey(ListingId),
}).check(
  Schema.makeFilter((r) =>
    r.target === 'listing' && r.listingId === undefined
      ? { path: ['listingId'], issue: 'is required when target is "listing"' }
      : undefined,
  ),
);
export type OpenRemoteViewRequest = typeof OpenRemoteViewRequest.Type;

export const RemoteViewState = Schema.Struct({
  open: Schema.Boolean,
  target: Schema.NullOr(RemoteTarget),
  /** Current page URL (facebook.com), null when closed. */
  url: Schema.NullOr(Schema.String),
  /** Current page title, null when closed. */
  title: Schema.NullOr(Schema.String),
  /** Remote viewport size in CSS pixels; input coordinates use this space. */
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type RemoteViewState = typeof RemoteViewState.Type;

export const CLOSED_REMOTE_VIEW_STATE: RemoteViewState = {
  open: false,
  target: null,
  url: null,
  title: null,
  width: 0,
  height: 0,
};

// ---------- input (client -> server) ----------

/** A coordinate in remote-viewport CSS pixels. */
const Coordinate = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }));
/** Wheel deltas in CSS pixels. */
const WheelDelta = Schema.Finite.check(Schema.isBetween({ minimum: -10_000, maximum: 10_000 }));

export const MouseButton = Schema.Literals(['left', 'middle', 'right']);
export type MouseButton = typeof MouseButton.Type;

export const KeyModifiers = Schema.Struct({
  alt: Schema.Boolean,
  ctrl: Schema.Boolean,
  meta: Schema.Boolean,
  shift: Schema.Boolean,
});
export type KeyModifiers = typeof KeyModifiers.Type;

export const RemoteInputEvent = Schema.TaggedUnion({
  mouse: {
    action: Schema.Literals(['move', 'down', 'up', 'click']),
    x: Coordinate,
    y: Coordinate,
    button: MouseButton,
    /** 1 for single click, 2 for double click, ... (0 for plain moves). */
    clickCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  },
  wheel: {
    x: Coordinate,
    y: Coordinate,
    deltaX: WheelDelta,
    deltaY: WheelDelta,
  },
  key: {
    action: Schema.Literals(['down', 'up', 'press']),
    /** KeyboardEvent.key, e.g. "Enter", "a", "ArrowLeft". */
    key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
    /** KeyboardEvent.code, e.g. "KeyA". */
    code: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
    modifiers: KeyModifiers,
  },
  /** Committed text (typing, paste, IME). */
  text: {
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  },
  navigate: {
    action: Schema.Literals(['back', 'forward', 'reload']),
  },
});
export type RemoteInputEvent = typeof RemoteInputEvent.Type;

// ---------- stream (server -> client, SSE) ----------

export const REMOTE_STREAM_PATH = '/api/remote/stream';

/** One screencast frame. */
export const RemoteFrame = Schema.Struct({
  /** Base64-encoded JPEG (no data: prefix). */
  data: Schema.String,
  /** Frame size in device pixels as captured. */
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type RemoteFrame = typeof RemoteFrame.Type;

/**
 * What RemoteView's event stream emits. On the wire each event is one SSE message whose `event:`
 * is the tag ("frame" | "state" | "closed") and whose `data:` is the JSON of the other fields.
 * A new subscriber first receives the current "state" (and the latest frame, if any).
 */
export const RemoteStreamEvent = Schema.TaggedUnion({
  frame: RemoteFrame.fields,
  state: RemoteViewState.fields,
  closed: {},
});
export type RemoteStreamEvent = typeof RemoteStreamEvent.Type;
export type RemoteStreamEventName = RemoteStreamEvent['_tag'];

export const REMOTE_STREAM_EVENT_NAMES: readonly RemoteStreamEventName[] = ['frame', 'state', 'closed'];

/** Server: one SSE message for an event. */
export function encodeRemoteSseMessage(event: RemoteStreamEvent): string {
  const { _tag, ...payload } = event;
  return `event: ${_tag}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const decodeStreamEvent = Schema.decodeUnknownOption(RemoteStreamEvent);

/**
 * Client: decode one SSE message (EventSource `event.type` + `event.data`). Returns null for
 * anything malformed.
 */
export function decodeRemoteSseMessage(name: string, data: string): RemoteStreamEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const decoded = decodeStreamEvent({ ...payload, _tag: name });
  return decoded._tag === 'Some' ? decoded.value : null;
}
