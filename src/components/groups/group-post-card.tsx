// One group post in a list: who, when, the text (clamped), a few photos, and a link to the post.
// Calm on purpose: no reactions, no comment previews, nothing that autoplays.
import { Link } from '@tanstack/react-router';
import { MessageSquare, Video } from 'lucide-react';
import { RelativeTime } from '@/components/listing-bits';
import { ListingImage } from '@/components/listing-image';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useFormat } from '@/hooks/use-format';
import type { GroupPerson, GroupPost } from '@/shared/domain';

const THUMBNAILS = 4;

/** A person's photo (Facebook's CDN, no referrer) or their initial. */
export function PersonAvatar({ person, className }: { readonly person: GroupPerson | null; readonly className?: string }) {
  const name = person?.name ?? 'Anonymous';
  const imageUrl = person?.imageUrl ?? null;
  return (
    <Avatar aria-hidden="true" className={className}>
      {imageUrl !== null && <AvatarImage src={imageUrl} alt="" referrerPolicy="no-referrer" />}
      <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

/** The author line: avatar, name, and when. */
export function PostByline({ post }: { readonly post: GroupPost }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <PersonAvatar person={post.author} />
      <div className="min-w-0">
        <p className="truncate font-medium">{post.author?.name ?? 'Anonymous member'}</p>
        {post.createdAt !== null && (
          <p className="text-xs text-muted-foreground">
            <RelativeTime ms={post.createdAt} />
          </p>
        )}
      </div>
    </div>
  );
}

interface GroupPostCardProps {
  readonly post: GroupPost;
  /** Keywords this post matched (a watch's match list). */
  readonly matched?: readonly string[];
}

export function GroupPostCard({ post, matched }: GroupPostCardProps) {
  const format = useFormat();
  const shown = post.images.slice(0, THUMBNAILS);
  const more = post.images.length - shown.length;
  const label = post.text.trim() === '' ? `Photo post by ${post.author?.name ?? 'a member'}` : post.text.slice(0, 80);

  return (
    <article aria-label={label} className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <PostByline post={post} />
      {post.text.trim() !== '' && <p className="line-clamp-6 whitespace-pre-line">{post.text}</p>}
      {shown.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={format.plural(post.images.length, 'photo', 'photos')}>
          {shown.map((src, i) => (
            <li key={src} className="relative">
              <ListingImage src={src} alt="" className="aspect-square w-full rounded-lg" />
              {more > 0 && i === shown.length - 1 && (
                <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/70 text-sm font-medium">
                  +{more}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
        {matched !== undefined && matched.length > 0 && (
          <span>
            Matched <span className="text-foreground">{matched.join(', ')}</span>
          </span>
        )}
        {post.hasVideo && (
          <span className="inline-flex items-center gap-1">
            <Video className="size-4" aria-hidden="true" />
            Has a video
          </span>
        )}
        {post.commentCount !== null && (
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="size-4" aria-hidden="true" />
            {format.plural(post.commentCount, 'comment', 'comments')}
          </span>
        )}
        <Link
          to="/groups/$groupId/posts/$postId"
          params={{ groupId: post.groupId, postId: post.id }}
          className="ml-auto font-medium text-primary hover:underline"
        >
          Open post
        </Link>
      </div>
    </article>
  );
}
