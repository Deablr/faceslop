// The remote viewer's pure input mapping: coordinates, clicks, wheel, keyboard, text chunking.
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  MULTI_CLICK_MS,
  containedRect,
  decideKey,
  enqueueInput,
  isPrintable,
  mouseButtonOf,
  nextClickState,
  swipeToWheel,
  textEvents,
  toRemotePoint,
  wheelPixels,
  type KeyLike,
} from '@/lib/remote-input';
import { RemoteInputEvent } from '@/shared/remote-view';

const isRemoteInputEvent = Schema.is(RemoteInputEvent);

describe('containedRect (object-fit: contain)', () => {
  it('letterboxes a wide picture in a tall box', () => {
    expect(containedRect({ width: 400, height: 400 }, { width: 800, height: 400 })).toEqual({
      left: 0,
      top: 100,
      width: 400,
      height: 200,
    });
  });

  it('pillarboxes a tall picture in a wide box', () => {
    expect(containedRect({ width: 1000, height: 500 }, { width: 500, height: 500 })).toEqual({
      left: 250,
      top: 0,
      width: 500,
      height: 500,
    });
  });

  it('is empty for unknown sizes', () => {
    expect(containedRect({ width: 0, height: 100 }, { width: 10, height: 10 }).width).toBe(0);
    expect(containedRect({ width: 100, height: 100 }, { width: 0, height: 0 }).width).toBe(0);
  });
});

describe('toRemotePoint', () => {
  // A 1280x800 viewport captured at device scale 2 (2560x1600 frame), shown in a 640x500 element
  // at (100, 50): the picture is 640x400, letterboxed with 50px bars top and bottom.
  const element = { left: 100, top: 50, width: 640, height: 500 };
  const frame = { width: 2560, height: 1600 };
  const viewport = { width: 1280, height: 800 };

  it('maps to remote-viewport CSS pixels, not device pixels', () => {
    expect(toRemotePoint({ x: 100, y: 100 }, element, frame, viewport)).toEqual({ x: 0, y: 0 });
    expect(toRemotePoint({ x: 420, y: 300 }, element, frame, viewport)).toEqual({ x: 640, y: 400 });
    expect(toRemotePoint({ x: 260, y: 150 }, element, frame, viewport)).toEqual({ x: 320, y: 100 });
  });

  it('keeps the far edge inside the viewport', () => {
    expect(toRemotePoint({ x: 740, y: 500 }, element, frame, viewport)).toEqual({ x: 1279, y: 799 });
  });

  it('ignores the letterbox bars unless clamping', () => {
    expect(toRemotePoint({ x: 300, y: 60 }, element, frame, viewport)).toBeNull();
    expect(toRemotePoint({ x: 300, y: 60 }, element, frame, viewport, true)).toEqual({ x: 400, y: 0 });
    expect(toRemotePoint({ x: 2000, y: 2000 }, element, frame, viewport, true)).toEqual({ x: 1279, y: 799 });
  });

  it('returns null before the viewport size is known', () => {
    expect(toRemotePoint({ x: 300, y: 300 }, element, frame, { width: 0, height: 0 })).toBeNull();
    expect(toRemotePoint({ x: 300, y: 300 }, element, { width: 0, height: 0 }, viewport)).toBeNull();
  });
});

describe('mouse buttons and click counts', () => {
  it('maps pointer buttons', () => {
    expect(mouseButtonOf(0)).toBe('left');
    expect(mouseButtonOf(1)).toBe('middle');
    expect(mouseButtonOf(2)).toBe('right');
    expect(mouseButtonOf(3)).toBeNull();
  });

  it('counts double and triple clicks, then starts over', () => {
    const p = { x: 10, y: 10 };
    const one = nextClickState(null, 1000, p, 'left');
    const two = nextClickState(one, 1200, { x: 12, y: 11 }, 'left');
    const three = nextClickState(two, 1400, p, 'left');
    const four = nextClickState(three, 1500, p, 'left');
    expect([one.count, two.count, three.count, four.count]).toEqual([1, 2, 3, 1]);
  });

  it('starts over when too slow, too far, or another button', () => {
    const one = nextClickState(null, 0, { x: 0, y: 0 }, 'left');
    expect(nextClickState(one, MULTI_CLICK_MS + 1, { x: 0, y: 0 }, 'left').count).toBe(1);
    expect(nextClickState(one, 10, { x: 50, y: 0 }, 'left').count).toBe(1);
    expect(nextClickState(one, 10, { x: 0, y: 0 }, 'right').count).toBe(1);
  });
});

