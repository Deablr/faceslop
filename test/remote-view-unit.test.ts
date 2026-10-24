// The remote view's pure helpers: pointer clamping, shortcut modifiers across platforms, and the
// JPEG frame size read from a screencast frame.
import { describe, expect, it } from 'vitest';
import { clampPoint, heldModifiers, jpegSize } from '@/server/remote-view/targets';

const none = { alt: false, ctrl: false, meta: false, shift: false };

describe('clampPoint', () => {
  const viewport = { width: 1100, height: 860 };

  it('keeps points inside the viewport', () => {
    expect(clampPoint(10, 20, viewport)).toEqual({ x: 10, y: 20 });
    expect(clampPoint(-5, 900, viewport)).toEqual({ x: 0, y: 859 });
    expect(clampPoint(5000, -1, viewport)).toEqual({ x: 1099, y: 0 });
    expect(clampPoint(10, 10, { width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe('heldModifiers', () => {
  it('passes named-key modifiers through as typed', () => {
    expect(heldModifiers('Tab', { ...none, shift: true }, 'linux')).toEqual(['Shift']);
    expect(heldModifiers('ArrowLeft', { ...none, alt: true, meta: true }, 'darwin')).toEqual(['Alt', 'Meta']);
    expect(heldModifiers('Enter', none, 'linux')).toEqual([]);
  });

  it("uses the remote Chrome's command key for character shortcuts", () => {
    // A Mac viewer's Cmd+A on a Linux server, and a Windows viewer's Ctrl+A on a Mac server.
    expect(heldModifiers('a', { ...none, meta: true }, 'linux')).toEqual(['Control']);
    expect(heldModifiers('a', { ...none, ctrl: true }, 'darwin')).toEqual(['Meta']);
    expect(heldModifiers('Z', { ...none, meta: true, shift: true }, 'linux')).toEqual(['Control', 'Shift']);
    expect(heldModifiers('c', { ...none, ctrl: true }, 'win32')).toEqual(['Control']);
  });

  it('treats Ctrl+Alt (AltGr) as typing, and never holds the key itself', () => {
    expect(heldModifiers('e', { ...none, ctrl: true, alt: true }, 'linux')).toEqual(['Alt', 'Control']);
    expect(heldModifiers('Shift', { ...none, shift: true }, 'linux')).toEqual([]);
  });
});

describe('jpegSize', () => {
  /** SOI, a JFIF APP0 segment, then a baseline SOF0 frame header. */
  function jpegHeader(width: number, height: number): string {
    const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
    const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    return Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]).toString('base64');
  }

  it('reads the frame size from the SOF marker', () => {
    expect(jpegSize(jpegHeader(1100, 860))).toEqual({ width: 1100, height: 860 });
    expect(jpegSize(jpegHeader(550, 430))).toEqual({ width: 550, height: 430 });
  });

  it('returns null for anything that is not a JPEG', () => {
    expect(jpegSize('')).toBeNull();
    expect(jpegSize(Buffer.from('not a jpeg at all').toString('base64'))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).toString('base64'))).toBeNull();
  });
});
