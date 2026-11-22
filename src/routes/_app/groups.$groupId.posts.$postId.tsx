import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ArrowLeft, MessageCircle, MessageSquare } from 'lucide-react';
import { ErrorState } from '@/components/error-state';
import { PersonAvatar, PostByline } from '@/components/groups/group-post-card';
import { RelativeTime } from '@/components/listing-bits';
import { PhotoGallery } from '@/components/photo-gallery';
import { RemoteViewDialogButton } from '@/components/remote-viewer/remote-view-panel';
import { RequireFacebook } from '@/components/require-facebook';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/hooks/use-format';
import { findCachedGroupPost, groupPostQuery } from '@/lib/queries';
import type { GroupComment, GroupPost, GroupPostDetail } from '@/shared/domain';

export const Route = createFileRoute('/_app/groups/$groupId/posts/$postId')({
  // The post comes from Facebook (seconds): fetched on the client only.
  head: () => ({ meta: [{ title: 'Group post · faceslop' }] }),
  component: GroupPostPage,
});

function GroupPostPage() {
  const { groupId, postId } = Route.useParams();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <Link
        to="/groups/$groupId"
        params={{ groupId }}
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to the group
      </Link>
      <RequireFacebook reason="Group posts are read as your Facebook account.">
        <PostView key={`${groupId}/${postId}`} groupId={groupId} postId={postId} />
      </RequireFacebook>
    </div>
  );
}

function PostView({ groupId, postId }: { readonly groupId: string; readonly postId: string }) {
  const queryClient = useQueryClient();
  const detail = useQuery(groupPostQuery(groupId, postId));
  const cached = detail.data === undefined ? findCachedGroupPost(queryClient, groupId, postId) : undefined;
  const post: GroupPost | undefined = detail.data ?? cached;

  return (
    <article className="flex flex-col gap-6">
      {post === undefined ? (
        <Skeleton className="h-12 w-64" />
      ) : (
        <header className="flex flex-col gap-4">
          <PostByline post={post} />
          {post.groupName !== null && <p className="text-sm text-muted-foreground">In {post.groupName}</p>}
          {post.text.trim() !== '' && <p className="text-lg whitespace-pre-line">{post.text}</p>}
        </header>
      )}
      {post !== undefined && post.images.length > 0 && <PhotoGallery photos={post.images} title={post.text.slice(0, 60) || 'this post'} />}
      {post?.hasVideo === true && (
        <p className="text-sm text-muted-foreground">
          This post has a video. faceslop doesn’t play videos; open the post on Facebook below to watch it.
        </p>
      )}
      {detail.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : detail.isError ? (
        <ErrorState
          error={detail.error}
          onRetry={() => {
            void detail.refetch();
          }}
          retrying={detail.isFetching}
        />
      ) : (
        <>
          <PostActions post={detail.data} />
          <Comments post={detail.data} />
        </>
      )}
    </article>
  );
}

function PostActions({ post }: { readonly post: GroupPostDetail }) {
  const author = post.author;
  const firstName = author?.name.split(' ')[0] ?? 'the author';
  return (
    <div className="flex flex-wrap gap-3">
      <RemoteViewDialogButton
        request={{ target: 'groupPost', groupId: post.groupId, postId: post.id }}
        title="Comment on Facebook"
        description="Just this post, live from Facebook. Comment, then press Done. The rest of Facebook stays closed."
        variant="default"
      >
        <MessageSquare aria-hidden="true" />
        {post.canComment ? 'Comment' : 'Open on Facebook'}
      </RemoteViewDialogButton>
      {author !== null && author.id !== null && /^\d+$/.test(author.id) && (
        <RemoteViewDialogButton
          request={{ target: 'message', userId: author.id }}
          title={`Message ${author.name}`}
          description="Just this conversation in Messenger, live from Facebook. Press Done when you’re finished."
        >
          <MessageCircle aria-hidden="true" />
          Message {firstName}
        </RemoteViewDialogButton>
      )}
    </div>
  );
}

function Comments({ post }: { readonly post: GroupPostDetail }) {
  const format = useFormat();
  const total = post.commentCount ?? post.comments.length;
  return (
    <section aria-labelledby="comments-heading" className="flex flex-col gap-3">
      <h2 id="comments-heading" className="text-base font-semibold tracking-tight">
        {format.plural(total, 'comment', 'comments')}
      </h2>
      {post.comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{total === 0 ? 'No comments yet.' : 'Facebook didn’t include the comments here.'}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {post.comments.map((comment) => (
            <CommentItem key={comment.id} comment={comment} />
          ))}
        </ul>
      )}
      {total > post.comments.length && post.comments.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Showing the first {String(post.comments.length)}. The rest are on Facebook (“Comment” opens the post).
        </p>
      )}
    </section>
  );
}

function CommentItem({ comment }: { readonly comment: GroupComment }) {
  const format = useFormat();
  return (
    <li className="flex gap-3">
      <PersonAvatar person={comment.author} className="mt-0.5" />
      <div className="min-w-0 flex-1 rounded-xl bg-muted px-3 py-2">
        <p className="text-sm font-medium">{comment.author?.name ?? 'A member'}</p>
        {comment.text !== '' && <p className="text-sm whitespace-pre-line">{comment.text}</p>}
        <p className="mt-1 text-xs text-muted-foreground">
          {comment.createdAt !== null && <RelativeTime ms={comment.createdAt} />}
          {comment.replyCount > 0 && ` · ${format.plural(comment.replyCount, 'reply', 'replies')}`}
        </p>
      </div>
    </li>
  );
}
