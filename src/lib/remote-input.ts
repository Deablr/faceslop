// Pure input mapping for the remote viewer (src/components/remote-viewer): pointer positions to
// remote-viewport CSS pixels, click counting, wheel normalization, and keyboard events to
// RemoteInputEvents (protocol: src/shared/remote-view.ts). No DOM access here, so it is unit
// tested (test/ui-remote-input.test.ts).
//
// Input can carry the user's Facebook password: nothing here (or in the viewer) logs events.
import type { KeyModifiers, MouseButton, RemoteInputEvent } from '@/shared/remote-view';

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Size {
  readonly left: number;
  readonly top: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The protocol's coordinate bounds (src/shared/remote-view.ts). */
const MAX_COORDINATE = 10_000;
const MAX_WHEEL_DELTA = 10_000;
/** RemoteInputEvent text events carry at most this many characters. */
export const MAX_TEXT_CHUNK = 2000;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Where an image of `intrinsic` size is drawn inside an element of size `box` with
 * `object-fit: contain`: scaled to fit, aspect ratio preserved, centered (letterboxed).
 * Returned relative to the element's top-left corner.
 */
export function containedRect(box: Size, intrinsic: Size): Rect {
  if (box.width <= 0 || box.height <= 0 || intrinsic.width <= 0 || intrinsic.height <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const scale = Math.min(box.width / intrinsic.width, box.height / intrinsic.height);
  const width = intrinsic.width * scale;
  const height = intrinsic.height * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

/**
 * Maps a client (page) position over the rendered frame element to remote-viewport CSS pixels.
 *
 * - `element`: the frame element's bounding client rect (getBoundingClientRect()).
 * - `frame`: the frame's intrinsic size (what's drawn, letterboxed inside the element).
 * - `viewport`: the remote viewport in CSS pixels (RemoteViewState.width/height).
 *
 * Returns null over the letterbox bars (outside the picture), or when sizes are unknown. With
 * `clampToEdge` (used while a button is held) positions outside are clamped to the nearest edge
 * instead, so drags that leave the picture still end inside it.
 */
export function toRemotePoint(
  client: Point,
  element: Rect,
  frame: Size,
  viewport: Size,
  clampToEdge = false,
): Point | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const picture = containedRect(element, frame);
  if (picture.width <= 0 || picture.height <= 0) return null;
  let fx = (client.x - element.left - picture.left) / picture.width;
  let fy = (client.y - element.top - picture.top) / picture.height;
  const inside = fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1;
  if (!inside && !clampToEdge) return null;
  fx = clamp(fx, 0, 1);
  fy = clamp(fy, 0, 1);
  const maxX = Math.min(viewport.width - 1, MAX_COORDINATE);
  const maxY = Math.min(viewport.height - 1, MAX_COORDINATE);
  return {
    x: clamp(Math.round(fx * viewport.width), 0, Math.max(0, maxX)),
    y: clamp(Math.round(fy * viewport.height), 0, Math.max(0, maxY)),
  };
}

/** PointerEvent.button to the protocol's button; null for back/forward/pen-eraser buttons. */
export function mouseButtonOf(button: number): MouseButton | null {
  switch (button) {
    case 0:
      return 'left';
    case 1:
      return 'middle';
    case 2:
      return 'right';
    default:
      return null;
  }
}

export interface ClickState {
  readonly time: number;
  readonly point: Point;
  readonly button: MouseButton;
  readonly count: number;
}

/** A second press within this time and distance of the first is a double click (then triple). */
export const MULTI_CLICK_MS = 500;
export const MULTI_CLICK_DISTANCE = 6;

/** The click count for a press (1 single, 2 double, 3 triple, then cycling back to 1). */
export function nextClickState(previous: ClickState | null, time: number, point: Point, button: MouseButton): ClickState {
  const continues =
    previous !== null &&
    previous.button === button &&
    time - previous.time <= MULTI_CLICK_MS &&
    Math.hypot(point.x - previous.point.x, point.y - previous.point.y) <= MULTI_CLICK_DISTANCE &&
    previous.count < 3;
  return { time, point, button, count: continues ? previous.count + 1 : 1 };
}

/** WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages. */
export function wheelPixels(delta: number, deltaMode: number, pageHeight: number): number {
  const pixels = deltaMode === 1 ? delta * 16 : deltaMode === 2 ? delta * pageHeight : delta;
  return clamp(Math.round(pixels), -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA);
}

// ---------- keyboard ----------

export interface KeyLike {
  readonly key: string;
  readonly code: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  /** True while an IME composition is in progress (the composed text arrives on compositionend). */
  readonly isComposing: boolean;
}

export type KeyDecision =
  /** Send this event and prevent the browser's default. */
  | { readonly kind: 'send'; readonly event: RemoteInputEvent }
  /** Leave it to the browser (paste, browser shortcuts); don't send anything. */
  | { readonly kind: 'native' }
  /** Nothing to send (modifier keys, dead keys, composition in progress). */
  | { readonly kind: 'ignore' }
  /** The escape hatch: move keyboard focus out of the remote view (Shift+Escape). */
  | { readonly kind: 'release-focus' };

/** Keys sent as key presses (with modifiers). Anything else that isn't printable is ignored. */
const NAMED_KEYS = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
]);