describe('wheelPixels', () => {
  it('normalizes delta modes and clamps', () => {
    expect(wheelPixels(120, 0, 800)).toBe(120);
    expect(wheelPixels(3, 1, 800)).toBe(48);
    expect(wheelPixels(-1, 2, 800)).toBe(-800);
    expect(wheelPixels(1e9, 0, 800)).toBe(10_000);
  });
});

const key = (overrides: Partial<KeyLike>): KeyLike => ({
  key: 'a',
  code: 'KeyA',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  isComposing: false,
  ...overrides,
});

describe('decideKey', () => {
  it('sends printable characters as text', () => {
    expect(decideKey(key({ key: 'a' }))).toEqual({ kind: 'send', event: { _tag: 'text', text: 'a' } });
    expect(decideKey(key({ key: 'A', shiftKey: true }))).toEqual({ kind: 'send', event: { _tag: 'text', text: 'A' } });
    expect(decideKey(key({ key: ' ', code: 'Space' }))).toEqual({ kind: 'send', event: { _tag: 'text', text: ' ' } });
    expect(decideKey(key({ key: '😀', code: '' }))).toEqual({ kind: 'send', event: { _tag: 'text', text: '😀' } });
  });

  it('treats macOS Option and Windows AltGr characters as text', () => {
    expect(decideKey(key({ key: 'å', altKey: true }))).toEqual({ kind: 'send', event: { _tag: 'text', text: 'å' } });
    expect(decideKey(key({ key: '@', code: 'KeyQ', altKey: true, ctrlKey: true }))).toEqual({
      kind: 'send',
      event: { _tag: 'text', text: '@' },
    });
  });

  it('sends named keys as presses with modifiers', () => {
    expect(decideKey(key({ key: 'Enter', code: 'Enter' }))).toEqual({
      kind: 'send',
      event: { _tag: 'key', action: 'press', key: 'Enter', code: 'Enter', modifiers: { alt: false, ctrl: false, meta: false, shift: false } },
    });
    expect(decideKey(key({ key: 'Tab', code: 'Tab', shiftKey: true }))).toMatchObject({
      kind: 'send',
      event: { _tag: 'key', key: 'Tab', modifiers: { shift: true } },
    });
    expect(decideKey(key({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }))).toMatchObject({
      event: { key: 'ArrowLeft', modifiers: { alt: true } },
    });
  });

  it('sends Ctrl/Cmd shortcuts as key presses, except the browser’s own and paste', () => {
    expect(decideKey(key({ key: 'a', metaKey: true }))).toMatchObject({
      kind: 'send',
      event: { _tag: 'key', key: 'a', modifiers: { meta: true } },
    });
    expect(decideKey(key({ key: 'z', ctrlKey: true }))).toMatchObject({ kind: 'send', event: { _tag: 'key', key: 'z' } });
    expect(decideKey(key({ key: 'v', metaKey: true }))).toEqual({ kind: 'native' });
    expect(decideKey(key({ key: 'w', ctrlKey: true }))).toEqual({ kind: 'native' });
    expect(decideKey(key({ key: 'Tab', ctrlKey: true }))).toEqual({ kind: 'native' });
  });

  it('ignores modifiers, dead keys, and IME composition', () => {
    for (const k of ['Shift', 'Control', 'Meta', 'Alt', 'CapsLock', 'Dead', 'Process', 'F5']) {
      expect(decideKey(key({ key: k, code: k }))).toEqual({ kind: 'ignore' });
    }
    expect(decideKey(key({ key: 'a', isComposing: true }))).toEqual({ kind: 'ignore' });
  });

  it('Shift+Escape releases focus; plain Escape goes to Facebook', () => {
    expect(decideKey(key({ key: 'Escape', code: 'Escape', shiftKey: true }))).toEqual({ kind: 'release-focus' });
    expect(decideKey(key({ key: 'Escape', code: 'Escape' }))).toMatchObject({ kind: 'send', event: { key: 'Escape' } });
  });

  it('only produces events the server accepts', () => {
    const samples = [
      key({ key: 'a' }),
      key({ key: 'Enter', code: 'Enter' }),
      key({ key: 'PageDown', code: 'PageDown', shiftKey: true }),
      key({ key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true }),
      key({ key: '€', code: '' }),
    ];
    for (const sample of samples) {
      const decision = decideKey(sample);
      expect(decision.kind).toBe('send');
      if (decision.kind === 'send') expect(isRemoteInputEvent(decision.event)).toBe(true);
    }
  });
});

