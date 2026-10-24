// Visible browsing time for this tab, kept in sessionStorage so it survives reloads but not a new
// tab. A tiny external store (read with useSyncExternalStore in src/hooks/use-session-nudge.ts):
// the server snapshot is always "nothing browsed yet", so SSR and hydration never show the nudge.
import { Option, Schema } from 'effect';

const STORAGE_KEY = 'faceslop.browsing';
export const SNOOZE_MS = 5 * 60_000;

export interface BrowsingState {
  /** Visible time spent in this tab, in ms. */
  readonly elapsedMs: number;
  /** "5 more minutes" moves the nudge to this elapsed time. */
  readonly snoozeUntilMs: number | null;
  readonly dismissed: boolean;
}

export const EMPTY_BROWSING: BrowsingState = { elapsedMs: 0, snoozeUntilMs: null, dismissed: false };

const listeners = new Set<() => void>();
let cached: { readonly raw: string | null; readonly state: BrowsingState } = { raw: null, state: EMPTY_BROWSING };

/** What this tab stored earlier; anything unreadable starts over at zero. */
const decodeStored = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      elapsedMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      snoozeUntilMs: Schema.NullOr(Schema.Finite),
      dismissed: Schema.Boolean,
    }),
  ),
);

function parse(raw: string | null): BrowsingState {
  return raw === null ? EMPTY_BROWSING : Option.getOrElse(decodeStored(raw), () => EMPTY_BROWSING);
}

/** The current state (same object until it changes, as useSyncExternalStore requires). */
export function readBrowsing(): BrowsingState {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (privacy mode): fall back to the in-memory copy.
    return cached.state;
  }
  if (raw !== cached.raw) cached = { raw, state: parse(raw) };
  return cached.state;
}

export function writeBrowsing(state: BrowsingState): void {
  const raw = JSON.stringify(state);
  try {
    sessionStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // Storage unavailable: the nudge just won't survive a reload.
  }
  cached = { raw, state };
  for (const listener of listeners) listener();
}

export function subscribeBrowsing(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether to show the nudge after `nudgeMinutes` (0 = off). */
export function shouldNudge(state: BrowsingState, nudgeMinutes: number): boolean {
  if (nudgeMinutes <= 0 || state.dismissed) return false;
  return state.elapsedMs >= (state.snoozeUntilMs ?? nudgeMinutes * 60_000);
}
