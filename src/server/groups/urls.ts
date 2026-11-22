// Builds facebook.com group URLs. Pure (no Effect, no Playwright).
//
// Verified against facebook.com (logged in, 2026-11):
//   /groups/{idorvanity}/?sorting_setting=CHRONOLOGICAL   the group's newest posts first ("New posts")
//   /groups/{id}/posts/{post_id}/                          one post, with its first comments
//   /groups/joins/?nav_source=tab                          the account's groups
import '@tanstack/react-start/server-only';
import { FB_ORIGIN } from '@/server/marketplace/urls';

const segment = (s: string) => encodeURIComponent(s.trim());

/** The group's feed, newest posts first. */
export const groupFeedUrl = (ref: string): string => `${FB_ORIGIN}/groups/${segment(ref)}/?sorting_setting=CHRONOLOGICAL`;

/** One group post. */
export const groupPostUrl = (groupId: string, postId: string): string =>
  `${FB_ORIGIN}/groups/${segment(groupId)}/posts/${segment(postId)}/`;

/** The account's groups. */
export const JOINED_GROUPS_URL = `${FB_ORIGIN}/groups/joins/?nav_source=tab`;