describe('isPrintable', () => {
  it('accepts one character, rejects names and control characters', () => {
    expect(isPrintable('a')).toBe(true);
    expect(isPrintable('👍')).toBe(true);
    expect(isPrintable('Enter')).toBe(false);
    expect(isPrintable('')).toBe(false);
    expect(isPrintable('\u0007')).toBe(false);
  });
});

describe('textEvents', () => {
  it('chunks long text without splitting surrogate pairs', () => {
    const events = textEvents('ab😀cd', 3);
    expect(events).toEqual([
      { _tag: 'text', text: 'ab' },
      { _tag: 'text', text: '😀c' },
      { _tag: 'text', text: 'd' },
    ]);
  });

  it('normalizes line breaks and drops empty text', () => {
    expect(textEvents('a\r\nb\rc')).toEqual([{ _tag: 'text', text: 'a\nb\nc' }]);
    expect(textEvents('')).toEqual([]);
  });

  it('respects the protocol limit by default', () => {
    const events = textEvents('x'.repeat(4500));
    expect(events.map((e) => (e._tag === 'text' ? e.text.length : 0))).toEqual([2000, 2000, 500]);
    expect(events.every((e) => isRemoteInputEvent(e))).toBe(true);
  });
});

describe('enqueueInput', () => {
  const move = (x: number, y: number): RemoteInputEvent => ({ _tag: 'mouse', action: 'move', x, y, button: 'left', clickCount: 0 });
  const down: RemoteInputEvent = { _tag: 'mouse', action: 'down', x: 1, y: 1, button: 'left', clickCount: 1 };

  it('keeps only the latest of consecutive moves', () => {
    expect(enqueueInput(enqueueInput([], move(1, 1)), move(2, 2))).toEqual([move(2, 2)]);
  });

  it('never merges across presses, so clicks and drags keep their order', () => {
    const queue = [move(1, 1), down].reduce<RemoteInputEvent[]>(enqueueInput, []);
    expect(enqueueInput(queue, move(3, 3))).toEqual([move(1, 1), down, move(3, 3)]);
  });

  it('adds up wheel deltas at the latest position, within the protocol bounds', () => {
    const a: RemoteInputEvent = { _tag: 'wheel', x: 10, y: 10, deltaX: 0, deltaY: 120 };
    const b: RemoteInputEvent = { _tag: 'wheel', x: 20, y: 30, deltaX: 5, deltaY: 9_990 };
    expect(enqueueInput([a], b)).toEqual([{ _tag: 'wheel', x: 20, y: 30, deltaX: 5, deltaY: 10_000 }]);
  });

  it('joins typed text up to the protocol limit', () => {
    expect(enqueueInput([{ _tag: 'text', text: 'he' }], { _tag: 'text', text: 'llo' })).toEqual([{ _tag: 'text', text: 'hello' }]);
    const long: RemoteInputEvent = { _tag: 'text', text: 'x'.repeat(1999) };
    expect(enqueueInput([long], { _tag: 'text', text: 'yz' })).toHaveLength(2);
  });

  it('keeps key presses separate', () => {
    const enter = decideKey(key({ key: 'Enter', code: 'Enter' }));
    if (enter.kind !== 'send') throw new Error('expected a key press');
    const queue = enqueueInput([{ _tag: 'text', text: 'a' }], enter.event);
    expect(enqueueInput(queue, { _tag: 'text', text: 'b' })).toHaveLength(3);
  });
});

describe('swipeToWheel', () => {
  it('turns finger movement into remote scroll deltas in the opposite direction', () => {
    // A 1280x800 viewport shown 320px wide: one screen pixel is four remote pixels.
    const element = { width: 320, height: 200 };
    expect(swipeToWheel({ x: 0, y: -50 }, element, { width: 2560, height: 1600 }, { width: 1280, height: 800 })).toEqual({ x: 0, y: 200 });
    expect(swipeToWheel({ x: 10, y: 0 }, element, { width: 2560, height: 1600 }, { width: 1280, height: 800 })).toEqual({ x: -40, y: 0 });
  });

  it('is zero before sizes are known', () => {
    expect(swipeToWheel({ x: 5, y: 5 }, { width: 0, height: 0 }, { width: 10, height: 10 }, { width: 10, height: 10 })).toEqual({ x: 0, y: 0 });
  });
});
