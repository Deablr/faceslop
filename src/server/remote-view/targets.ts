// Where each remote view target opens, and the small pure helpers the RemoteView service uses
// (input clamping, key combos, JPEG frame size). No Playwright or Effect here (unit-tested in
// test/remote-view-unit.test.ts). Port of legacy/src/server/fb/focus.ts `focusUrl`.
import '@tanstack/react-start/server-only';
import { FB_ORIGIN } from '@/server/browser/Browser';
import type { KeyModifiers, RemoteTarget } from '@/shared/remote-view';

export const MARKETPLACE_URL = `${FB_ORIGIN}/marketplace/`;
/** Facebook's login page, returning to Marketplace afterwards. */
export const LOGIN_URL = `${FB_ORIGIN}/login/?next=${encodeURIComponent(MARKETPLACE_URL)}`;

interface TargetInfo {
  readonly path: string;
  /** For "Log in to Facebook first to open <label>." */
  readonly label: string;
  /** Needs a Facebook session (the page is useless logged out). */
  readonly needsLogin: boolean;
}

export const REMOTE_TARGETS: Readonly<Record<RemoteTarget, TargetInfo>> = {
  login: { path: '/login/', label: 'the Facebook login page', needsLogin: false },
  inbox: { path: '/marketplace/inbox/', label: 'your Marketplace inbox', needsLogin: true },
  selling: { path: '/marketplace/you/selling/', label: 'your listings', needsLogin: true },
  create: { path: '/marketplace/create/item/', label: 'a new listing', needsLogin: true },
  listing: { path: '/marketplace/item/', label: 'the listing', needsLogin: false },
};

/** Marketplace ids are numeric; anything longer than 20 digits sends Facebook into a redirect loop. */
const LISTING_ID = /^\d{1,20}$/;

/** The facebook.com URL a target opens, or null when a listing target has no usable listing id. */
export function remoteTargetUrl(target: RemoteTarget, listingId?: string): string | null {
  switch (target) {
    case 'login':
      return LOGIN_URL;
    case 'listing': {
      const id = listingId?.trim() ?? '';
      return LISTING_ID.test(id) ? `${FB_ORIGIN}${REMOTE_TARGETS.listing.path}${id}/` : null;
    }
    case 'inbox':
    case 'selling':
    case 'create':
      return `${FB_ORIGIN}${REMOTE_TARGETS[target].path}`;
  }
}

// ---------- input ----------

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Keep a pointer position inside the remote viewport (CSS pixels). */
export function clampPoint(x: number, y: number, viewport: Size): { readonly x: number; readonly y: number } {
  const clamp = (value: number, size: number) => Math.min(Math.max(value, 0), Math.max(size - 1, 0));
  return { x: clamp(x, viewport.width), y: clamp(y, viewport.height) };
}

const MODIFIER_KEYS: Readonly<Record<keyof KeyModifiers, string>> = {
  alt: 'Alt',
  ctrl: 'Control',
  meta: 'Meta',
  shift: 'Shift',
};

/** One user-perceived character ("a", "A", "é", an emoji), as opposed to a named key ("Enter"). */
const isCharacter = (key: string) => /^.$/u.test(key);

/**
 * The Playwright modifier keys to hold around a key press (never the key itself).
 *
 * Shortcuts on a character (select all, copy, undo, ...) use the remote Chrome's command key:
 * the viewer may run on a Mac (Cmd) while the server's Chrome runs on Linux (Ctrl), or the
 * other way round. Named keys (arrows, Enter, Tab) keep their modifiers as typed.
 */
export function heldModifiers(key: string, modifiers: KeyModifiers, platform: string = process.platform): readonly string[] {
  const held = new Set<string>();
  const command = modifiers.ctrl || modifiers.meta;
  // Ctrl+Alt is AltGr on Windows keyboards: a character, not a shortcut.
  const altGraph = modifiers.ctrl && modifiers.alt && !modifiers.meta;
  if (isCharacter(key) && command && !altGraph) {
    held.add(platform === 'darwin' ? 'Meta' : 'Control');
    if (modifiers.alt) held.add('Alt');
    if (modifiers.shift) held.add('Shift');
  } else {
    for (const name of Object.keys(MODIFIER_KEYS) as (keyof KeyModifiers)[]) {
      if (modifiers[name]) held.add(MODIFIER_KEYS[name]);
    }
  }
  held.delete(key);
  return [...held];
}

// ---------- frames ----------

/** Base64 characters decoded to find a JPEG's size (a multiple of 4: 6 KiB of bytes). */
const JPEG_HEADER_CHARS = 8192;

/**
 * Pixel size of a base64 JPEG (from its SOF marker), or null when it can't be read. The
 * screencast's metadata only gives the viewport in CSS pixels; the image may be scaled.
 */
export function jpegSize(base64: string): Size | null {
  // The frame header sits near the start (after the JFIF and quantization-table segments);
  // decoding a prefix avoids copying a whole frame for every screencast frame.
  const bytes = Buffer.from(base64.slice(0, JPEG_HEADER_CHARS), 'base64');
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    // Fill bytes and markers without a length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}
