// One group watch in the Groups page: what it reports, when it last looked, and its controls.
import { Link } from '@tanstack/react-router';
import { Pencil, Trash2 } from 'lucide-react';
import { useId } from 'react';
import { InlineError } from '@/components/error-state';
import { describeInterval, describeWatch, WatchDialog } from '@/components/groups/watch-dialog';
import { RelativeTime } from '@/components/listing-bits';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useCheckGroupWatch, useDeleteGroupWatch, useUpdateGroupWatch } from '@/hooks/mutations';
import { useFormat } from '@/hooks/use-format';
import type { GroupWatch } from '@/shared/domain';

export function WatchRow({ watch }: { readonly watch: GroupWatch }) {
  const id = useId();
  const format = useFormat();
  const update = useUpdateGroupWatch();
  const remove = useDeleteGroupWatch();
  const check = useCheckGroupWatch();
  const hasNew = watch.newMatchCount > 0;

  let checkStatus = '';
  if (check.isSuccess) {
    checkStatus =
      check.data.matches.length > 0
        ? `${format.plural(check.data.matches.length, 'new match', 'new matches')} sent to your webhooks`
        : check.data.newPosts > 0
          ? `${format.plural(check.data.newPosts, 'new post', 'new posts')}, none matching`
          : 'Nothing new';
  }

  return (
    <li>
      <Item variant="outline">
        <ItemContent className="min-w-56">
          <ItemTitle>
            <Link to="/groups/$groupId" params={{ groupId: watch.groupId }} className="truncate hover:underline">
              {watch.groupName}
            </Link>
            {hasNew && <span className="shrink-0 font-normal text-primary">{watch.newMatchCount} new</span>}
          </ItemTitle>
          <ItemDescription>
            {describeWatch(watch)} · {describeInterval(watch.intervalMinutes)}
          </ItemDescription>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {!watch.seeded ? (
              'Getting started: recording what’s already posted'
            ) : watch.lastCheckedAt === null ? (
              'Not checked yet'
            ) : (
              <>
                Checked <RelativeTime ms={watch.lastCheckedAt} />
              </>
            )}
            {checkStatus !== '' && ` · ${checkStatus}`}
          </p>
          {watch.lastError !== null && <p className="text-xs text-destructive">Last check: {watch.lastError}</p>}
        </ItemContent>
        <ItemActions className="flex-wrap">
          <Link
            to="/groups/$groupId"
            params={{ groupId: watch.groupId }}
            search={{ tab: 'matches' }}
            className={buttonVariants({ variant: hasNew ? 'default' : 'outline', size: 'sm' })}
          >
            {hasNew ? `View ${String(watch.newMatchCount)} new` : 'Matches'}
          </Link>
          <Button
            variant="ghost"
            size="sm"
            isPending={check.isPending}
            onPress={() => {
              check.mutate(watch.id);
            }}
          >
            Check now
          </Button>
          <div className="flex items-center gap-2 px-2">
            <Switch
              id={`${id}-on`}
              size="sm"
              isSelected={watch.enabled}
              onChange={(enabled) => {
                update.mutate({ id: watch.id, patch: { enabled } });
              }}
            />
            <Label htmlFor={`${id}-on`}>On</Label>
          </div>
          <WatchDialog group={{ id: watch.groupId, name: watch.groupName }} watch={watch} variant="ghost">
            <Pencil aria-hidden="true" />
            <span className="sr-only">Edit watch on {watch.groupName}</span>
          </WatchDialog>
          <AlertDialogTrigger>
            <Button variant="ghost" size="icon-sm" aria-label={`Stop watching ${watch.groupName}`}>
              <Trash2 aria-hidden="true" />
            </Button>
            <AlertDialog size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Stop watching “{watch.groupName}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  faceslop stops checking it, and the matches it found are deleted. You stay in the group on Facebook.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep</AlertDialogCancel>
                <Button
                  variant="destructive"
                  slot="close"
                  onPress={() => {
                    remove.mutate(watch.id);
                  }}
                >
                  Stop watching
                </Button>
              </AlertDialogFooter>
            </AlertDialog>
          </AlertDialogTrigger>
        </ItemActions>
        {(update.isError || remove.isError || check.isError) && (
          <div className="basis-full">
            <InlineError error={update.error ?? remove.error ?? check.error} />
          </div>
        )}
      </Item>
    </li>
  );
}
