// Pure functions that turn Facebook group pages and GraphQL payloads into domain types. No Effect
// runtime, no Playwright: unit-tested against test/fixtures/group-*.
//
// Same approach as src/server/marketplace/extract.ts: walk parsed JSON for known keys, treat every
// field as optional, and send everything emitted through ./conform.ts. What the payloads look like
// (as of 2026-11):
// - A post is an object with `__typename: "Story"`, a `post_id` and `comet_sections`. The group page
//   embeds the newest one (`group.group_feed.edges`); the rest come from
//   GroupsCometFeedRegularStoriesPaginationQuery, a Relay @stream response: the first document has
//   edge 0, each later "$stream$" document one more edge, and a "$defer$...$page_info" document the
//   page_info. Three posts per request, whatever `count` asks for.
// - Its group is `target_group` / `to` (a Group) / `feedback.associated_group`. Pages also carry
//   stories that aren't the group's (a post page has the viewer's news feed and ads): those are
//   skipped by checking the group.
// - Text: `message.text` (a TextWithEntities); author: `actors[0]`; photos: `Photo` media under
//   `attachments` (`image.uri` / `viewer_image.uri` / `photo_image.uri`); comment count:
//   `comment_rendering_instance.comments.total_count`.
// - A post page (/groups/<id>/posts/<post_id>/) has the post as `node_v2` with its top-level
//   comments inside: `Comment` objects with `body.text`, `author`, `created_time`, `legacy_fbid`.
// - The groups list (/groups/joins/) has `all_joined_groups.tab_groups_list.edges[].node` and
//   `nonAdminGroups.groups_tab.tab_groups_list.edges[].node` (the latter with `last_post_time`).
import '@tanstack/react-start/server-only';
import { conformComment, conformGroupSummary, conformPost } from '@/server/groups/conform';
import { groupPostUrl } from '@/server/groups/urls';
import { findAll, get, idStr, isObj, num, str, walk, type Obj, type PageInfo } from '@/server/marketplace/extract';
import type { GroupComment, GroupInfo, GroupPerson, GroupPost, GroupPostDetail, GroupSummary } from '@/shared/domain';
import { MAX_POST_IMAGES } from '@/shared/domain';

const isStory = (o: Obj): boolean => o.__typename === 'Story' && str(o.post_id) !== null && isObj(o.comet_sections);

/** Facebook's seconds -> epoch milliseconds (null for anything that isn't a plausible time). */
const secondsToMillis = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? Math.round(n * 1000) : null;
};

/** The first value `pick` returns for an object under `root` (document order), or null. */
function first<A>(root: unknown, pick: (o: Obj) => A | null): A | null {
  let found: A | null = null;
  walk(root, (o) => {
    if (found !== null) return false;
    found = pick(o);
    return found === null ? undefined : false;
  });
  return found;
}

/** Every object under `root` that `test` accepts (document order). Doesn't descend into matches. */
function collect(root: unknown, test: (o: Obj) => boolean): Obj[] {
  const out: Obj[] = [];
  walk(root, (o) => {
    if (!test(o)) return undefined;
    out.push(o);
    return false;
  });
  return out;
}

const groupOf = (o: unknown): Obj | null => (isObj(o) && o.__typename === 'Group' && idStr(o.id) !== null ? o : null);

/** The group a story was posted to, or null (news feed stories, ads). */
export function storyGroup(story: Obj): GroupInfo | null {
  const named = first(story, (o) => {
    const group = groupOf(o.target_group) ?? groupOf(o.to);
    return group !== null && str(group.name) !== null ? group : null;
  });
  const any =
    named ??
    first(story, (o) => groupOf(o.target_group) ?? groupOf(o.to) ?? (isObj(o.target_group) && idStr(o.target_group.id) ? o.target_group : null));
  const id = idStr(any?.id) ?? idStr(get(story, 'feedback', 'associated_group', 'id'));
  return id === null ? null : { id, name: str(named?.name) };
}

function personOf(o: unknown, pictureKeys: readonly string[]): GroupPerson | null {
  if (!isObj(o)) return null;
  const name = str(o.name);
  if (name === null) return null;
  let imageUrl: string | null = null;
  for (const key of pictureKeys) imageUrl ??= str(get(o, key, 'uri'));
  return { id: idStr(o.id), name, url: str(o.profile_url) ?? str(o.url), imageUrl };
}

/**
 * The story's author: the first `actors` entry with a name. The story repeats its actors in
 * several sections, and only some copies carry the profile picture, so that comes from any copy.
 */
