// Live check of the Groups engine against facebook.com, AS A LOGGED-IN ACCOUNT, through the real
// Effect layers (Groups.layer: the real Browser, headless). Run with
//
//   FACESLOP_SMOKE_GROUP=<group id> npm run smoke:groups
//
// It reads the account's Facebook session from the data dir (FACESLOP_DATA_DIR, default .data;
// log in through faceslop first), uses the only account there (or FACESLOP_SMOKE_ACCOUNT=<c_user>),
// and never writes to it. Prints counts and ids, never post text or names. About six page loads
// and a few GraphQL requests, one after another: keep it at that. The last check runs a group watch
// (an in-memory database) and delivers a signed webhook to a receiver on 127.0.0.1. Exits non-zero
// if a check fails.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Cause, Clock, ConfigProvider, Console, Effect, Exit, Layer, ManagedRuntime, Option, Ref, Schema } from 'effect';
import { BackgroundLane } from '@/server/checker/BackgroundLane';
import { AppConfig } from '@/server/config';
import { DatabaseLayerMemory } from '@/server/db/Database';
import { GroupWatchesRepo } from '@/server/db/repositories/GroupWatchesRepo';
import { WebhooksRepo } from '@/server/db/repositories/WebhooksRepo';
import { GroupWatcher } from '@/server/groups/GroupWatcher';
import { Groups } from '@/server/groups/Groups';
import { Webhooks, signWebhook } from '@/server/webhooks/Webhooks';
import { accountOwner, accountProfile, fbUserIdOf } from '@/server/session/identity';
import { GroupPost, GroupPostDetail, GroupSummary } from '@/shared/domain';
import { AppError } from '@/shared/errors';

class SmokeFailure extends Schema.TaggedError<SmokeFailure>()('SmokeFailure', { message: Schema.String }) {}

const ensure = (condition: boolean, message: string): Effect.Effect<void, SmokeFailure> =>
  condition ? Effect.void : Effect.fail(new SmokeFailure({ message }));

const groupId = process.env.FACESLOP_SMOKE_GROUP ?? '';
if (!/^\d+$/.test(groupId)) {
  console.error('Set FACESLOP_SMOKE_GROUP to a numeric group id the account is a member of.');
  process.exit(2);
}
const dataDir = path.resolve(process.env.FACESLOP_DATA_DIR ?? '.data');
const accounts = fs.existsSync(path.join(dataDir, 'fb-sessions'))
  ? fs.readdirSync(path.join(dataDir, 'fb-sessions')).filter((name) => /^\d+\.json$/.test(name)).map((name) => name.slice(0, -5))
  : [];
const userId = fbUserIdOf(process.env.FACESLOP_SMOKE_ACCOUNT ?? (accounts.length === 1 ? accounts[0] : undefined));
if (userId === null) {
  console.error(`Need exactly one logged-in account in ${dataDir}/fb-sessions (or FACESLOP_SMOKE_ACCOUNT); found ${accounts.length}.`);
  process.exit(2);
}
const profile = accountProfile(userId);

const describeCause = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  if (error instanceof AppError) return `${error.code} ${error.message}`;
  if (error instanceof SmokeFailure) return error.message;
  return error instanceof Error ? error.message : String(error);
};

const wellFormed = (posts: readonly GroupPost[]) =>
  Effect.forEach(posts, (post) => ensure(Schema.is(GroupPost)(post) && post.groupId === groupId, `post ${post.id} is malformed`), {
    discard: true,
  });

