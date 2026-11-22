// Group page extractors against trimmed, anonymized Facebook payloads (test/fixtures/group-*):
// a group's page (newest post + header), one pagination response (a Relay @stream body), a post
// page (with the viewer's news feed and an ad around it), and the account's groups list.
import fs from 'node:fs';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  extractGroupFeedPageInfo,
  extractGroupInfo,
  extractGroupPostDetail,
  extractGroupRouteRef,
  extractJoinedGroups,
  findGroupPosts,
  hasGroupFeed,
} from '@/server/groups/extract';
import { extractJsonBlobs, parseGraphqlBody } from '@/server/marketplace/extract';
import { GroupPost, GroupPostDetail, GroupSummary, parseGroupRef } from '@/shared/domain';

const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const GROUP = '1000000000000001';
const feedBlobs = extractJsonBlobs(fixture('group-feed.html'));
const pageDocs = parseGraphqlBody(fixture('group-feed-page2.graphql.txt'));
const postBlobs = extractJsonBlobs(fixture('group-post.html'));
const joinsBlobs = extractJsonBlobs(fixture('group-joins.html'));

const isPost = Schema.is(GroupPost);

describe('group page', () => {
  it('reads the group header, route and feed cursor', () => {
    expect(hasGroupFeed(feedBlobs)).toBe(true);
    expect(extractGroupInfo(feedBlobs)).toEqual({ id: GROUP, name: 'Test Puppy Group', isMember: true });
    expect(extractGroupRouteRef(feedBlobs)).toBe(GROUP);
    expect(extractGroupFeedPageInfo(feedBlobs)).toEqual({ endCursor: expect.any(String) as string, hasNextPage: true });
  });

  it('reads the newest post the page embeds', () => {
    const posts = findGroupPosts(feedBlobs, GROUP);
    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(post).toMatchObject({
      id: '9000000000000066',
      groupId: GROUP,
      groupName: 'Test Puppy Group',
      text: 'Goldendoodle puppies available Dec 1',
      createdAt: 1795285848000,
      hasVideo: false,
      commentCount: 3,
      url: `https://www.facebook.com/groups/${GROUP}/posts/9000000000000066/`,
    });
    expect(post?.images).toHaveLength(1);
    expect(post?.author).toMatchObject({ name: expect.stringMatching(/^Person \d+$/) as string, imageUrl: expect.stringMatching(/^https:\/\//) as string });
    expect(posts.every(isPost)).toBe(true);
  });

  it('reads nothing for another group', () => {
    expect(findGroupPosts(feedBlobs, '42')).toEqual([]);
  });
});

describe('pagination response', () => {
  it('reads every streamed post, in feed order, and the deferred page_info', () => {
    const posts = findGroupPosts(pageDocs, GROUP);
    expect(posts.map((p) => p.id)).toEqual(['9000000000000070', '9000000000000083', '9000000000000093']);
    expect(posts.map((p) => p.images.length)).toEqual([5, 3, 4]);
    expect(posts.map((p) => p.hasVideo)).toEqual([false, true, true]);
    expect(posts.map((p) => p.commentCount)).toEqual([113, 3, 1]);
    // Photo-only posts have no text.
    expect(posts.map((p) => p.text)).toEqual(['Pugs!!!\nLakeview, OK', '', '']);
    expect(posts.every(isPost)).toBe(true);
    expect(extractGroupFeedPageInfo(pageDocs)).toEqual({ endCursor: expect.any(String) as string, hasNextPage: true });
  });

  it('dedupes photos that appear in several sections', () => {
    for (const post of findGroupPosts(pageDocs, GROUP)) expect(new Set(post.images).size).toBe(post.images.length);
  });
});

describe('post page', () => {
  it('reads the post with its top-level comments, oldest first', () => {
    const detail = extractGroupPostDetail(postBlobs, GROUP, '9000000000000002');
    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({ id: '9000000000000002', commentCount: 23, canComment: true, text: 'Mini dachshunds, 2 boys left\nLawton ok' });
    expect(detail?.images).toHaveLength(5);
    expect(detail?.comments).toHaveLength(10);
    const times = detail?.comments.map((c) => c.createdAt ?? 0) ?? [];
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(detail?.comments[0]).toMatchObject({ text: 'Price?', replyCount: 0, author: { name: expect.stringMatching(/^Person/) as string } });
    expect(Schema.is(GroupPostDetail)(detail)).toBe(true);
  });

  it("skips the viewer's news feed and ads on the page", () => {
    expect(findGroupPosts(postBlobs, GROUP).map((p) => p.id)).toEqual(['9000000000000002']);
  });

  it('is null for a post that is not there, or not in that group', () => {
    expect(extractGroupPostDetail(postBlobs, GROUP, '1')).toBeNull();
    expect(extractGroupPostDetail(postBlobs, '42', '9000000000000002')).toBeNull();
  });
});

describe('groups list', () => {
  it("reads the account's groups once each, most recently active first", () => {
    const groups = extractJoinedGroups(joinsBlobs);
    expect(groups.length).toBeGreaterThanOrEqual(7);
    expect(new Set(groups.map((g) => g.id)).size).toBe(groups.length);
    expect(groups.find((g) => g.id === GROUP)).toMatchObject({ name: 'Test Puppy Group', url: `https://www.facebook.com/groups/${GROUP}/` });
    const times = groups.map((g) => g.lastPostAt ?? 0);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(groups.every(Schema.is(GroupSummary))).toBe(true);
  });
});

describe('parseGroupRef', () => {
  it.each([
    ['https://www.facebook.com/groups/1721721128350959', '1721721128350959'],
    ['https://www.facebook.com/groups/1721721128350959/?ref=share', '1721721128350959'],
    ['facebook.com/groups/okpuppies/', 'okpuppies'],
    ['https://m.facebook.com/groups/ok.puppies/posts/123/', 'ok.puppies'],
    [' 1721721128350959 ', '1721721128350959'],
    ['okpuppies', 'okpuppies'],
  ])('reads %s', (input, ref) => {
    expect(parseGroupRef(input)).toBe(ref);
  });

  it.each(['https://example.com/groups/1/', 'https://www.facebook.com/marketplace/', 'two words', ''])('rejects %s', (input) => {
    expect(parseGroupRef(input)).toBeNull();
  });
});
