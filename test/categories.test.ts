import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, isKnownCategory } from '@/server/marketplace/categories';
import { Category, CategorySlug } from '@/shared/domain';

describe('CATEGORIES', () => {
  it('has unique, URL-safe slugs and names', () => {
    expect(CATEGORIES.length).toBeGreaterThan(15);
    expect(new Set(CATEGORIES.map((c) => c.slug)).size).toBe(CATEGORIES.length);
    for (const c of CATEGORIES) {
      expect(c.slug).toMatch(/^[a-z0-9-]+$/);
      expect(c.name.trim()).not.toBe('');
    }
  });

  it('is the 22 verified categories, each a valid domain Category and SearchParams.category', () => {
    expect(CATEGORIES).toHaveLength(22);
    for (const c of CATEGORIES) {
      expect(Schema.decodeUnknownSync(Category)(c)).toEqual(c);
      expect(Schema.is(CategorySlug)(c.slug)).toBe(true);
    }
  });

  it('knows the verified slugs', () => {
    expect(isKnownCategory('bicycles')).toBe(true);
    expect(isKnownCategory('vehicles')).toBe(true);
    // not real Facebook slugs (they redirect to the nearby feed)
    expect(isKnownCategory('sporting-goods')).toBe(false);
    expect(isKnownCategory('home-goods')).toBe(false);
  });
});