function authorOf(story: Obj): GroupPerson | null {
  const actors: Obj[] = [];
  walk(story, (o) => {
    if (Array.isArray(o.actors)) for (const actor of o.actors) if (isObj(actor)) actors.push(actor);
    return undefined;
  });
  let author: GroupPerson | null = null;
  for (const actor of actors) author ??= personOf(actor, ['profile_picture']);
  if (author?.imageUrl !== null) return author;
  const id = author.id;
  const picture = actors.map((actor) => (idStr(actor.id) === id ? str(get(actor, 'profile_picture', 'uri')) : null)).find((uri) => uri !== null);
  return { ...author, imageUrl: picture ?? null };
}

/** The post's text: the first `message` that is a TextWithEntities (comments use `body`, so they never match). */
function textOf(story: Obj): string {
  return (
    first(story, (o) => {
      const message = o.message;
      return isObj(message) && (message.__typename === 'TextWithEntities' || 'text' in message) && typeof message.text === 'string'
        ? message.text
        : null;
    }) ?? ''
  );
}

const PHOTO_URI_KEYS = ['image', 'viewer_image', 'photo_image', 'large_share_image'] as const;

/** Photo URLs under the story's attachments, in order, one per photo id. */
function imagesOf(story: Obj): { readonly images: string[]; readonly hasVideo: boolean } {
  const byId = new Map<string, string>();
  let hasVideo = false;
  const roots = findAll(story, 'attachments').map((o) => o.attachments);
  for (const root of roots) {
    walk(root, (o) => {
      if (o.__typename === 'Video') hasVideo = true;
      if (o.__typename !== 'Photo') return undefined;
      const id = idStr(o.id) ?? `#${String(byId.size)}`;
      if (byId.has(id)) return false;
      for (const key of PHOTO_URI_KEYS) {
        const uri = str(get(o, key, 'uri'));
        if (uri !== null) {
          byId.set(id, uri);
          break;
        }
      }
      return false;
    });
  }
  return { images: [...byId.values()].slice(0, MAX_POST_IMAGES), hasVideo };
}

function commentCountOf(story: Obj): number | null {
  return first(story, (o) => {
    const total = num(get(o, 'comment_rendering_instance', 'comments', 'total_count')) ?? num(o.total_comment_count);
    return total !== null && total >= 0 ? total : null;
  });
}

/** One story as a post of `groupId`, or null when it belongs elsewhere or can't be read. */
export function normalizePost(story: Obj, groupId: string): GroupPost | null {
  const id = str(story.post_id);
  const group = storyGroup(story);
  if (id === null || group?.id !== groupId) return null;
  const { images, hasVideo } = imagesOf(story);
  return conformPost({
    id,
    groupId,
    groupName: group.name,
    author: authorOf(story),
    text: textOf(story),
    createdAt: secondsToMillis(story.creation_time) ?? first(story, (o) => secondsToMillis(o.creation_time)),
    images,
    hasVideo,
    commentCount: commentCountOf(story),
    url: groupPostUrl(groupId, id),
  });
}

/** Every post of `groupId` in the payload, in feed order, once each (the first copy wins). */
export function findGroupPosts(root: unknown, groupId: string): GroupPost[] {
  const out = new Map<string, GroupPost>();
  for (const story of collect(root, isStory)) {
    const post = normalizePost(story, groupId);
    if (post !== null && !out.has(post.id)) out.set(post.id, post);
  }
  return [...out.values()];
}

/** True when the payload has a group feed (a group page or a pagination response), even an empty one. */
export function hasGroupFeed(root: unknown): boolean {
  return findAll(root, 'group_feed').length > 0;
}

/**
 * The group feed's pagination state: `group_feed.page_info`, or the deferred document labelled
 * "...group_feed$page_info" (page and pagination response alike) that carries it at its data root.
 * Other connections on the page (highlights, profiles) have page_info too, so nothing else counts.
 */
export function extractGroupFeedPageInfo(root: unknown): PageInfo | null {
  const infos: Obj[] = [];
  walk(root, (o) => {
    const feedInfo = get(o, 'group_feed', 'page_info');
    if (isObj(feedInfo)) infos.push(feedInfo);
    const deferred = get(o, 'data', 'page_info');
    if (isObj(deferred) && str(o.label)?.includes('group_feed$page_info') === true) infos.push(deferred);
    return undefined;
  });
  const pi = infos[infos.length - 1];
  if (!pi) return null;
  const endCursor = str(pi.end_cursor);
  return { endCursor, hasNextPage: pi.has_next_page === true && endCursor !== null };
}