const program = Effect.gen(function* () {
  const groups = yield* Groups;
  const watches = yield* GroupWatchesRepo;
  const hooks = yield* WebhooksRepo;
  const watcher = yield* GroupWatcher;
  const webhooksService = yield* Webhooks;
  const failures = yield* Ref.make(0);
  const check = Effect.fnUntraced(function* (name: string, body: Effect.Effect<string, AppError | SmokeFailure>) {
    const started = yield* Clock.currentTimeMillis;
    const exit = yield* Effect.exit(body);
    const seconds = (((yield* Clock.currentTimeMillis) - started) / 1000).toFixed(1);
    if (Exit.isSuccess(exit)) yield* Console.log(`ok    ${name}: ${exit.value} [${seconds}s]`);
    else {
      yield* Ref.update(failures, (n) => n + 1);
      yield* Console.log(`FAIL  ${name}: ${describeCause(exit.cause)} [${seconds}s]`);
    }
  });

  let firstPostId: string | null = null;

  yield* check(
    'joined groups',
    Effect.gen(function* () {
      const list = yield* groups.joinedGroups(profile);
      yield* ensure(list.length > 0 && list.every(Schema.is(GroupSummary)), 'no well-formed groups');
      yield* ensure(list.some((g) => g.id === groupId), `group ${groupId} is not in the list`);
      return `${list.length} groups`;
    }),
  );

  yield* check(
    'feed + load more',
    Effect.gen(function* () {
      const page = yield* groups.feed(profile, groupId);
      yield* ensure(page.group.id === groupId && page.posts.length >= 2, `first page has ${page.posts.length} posts`);
      yield* wellFormed(page.posts);
      firstPostId = page.posts[0]?.id ?? null;
      if (page.sessionId === null) return `${page.posts.length} posts, no more`;
      const more = yield* groups.loadMore(profile, page.sessionId);
      yield* wellFormed(more.posts);
      const ids = new Set(page.posts.map((p) => p.id));
      yield* ensure(more.posts.length > 0 && more.posts.every((p) => !ids.has(p.id)), 'load more returned nothing new');
      if (more.sessionId !== null) yield* groups.closeFeed(profile, more.sessionId);
      return `${page.posts.length} + ${more.posts.length} posts (group "${page.group.name === null ? '?' : 'named'}")`;
    }),
  );

  yield* check(
    'latest posts (background read, 2 pages)',
    Effect.gen(function* () {
      const latest = yield* groups.latestPosts(profile, groupId, { maxPages: 2, more: () => true });
      yield* wellFormed(latest.posts);
      yield* ensure(latest.posts.length >= 4, `only ${latest.posts.length} posts`);
      return `${latest.posts.length} posts, hasMore ${String(latest.hasMore)}`;
    }),
  );

  yield* check(
    'one post with comments',
    Effect.gen(function* () {
      if (firstPostId === null) return yield* new SmokeFailure({ message: 'no post to open' });
      const detail = yield* groups.getPost(profile, groupId, firstPostId);
      yield* ensure(Schema.is(GroupPostDetail)(detail), 'malformed post detail');
      return `${detail.images.length} photos, ${detail.comments.length}/${String(detail.commentCount)} comments, canComment ${String(detail.canComment)}`;
    }),
  );

  yield* check(
    'resolve the group by id',
    Effect.map(groups.resolveGroup(profile, groupId), (group) => `resolved ${group.id}`),
  );

  yield* check(
    'watch + signed webhook to a local receiver',
    Effect.gen(function* () {
      const owner = accountOwner(userId);
      const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
      const server = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<http.Server>((resolve) => {
              const s = http.createServer((req, res) => {
                let body = '';
                req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
                req.on('end', () => {
                  received.push({ headers: req.headers, body });
                  res.writeHead(204).end();
                });
              });
              s.listen(0, '127.0.0.1', () => {
                resolve(s);
              });
            }),
        ),
        (s) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                s.close(() => {
                  resolve();
                });
              }),
          ),
      );
      const port = (server.address() as AddressInfo).port;
      const webhook = yield* hooks.create(owner, { name: 'smoke', url: `http://127.0.0.1:${String(port)}/hook`, enabled: true }, Date.now());
      const watch = Option.getOrThrow(
        yield* watches.create(owner, { groupId, groupName: 'smoke', keywords: [], excludeKeywords: [], intervalMinutes: 15, enabled: true }, Date.now()),
      );
      const baseline = yield* watcher.checkNow(owner, watch.id);
      yield* ensure(baseline.watch.seeded && baseline.matches.length === 0, 'the first check should only record a baseline');
      // A real post from the group, as a match, through the real delivery path.
      const latest = yield* groups.latestPosts(profile, groupId, { maxPages: 0, more: () => false });
      const post = latest.posts[0];
      if (post === undefined) return yield* new SmokeFailure({ message: 'no post to deliver' });
      yield* webhooksService.notifyGroupPost(owner, baseline.watch, { watchId: watch.id, post, matchedKeywords: [], matchedAt: Date.now() });
      yield* webhooksService.deliverDue;
      const [hit] = received;
      if (hit === undefined) return yield* new SmokeFailure({ message: 'the receiver got nothing' });
      const timestamp = Number(hit.headers['x-faceslop-timestamp']);
      yield* ensure(hit.headers['x-faceslop-signature'] === signWebhook(webhook.secret, timestamp, hit.body), 'bad signature');
      yield* ensure((JSON.parse(hit.body) as { post: { id: string } }).post.id === post.id, 'wrong post in the payload');
      return `baseline of ${String((yield* watches.recentSeenIds(watch.id)).size)} posts, 1 signed delivery`;
    }).pipe(Effect.scoped),
  );

  return yield* Ref.get(failures);
});

// The account's session file is only read: Groups never saves cookies back.
const defaults = ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ FACESLOP_DATA_DIR: dataDir, FACESLOP_DISABLE_CHECKER: '1' }));
// The watch and webhook rows live in an in-memory database; Groups is the real one.
const watchLayers = GroupWatcher.layerNoDeps.pipe(
  Layer.provideMerge(Webhooks.layerNoDeps),
  Layer.provideMerge(Layer.mergeAll(GroupWatchesRepo.layerNoDeps, WebhooksRepo.layerNoDeps)),
  Layer.provideMerge(Groups.layer),
  Layer.provide([DatabaseLayerMemory, BackgroundLane.layer, AppConfig.layer]),
);
const runtime = ManagedRuntime.make(watchLayers.pipe(Layer.provide(defaults)));

let failures = 1;
try {
  failures = await runtime.runPromise(program);
} catch (error) {
  console.error('smoke run failed:', error);
} finally {
  await runtime.dispose();
}
console.log(failures > 0 ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures > 0 ? 1 : 0);