/** Ctrl/Cmd shortcuts that belong to the user's own browser (tabs, windows, address bar, reload, paste). */
const BROWSER_SHORTCUT_KEYS = new Set(['v', 'r', 't', 'w', 'n', 'l', 'q', 'f']);

const MAX_KEY_LENGTH = 32;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** One user-perceived character (emoji and combined characters included), not a control character. */
export function isPrintable(key: string): boolean {
  if (key === '' || key === '\u007f' || key < ' ') return false;
  let count = 0;
  for (const _segment of graphemes.segment(key)) {
    count += 1;
    if (count > 1) return false;
  }
  return true;
}

export function modifiersOf(e: Pick<KeyLike, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): KeyModifiers {
  return { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey };
}

function keyPress(e: KeyLike): RemoteInputEvent {
  return {
    _tag: 'key',
    action: 'press',
    key: e.key,
    ...(e.code !== '' && e.code.length <= MAX_KEY_LENGTH ? { code: e.code } : {}),
    modifiers: modifiersOf(e),
  };
}

/**
 * What a keydown on the focused remote surface should do.
 *
 * - Printable characters without Ctrl/Cmd become text (what the user means; layout-independent).
 *   AltGr (Ctrl+Alt on Windows) and macOS Option characters are text too.
 * - Named keys (Enter, Tab, arrows, Backspace, ...) become key presses with modifiers.
 * - Ctrl/Cmd + a character becomes a key press (select all, undo, ...) except the user's own
 *   browser shortcuts and paste (the paste event sends the clipboard text instead).
 * - Shift+Escape releases keyboard focus back to faceslop.
 */
export function decideKey(e: KeyLike): KeyDecision {
  if (e.isComposing || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified') return { kind: 'ignore' };
  if (e.key === 'Escape' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) return { kind: 'release-focus' };
  const commandKey = e.ctrlKey || e.metaKey;
  const altGraph = e.ctrlKey && e.altKey && !e.metaKey;
  if (isPrintable(e.key)) {
    if (!commandKey || altGraph) return { kind: 'send', event: { _tag: 'text', text: e.key } };
    if (BROWSER_SHORTCUT_KEYS.has(e.key.toLowerCase())) return { kind: 'native' };
    return { kind: 'send', event: keyPress(e) };
  }
  if (NAMED_KEYS.has(e.key)) {
    // Ctrl/Cmd+Tab switches the user's own browser tabs.
    if (e.key === 'Tab' && commandKey) return { kind: 'native' };
    return { kind: 'send', event: keyPress(e) };
  }
  return { kind: 'ignore' };
}

/**
 * Splits text (paste, IME) into protocol-sized text events, never inside a surrogate pair.
 * Line breaks are normalized to "\n".
 */
export function textEvents(text: string, max: number = MAX_TEXT_CHUNK): RemoteInputEvent[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const events: RemoteInputEvent[] = [];
  let chunk = '';
  for (const char of normalized) {
    if (chunk.length + char.length > max) {
      events.push({ _tag: 'text', text: chunk });
      chunk = '';
    }
    chunk += char;
  }
  if (chunk !== '') events.push({ _tag: 'text', text: chunk });
  return events;
}

// ---------- sending ----------

/**
 * Adds an event to the not-yet-sent queue, merging it into the last queued event when nothing is
 * lost by doing so: consecutive moves keep only the latest position (same buttons), consecutive
 * wheel events add up, and consecutive text joins up to the protocol limit. Events are sent one at
 * a time, in order, so while a slow request is in flight the queue stays short.
 */
export function enqueueInput(queue: readonly RemoteInputEvent[], event: RemoteInputEvent): RemoteInputEvent[] {
  const last = queue.at(-1);
  const rest = queue.slice(0, -1);
  if (last === undefined) return [event];
  if (last._tag === 'mouse' && event._tag === 'mouse' && last.action === 'move' && event.action === 'move' && last.button === event.button) {
    return [...rest, event];
  }
  if (last._tag === 'wheel' && event._tag === 'wheel') {
    return [
      ...rest,
      {
        ...event,
        deltaX: clamp(last.deltaX + event.deltaX, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA),
        deltaY: clamp(last.deltaY + event.deltaY, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA),
      },
    ];
  }
  if (last._tag === 'text' && event._tag === 'text' && last.text.length + event.text.length <= MAX_TEXT_CHUNK) {
    return [...rest, { _tag: 'text', text: last.text + event.text }];
  }
  return [...queue, event];
}

/** Moves closer together than this (in screen pixels) are a tap, not a swipe. */
export const TAP_SLOP_PX = 8;

/**
 * A touch swipe scrolls the remote page: finger movement in screen pixels becomes wheel deltas in
 * remote pixels (moving the finger up scrolls down, like native touch scrolling).
 */
export function swipeToWheel(movement: Point, element: Size, frame: Size, viewport: Size): Point {
  const picture = containedRect(element, frame);
  if (picture.width <= 0 || picture.height <= 0 || viewport.width <= 0) return { x: 0, y: 0 };
  const scale = viewport.width / picture.width;
  // `+ 0` turns -0 into 0.
  const delta = (pixels: number): number => clamp(Math.round(-pixels * scale), -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA) + 0;
  return { x: delta(movement.x), y: delta(movement.y) };
}
