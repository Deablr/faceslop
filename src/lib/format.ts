// Display formatting via Intl. Pure and locale-parameterized: the server renders with a fixed
// locale and the client re-renders with the browser's after hydration (see src/hooks/use-format.ts),
// so SSR output never mismatches the first client render.
import type { Price } from '@/shared/domain';

const KM_PER_MILE = 1.609344;
/** Regions where Marketplace (and people) measure distance in miles. */
const MILE_REGIONS = new Set(['US', 'GB', 'LR', 'MM']);
const RADIUS_STEPS = [1, 2, 5, 10, 20, 40, 60, 80, 100, 250, 500];
const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

export interface RadiusOption {
  readonly value: number;
  readonly label: string;
}

export interface Format {
  readonly locale: string;
  /** Distances in miles where people expect them (Marketplace does the same). */
  readonly usesMiles: boolean;
  readonly distanceKm: (km: number) => string;
  /** Radius choices in km (labelled in the user's unit), including `current` if it's off the usual steps. */
  readonly radiusOptions: (current?: number | null) => readonly RadiusOption[];
  /** Whole-dollar amounts for filters and summaries (USD unless a currency is given, like Facebook's filters). */
  readonly money: (amount: number, currency?: string) => string;
  readonly price: (price: Price) => string;
  /** "3 hours ago", "yesterday", "just now". */
  readonly relativeTime: (ms: number, now: number) => string;
  readonly dateTime: (ms: number) => string;
  readonly count: (n: number) => string;
  /** "1 listing", "12 listings". */
  readonly plural: (n: number, one: string, many: string) => string;
}

function regionOf(locale: string): string | undefined {
  try {
    return new Intl.Locale(locale).maximize().region;
  } catch {
    return undefined;
  }
}

/** Build the formatters for one locale. Cheap to call, but prefer `formatFor` (memoized). */
export function makeFormat(locale: string): Format {
  const region = regionOf(locale);
  const usesMiles = region !== undefined && MILE_REGIONS.has(region);
  const unitFormat = (unit: 'mile' | 'kilometer') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 0 });
  const milesFormat = unitFormat('mile');
  const kmFormat = unitFormat('kilometer');
  const relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const dateTimeFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const countFormat = new Intl.NumberFormat(locale);
  const moneyFormats = new Map<string, Intl.NumberFormat>();

  const distanceKm = (km: number): string =>
    usesMiles ? milesFormat.format(Math.max(1, Math.round(km / KM_PER_MILE))) : kmFormat.format(km);

  const money = (amount: number, currency = 'USD'): string => {
    const fractionDigits = Number.isInteger(amount) ? 0 : 2;
    const key = `${currency}:${String(fractionDigits)}`;
    let format = moneyFormats.get(key);
    if (format === undefined) {
      try {
        format = new Intl.NumberFormat(locale, {
          style: 'currency',
          currency,
          minimumFractionDigits: fractionDigits,
          maximumFractionDigits: fractionDigits,
        });
      } catch {
        return `${currency} ${String(amount)}`;
      }
      moneyFormats.set(key, format);
    }
    return format.format(amount);
  };

  const count = (n: number): string => countFormat.format(n);

  return {
    locale,
    usesMiles,
    distanceKm,
    radiusOptions: (current) => {
      const values = RADIUS_STEPS.map((step) => (usesMiles ? Math.round(step * KM_PER_MILE) : step));
      if (current !== undefined && current !== null && current > 0 && !values.includes(current)) values.push(current);
      return values.sort((a, b) => a - b).map((value) => ({ value, label: distanceKm(value) }));
    },
    money,
    price: (price) => {
      if (price.amount === 0) return 'Free';
      if (price.amount !== null && price.currency !== null && price.currency !== '') return money(price.amount, price.currency);
      return price.formatted === '' ? 'No price' : price.formatted;
    },
    relativeTime: (ms, now) => {
      const seconds = Math.round((ms - now) / 1000);
      for (const [unit, size] of RELATIVE_UNITS) {
        if (Math.abs(seconds) >= size) return relativeFormat.format(Math.trunc(seconds / size), unit);
      }
      return 'just now';
    },
    dateTime: (ms) => dateTimeFormat.format(ms),
    count,
    plural: (n, one, many) => `${count(n)} ${n === 1 ? one : many}`,
  };
}

const cache = new Map<string, Format>();

/** Memoized `makeFormat`. */
export function formatFor(locale: string): Format {
  let format = cache.get(locale);
  if (format === undefined) {
    format = makeFormat(locale);
    cache.set(locale, format);
  }
  return format;
}

/** The locale the server renders with (and the client hydrates with before switching to its own). */
export const SERVER_LOCALE = 'en-US';
