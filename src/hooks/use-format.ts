// Locale- and clock-aware formatting without hydration mismatches: the server snapshot (used during
// SSR and hydration) is a fixed locale and "no clock"; right after hydration React re-renders with
// the browser's locale and the current minute.
import { useSyncExternalStore } from 'react';
import { SERVER_LOCALE, formatFor, type Format } from '@/lib/format';

function subscribeLanguage(onChange: () => void): () => void {
  window.addEventListener('languagechange', onChange);
  return () => {
    window.removeEventListener('languagechange', onChange);
  };
}

const browserLocale = (): string => navigator.language || SERVER_LOCALE;
const serverLocale = (): string => SERVER_LOCALE;

/** Formatters for the browser's locale (a fixed locale during SSR and hydration). */
export function useFormat(): Format {
  return formatFor(useSyncExternalStore(subscribeLanguage, browserLocale, serverLocale));
}

const MINUTE_MS = 60_000;

function subscribeMinute(onChange: () => void): () => void {
  const id = window.setInterval(onChange, MINUTE_MS / 2);
  return () => {
    window.clearInterval(id);
  };
}

const currentMinute = (): number => Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
const noClock = (): null => null;

/**
 * The current time, rounded to the minute and updated every minute. Null during SSR and
 * hydration: render relative times only when it isn't.
 */
export function useNow(): number | null {
  return useSyncExternalStore(subscribeMinute, currentMinute, noClock);
}
