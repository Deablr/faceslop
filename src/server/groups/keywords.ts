// Which group posts a watch reports. Pure (unit-tested in test/group-watcher.test.ts).
//
// Keywords are normalized like Settings.excludedKeywords (lowercase, single spaces) and match the
// START of a word in the post's text, ignoring case and accents: "golden" matches "Goldendoodle"
// and "golden retriever", "lab" matches "Lab mix" but not "available". A post containing any
// excluded keyword never matches. A watch without keywords matches every post (photo-only posts,
// which have no text, can only match such a watch).
import '@tanstack/react-start/server-only';
import type { GroupPost } from '@/shared/domain';

/** Lowercase, accents removed, whitespace collapsed. */
export const foldText = (text: string): string =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `keyword` starts a word in already-folded `text`. */
export function containsKeyword(text: string, keyword: string): boolean {
  const folded = foldText(keyword);
  if (folded === '') return false;
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(folded)}`, 'u').test(text);
}

/** The keywords a post matched ([] for a watch without keywords), or null when it doesn't match. */
export function matchPost(post: Pick<GroupPost, 'text'>, keywords: readonly string[], excluded: readonly string[]): string[] | null {
  const text = foldText(post.text);
  if (excluded.some((keyword) => containsKeyword(text, keyword))) return null;
  if (keywords.length === 0) return [];
  const matched = keywords.filter((keyword) => containsKeyword(text, keyword));
  return matched.length > 0 ? matched : null;
}
