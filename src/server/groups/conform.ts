// Makes group extractor output satisfy the domain schemas (see src/server/marketplace/conform.ts
// for why). Clips long text, drops invalid optional fields, then decodes with the domain schema
// itself. Never throws.
import '@tanstack/react-start/server-only';
import { Option, Schema } from 'effect';
import { clip } from '@/server/marketplace/conform';
import {
  FbId,
  GroupComment,
  GroupId,
  GroupPost,
  GroupPostId,
  GroupSummary,
  HttpUrl,
  MAX_POST_IMAGES,
  type GroupPerson,
} from '@/shared/domain';

const isHttpUrl = Schema.is(HttpUrl);
const isFbId = Schema.is(FbId);
const isGroupId = Schema.is(GroupId);
const isPostId = Schema.is(GroupPostId);
const decodePost = Schema.decodeUnknownOption(GroupPost);
const decodeComment = Schema.decodeUnknownOption(GroupComment);
const decodeGroup = Schema.decodeUnknownOption(GroupSummary);

const urlOrNull = (s: string | null): string | null => (s !== null && isHttpUrl(s) ? s : null);
const timeOrNull = (n: number | null): number | null => (n !== null && Number.isFinite(n) && n > 0 ? n : null);
const countOrNull = (n: number | null): number | null => (n !== null && Number.isInteger(n) && n >= 0 ? n : null);

function conformPerson(person: GroupPerson | null): GroupPerson | null {
  if (person === null) return null;
  return {
    id: person.id !== null && isFbId(person.id) ? person.id : null,
    name: clip(person.name, 200),
    url: urlOrNull(person.url),
    imageUrl: urlOrNull(person.imageUrl),
  };
}

/** A post that satisfies GroupPost, or null when its ids aren't numeric. */
export function conformPost(post: GroupPost): GroupPost | null {
  if (!isPostId(post.id) || !isGroupId(post.groupId)) return null;
  return Option.getOrNull(
    decodePost({
      ...post,
      groupName: post.groupName === null ? null : clip(post.groupName, 300),
      author: conformPerson(post.author),
      text: clip(post.text, 10_000),
      createdAt: timeOrNull(post.createdAt),
      images: post.images.filter(isHttpUrl).slice(0, MAX_POST_IMAGES),
      commentCount: countOrNull(post.commentCount),
    }),
  );
}

/** A comment that satisfies GroupComment, or null. */
export function conformComment(comment: GroupComment): GroupComment | null {
  return Option.getOrNull(
    decodeComment({
      id: clip(comment.id, 64),
      author: conformPerson(comment.author),
      text: clip(comment.text, 8_000),
      createdAt: timeOrNull(comment.createdAt),
      replyCount: countOrNull(comment.replyCount) ?? 0,
    }),
  );
}

/** A group that satisfies GroupSummary, or null. */
export function conformGroupSummary(group: GroupSummary): GroupSummary | null {
  if (!isGroupId(group.id) || !isHttpUrl(group.url)) return null;
  return Option.getOrNull(
    decodeGroup({ ...group, name: clip(group.name, 300), imageUrl: urlOrNull(group.imageUrl), lastPostAt: timeOrNull(group.lastPostAt) }),
  );
}
