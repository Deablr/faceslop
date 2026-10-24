// The gentle "you've been browsing a while" nudge: counts visible time in this tab (see
// src/lib/browsing-time.ts) and says when to show it.
import { useEffect, useSyncExternalStore } from 'react';
import {
  EMPTY_BROWSING,
  SNOOZE_MS,
  readBrowsing,
  shouldNudge,
  subscribeBrowsing,
  writeBrowsing,
} from '@/lib/browsing-time';

const TICK_MS = 15_000;
const serverSnapshot = () => EMPTY_BROWSING;

export interface SessionNudge {
  readonly show: boolean;
  readonly minutesBrowsed: number;
  readonly snooze: () => void;
  readonly dismiss: () => void;
  /** Start counting from zero (the user is leaving for now). */
  readonly reset: () => void;
}

/** `nudgeMinutes` of 0 turns the nudge, and the counting, off. */
export function useSessionNudge(nudgeMinutes: number): SessionNudge {
  const state = useSyncExternalStore(subscribeBrowsing, readBrowsing, serverSnapshot);

  // Count visible time only: a background tab isn't browsing.
  useEffect(() => {
    if (nudgeMinutes <= 0) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const current = readBrowsing();
      writeBrowsing({ ...current, elapsedMs: current.elapsedMs + TICK_MS });
    }, TICK_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [nudgeMinutes]);

  return {
    show: shouldNudge(state, nudgeMinutes),
    minutesBrowsed: Math.max(1, Math.round(state.elapsedMs / 60_000)),
    snooze: () => {
      const current = readBrowsing();
      writeBrowsing({ ...current, snoozeUntilMs: current.elapsedMs + SNOOZE_MS });
    },
    dismiss: () => {
      writeBrowsing({ ...readBrowsing(), dismissed: true });
    },
    reset: () => {
      writeBrowsing(EMPTY_BROWSING);
    },
  };
}
