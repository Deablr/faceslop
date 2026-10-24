// The session nudge's rules and its sessionStorage store (src/lib/browsing-time.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_BROWSING, SNOOZE_MS, readBrowsing, shouldNudge, writeBrowsing } from '@/lib/browsing-time';

const minutes = (n: number) => n * 60_000;

describe('shouldNudge', () => {
  it('waits for the configured visible time', () => {
    expect(shouldNudge({ ...EMPTY_BROWSING, elapsedMs: minutes(29) }, 30)).toBe(false);
    expect(shouldNudge({ ...EMPTY_BROWSING, elapsedMs: minutes(30) }, 30)).toBe(true);
  });

  it('is off at 0 minutes and once dismissed', () => {
    expect(shouldNudge({ ...EMPTY_BROWSING, elapsedMs: minutes(300) }, 0)).toBe(false);
    expect(shouldNudge({ elapsedMs: minutes(300), snoozeUntilMs: null, dismissed: true }, 30)).toBe(false);
  });

  it('"5 more minutes" moves the threshold', () => {
    const snoozed = { elapsedMs: minutes(31), snoozeUntilMs: minutes(31) + SNOOZE_MS, dismissed: false };
    expect(shouldNudge(snoozed, 30)).toBe(false);
    expect(shouldNudge({ ...snoozed, elapsedMs: snoozed.snoozeUntilMs }, 30)).toBe(true);
  });
});

describe('the browsing-time store', () => {
  const stubStorage = (initial: Record<string, string>) => {
    const items = new Map(Object.entries(initial));
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
    });
    return items;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads back what it wrote, as the same object until it changes', () => {
    const items = stubStorage({});
    writeBrowsing({ elapsedMs: minutes(12), snoozeUntilMs: null, dismissed: false });
    expect(JSON.parse(items.get('faceslop.browsing') ?? '')).toEqual({ elapsedMs: minutes(12), snoozeUntilMs: null, dismissed: false });
    const first = readBrowsing();
    expect(first.elapsedMs).toBe(minutes(12));
    expect(readBrowsing()).toBe(first);
  });

  it('starts over at zero from anything unreadable', () => {
    for (const raw of ['not json', '[]', '{"elapsedMs":-5,"snoozeUntilMs":null,"dismissed":false}', '{"elapsedMs":"10"}']) {
      stubStorage({ 'faceslop.browsing': raw });
      expect(readBrowsing()).toEqual(EMPTY_BROWSING);
    }
  });

  it('falls back to memory when storage is unavailable', () => {
    stubStorage({});
    writeBrowsing({ elapsedMs: minutes(3), snoozeUntilMs: null, dismissed: true });
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readBrowsing()).toEqual({ elapsedMs: minutes(3), snoozeUntilMs: null, dismissed: true });
  });
});