/** The group a group page is about (its header), or null. */
export function extractGroupInfo(root: unknown): (GroupInfo & { readonly isMember: boolean | null }) | null {
  const header = first(root, (o) => groupOf(get(o, 'profile_header_renderer', 'group')));
  const withFeed = first(root, (o) => {
    const group = o.group;
    return isObj(group) && 'group_feed' in group && idStr(group.id) !== null ? group : null;
  });
  const group = header ?? withFeed;
  const id = idStr(group?.id);
  if (id === null) return null;
  const joinState = str(group?.viewer_join_state);
  return { id, name: str(group?.name), isMember: joinState === null ? null : joinState === 'MEMBER' };
}

/** The idorvanity of a group page's route ("1721…" or "okpuppies"), or null. */
export function extractGroupRouteRef(root: unknown): string | null {
  return first(root, (o) => (str(o.routePath)?.startsWith('/groups/') === true ? str(get(o, 'params', 'idorvanity')) : null));
}

function normalizeComment(o: Obj): GroupComment | null {
  const id = idStr(o.legacy_fbid) ?? idStr(o.id);
  if (id === null) return null;
  const text = str(get(o, 'body', 'text')) ?? str(get(o, 'preferred_body', 'text')) ?? '';
  return conformComment({
    id,
    author: personOf(o.author, ['profile_picture_depth_0', 'profile_picture']),
    text,
    createdAt: secondsToMillis(o.created_time),
    replyCount: num(get(o, 'feedback', 'replies_fields', 'total_count')) ?? 0,
  });
}

/**
 * The post `postId` of `groupId` with its top-level comments (as its post page shows them), or
 * null when the page doesn't have it. When the payload has several copies, the one with comments wins.
 */
export function extractGroupPostDetail(root: unknown, groupId: string, postId: string): GroupPostDetail | null {
  const stories = collect(root, isStory).filter((story) => story.post_id === postId);
  let best: { readonly post: GroupPost; readonly story: Obj; readonly comments: GroupComment[] } | null = null;
  for (const story of stories) {
    const post = normalizePost(story, groupId);
    if (post === null) continue;
    const comments = new Map<string, GroupComment>();
    for (const node of collect(story, (o) => o.__typename === 'Comment' && isObj(o.body))) {
      // Top-level only: replies are counted (replyCount), not shown.
      const depth = num(node.depth);
      if (depth !== null && depth > 0) continue;
      const comment = normalizeComment(node);
      if (comment !== null && !comments.has(comment.id)) comments.set(comment.id, comment);
    }
    if (best === null || comments.size > best.comments.length) best = { post, story, comments: [...comments.values()] };
  }
  if (best === null) return null;
  const canComment = first(best.story, (o) => (typeof o.can_viewer_comment === 'boolean' ? o.can_viewer_comment : null));
  return {
    ...best.post,
    comments: [...best.comments].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
    canComment: canComment ?? false,
  };
}

/** The account's groups (the groups list page), most recently active first when Facebook says. */
export function extractJoinedGroups(root: unknown): GroupSummary[] {
  const out = new Map<string, GroupSummary>();
  const lastPost = new Map<string, number>();
  const nodes: Obj[] = [];
  walk(root, (o) => {
    const edges = get(o, 'tab_groups_list', 'edges');
    if (!Array.isArray(edges)) return undefined;
    for (const edge of edges) {
      const node = groupOf(get(edge, 'node'));
      if (node !== null) nodes.push(node);
    }
    return undefined;
  });
  for (const node of nodes) {
    const id = idStr(node.id);
    const at = secondsToMillis(node.last_post_time);
    if (id !== null && at !== null) lastPost.set(id, Math.max(at, lastPost.get(id) ?? 0));
  }
  for (const node of nodes) {
    const id = idStr(node.id);
    const name = str(node.name);
    if (id === null || name === null || out.has(id)) continue;
    const imageUrl = str(get(node, 'profile_picture', 'uri')) ?? str(get(node, 'profile_picture_48', 'uri'));
    const group = conformGroupSummary({
      id,
      name,
      url: str(node.url) ?? `https://www.facebook.com/groups/${id}/`,
      imageUrl,
      lastPostAt: lastPost.get(id) ?? null,
    });
    if (group !== null) out.set(id, group);
  }
  return [...out.values()].sort((a, b) => (b.lastPostAt ?? 0) - (a.lastPostAt ?? 0));
}
