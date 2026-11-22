// Facebook groups (read as this browser's Facebook account: NOT_LOGGED_IN otherwise) and group
// watches (owned by that account, shared by every device logged in to it).
//
// - Reading: the account's groups, a group's newest posts (+ "load more"), one post with comments,
//   and resolving a pasted group link. Nothing is filtered: a group is what its members post.
// - Watches: CRUD, "check now", and the matches a watch found. Creating one records its baseline
//   in the background (GroupWatcher.scheduleSeed), so only posts after it count as new.
import { createServerFn } from '@tanstack/react-start';
import { Effect, Option } from 'effect';
import { runEffect, validate } from '@/server/bridge';
import { GroupWatchesRepo } from '@/server/db/repositories/GroupWatchesRepo';
import { GroupWatcher } from '@/server/groups/GroupWatcher';
import { Groups } from '@/server/groups/Groups';
import { currentOwner, requireAccount } from '@/server/session/CurrentClient';
import { accountOwner, accountProfile } from '@/server/session/identity';
import {
  GroupPostRequest,
  GroupRequest,
  GroupWatchIdRequest,
  GroupWatchInput,
  LoadMoreRequest,
  OK,
  ResolveGroupRequest,
  UpdateGroupWatchInput,
  ViewGroupWatchMatchesRequest,
  parseGroupRef,
  type GroupWatch,
  type GroupWatchMatch,
} from '@/shared/domain';
import { AppError } from '@/shared/errors';

/** How many of a watch's matches the UI lists. */
const MATCHES_SHOWN = 50;

const watchGone = () => new AppError({ code: 'NOT_FOUND', message: 'That group watch no longer exists.' });

export const listJoinedGroups = createServerFn({ method: 'GET' }).handler(() =>
  runEffect(Effect.flatMap(requireAccount, ({ userId }) => Groups.use((groups) => groups.joinedGroups(accountProfile(userId))))),
);

export const resolveGroup = createServerFn({ method: 'POST' })
  .validator(validate(ResolveGroupRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.gen(function* () {
        const { userId } = yield* requireAccount;
        const ref = parseGroupRef(data.ref);
        if (ref === null) return yield* new AppError({ code: 'BAD_REQUEST', message: "That doesn't look like a Facebook group link." });
        return yield* Groups.use((groups) => groups.resolveGroup(accountProfile(userId), ref));
      }),
    ),
  );

export const groupFeed = createServerFn({ method: 'GET' })
  .validator(validate(GroupRequest))
  .handler(({ data }) =>
    runEffect(Effect.flatMap(requireAccount, ({ userId }) => Groups.use((groups) => groups.feed(accountProfile(userId), data.groupId)))),
  );

export const loadMoreGroupPosts = createServerFn({ method: 'POST' })
  .validator(validate(LoadMoreRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.flatMap(requireAccount, ({ userId }) => Groups.use((groups) => groups.loadMore(accountProfile(userId), data.sessionId))),
    ),
  );

export const getGroupPost = createServerFn({ method: 'GET' })
  .validator(validate(GroupPostRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.flatMap(requireAccount, ({ userId }) =>
        Groups.use((groups) => groups.getPost(accountProfile(userId), data.groupId, data.postId)),
      ),
    ),
  );

// ---------- watches ----------

export const listGroupWatches = createServerFn({ method: 'GET' }).handler(() =>
  runEffect(
    Effect.flatMap(currentOwner, (owner) =>
      Option.isNone(owner) ? Effect.succeed<readonly GroupWatch[]>([]) : GroupWatchesRepo.use((repo) => repo.list(owner.value)),
    ),
  ),
);

export const createGroupWatch = createServerFn({ method: 'POST' })
  .validator(validate(GroupWatchInput))
  .handler(({ data }) =>
    runEffect(
      Effect.gen(function* () {
        const owner = accountOwner((yield* requireAccount).userId);
        const created = yield* GroupWatchesRepo.use((repo) => repo.create(owner, data, Date.now()));
        if (Option.isNone(created)) return yield* new AppError({ code: 'BAD_REQUEST', message: 'You already watch this group.' });
        yield* GroupWatcher.use((watcher) => watcher.scheduleSeed(owner, created.value.id));
        return created.value;
      }),
    ),
  );

export const updateGroupWatch = createServerFn({ method: 'POST' })
  .validator(validate(UpdateGroupWatchInput))
  .handler(({ data }) =>
    runEffect(
      Effect.gen(function* () {
        const owner = accountOwner((yield* requireAccount).userId);
        const updated = yield* GroupWatchesRepo.use((repo) => repo.update(owner, data.id, data.patch));
        return Option.isNone(updated) ? yield* watchGone() : updated.value;
      }),
    ),
  );

/** Idempotent: deleting a missing watch is fine. */
export const deleteGroupWatch = createServerFn({ method: 'POST' })
  .validator(validate(GroupWatchIdRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.flatMap(requireAccount, ({ userId }) => GroupWatchesRepo.use((repo) => repo.remove(accountOwner(userId), data.id))).pipe(
        Effect.as(OK),
      ),
    ),
  );

export const checkGroupWatch = createServerFn({ method: 'POST' })
  .validator(validate(GroupWatchIdRequest))
  .handler(({ data }) =>
    runEffect(Effect.flatMap(requireAccount, ({ userId }) => GroupWatcher.use((watcher) => watcher.checkNow(accountOwner(userId), data.id)))),
  );

export const listGroupWatchMatches = createServerFn({ method: 'GET' })
  .validator(validate(GroupWatchIdRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.flatMap(currentOwner, (owner) =>
        Option.isNone(owner)
          ? Effect.succeed<readonly GroupWatchMatch[]>([])
          : GroupWatchesRepo.use((repo) => repo.matches(owner.value, data.id, MATCHES_SHOWN)),
      ),
    ),
  );

/** Mark a watch's matches seen up to the newest one shown (later ones still count as new). */
export const viewGroupWatchMatches = createServerFn({ method: 'POST' })
  .validator(validate(ViewGroupWatchMatchesRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.gen(function* () {
        const owner = accountOwner((yield* requireAccount).userId);
        if (!(yield* GroupWatchesRepo.use((repo) => repo.viewMatches(owner, data.id, data.upTo)))) return yield* watchGone();
        return OK;
      }),
    ),
  );
