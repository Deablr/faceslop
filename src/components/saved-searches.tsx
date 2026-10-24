import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Pencil, Sparkles, Trash2, X } from 'lucide-react';
import { useId, useState, type ReactNode, type SubmitEvent } from 'react';
import { EmptyState } from '@/components/empty-state';
import { ErrorState, InlineError } from '@/components/error-state';
import { ListingGrid, ListingGridSkeleton } from '@/components/listing-card';
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
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useDeleteSavedSearch, useUpdateSavedSearch } from '@/hooks/mutations';
import { useFormat } from '@/hooks/use-format';
import { queryKeys, savedSearchRunQuery, savedSearchesQuery } from '@/lib/queries';
import { describeSearch } from '@/lib/search-params';
import type { SavedSearch } from '@/shared/domain';

interface ViewNewLinkProps {
  readonly savedSearchId: number;
  readonly className?: string;
  readonly children: ReactNode;
}

/** Opens a saved search's "what's new" view, always re-running it rather than showing an old run. */
export function ViewNewLink({ savedSearchId, className, children }: ViewNewLinkProps) {
  const queryClient = useQueryClient();
  return (
    <Link
      to="/saved"
      search={{ view: savedSearchId }}
      onClick={() => {
        void queryClient.resetQueries({ queryKey: queryKeys.savedSearchRun(savedSearchId) });
      }}
      className={className}
    >
      {children}
    </Link>
  );
}

/** "Bicycles · under $300" or "“desk” · within 40 mi". */
export function useSearchSummary(saved: SavedSearch, categoryName: string | null): string {
  const format = useFormat();
  const described = describeSearch(saved.params, format, categoryName);
  // The name is usually the query; don't say it twice.
  const query = saved.params.query === undefined || saved.params.query === saved.name ? '' : `“${saved.params.query}”`;
  const location = saved.params.location === undefined ? 'Near your Facebook location' : 'Near a chosen location';
  return [query, described].filter((part) => part !== '').join(' · ') || location;
}

export function SavedSearchRow({ saved, categoryName }: { readonly saved: SavedSearch; readonly categoryName: string | null }) {
  const id = useId();
  const [renaming, setRenaming] = useState(false);
  const update = useUpdateSavedSearch();
  const remove = useDeleteSavedSearch();
  const summary = useSearchSummary(saved, categoryName);
  const hasNew = saved.newCount > 0;

  const onRename = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const raw = new FormData(e.currentTarget).get('name');
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name !== '' && name !== saved.name) update.mutate({ id: saved.id, patch: { name } });
    setRenaming(false);
  };

  return (
    <li>
      <Item variant="outline">
        <ItemContent className="min-w-56">
          {renaming ? (
            <form onSubmit={onRename} className="flex items-center gap-2">
              <Label htmlFor={`${id}-name`} className="sr-only">
                Name
              </Label>
              <Input
                // The Rename button just went away: keep keyboard focus here instead of losing it.
                ref={(input) => {
                  input?.focus();
                }}
                id={`${id}-name`}
                name="name"
                defaultValue={saved.name}
                maxLength={100}
                className="max-w-xs"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setRenaming(false);
                }}
              />
              <Button type="submit" size="sm">
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onPress={() => {
                  setRenaming(false);
                }}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <ItemTitle>
              <span className="truncate">{saved.name}</span>
              {hasNew && <span className="shrink-0 font-normal text-primary">{saved.newCount} new</span>}
            </ItemTitle>
          )}
          <ItemDescription>{summary}</ItemDescription>
          <p className="text-xs text-muted-foreground">
            {saved.lastCheckedAt === null ? (
              'Not checked yet'
            ) : (
              <>
                Checked <RelativeTime ms={saved.lastCheckedAt} />
              </>
            )}
          </p>
        </ItemContent>
        <ItemActions className="flex-wrap">
          <ViewNewLink savedSearchId={saved.id} className={buttonVariants({ variant: hasNew ? 'default' : 'outline', size: 'sm' })}>
            {hasNew ? `View ${String(saved.newCount)} new` : 'Check for new'}
          </ViewNewLink>
          <Link to="/search" search={saved.params} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            Full search
          </Link>
          <div className="flex items-center gap-2 px-2">
            <Switch
              id={`${id}-auto`}
              size="sm"
              isSelected={saved.autoCheck}
              onChange={(autoCheck) => {
                update.mutate({ id: saved.id, patch: { autoCheck } });
              }}
            />
            <Label htmlFor={`${id}-auto`}>Auto-check</Label>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Rename ${saved.name}`}
            onPress={() => {
              setRenaming(true);
            }}
          >
            <Pencil aria-hidden="true" />
          </Button>
          <AlertDialogTrigger>
            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${saved.name}`}>
              <Trash2 aria-hidden="true" />
            </Button>
            <AlertDialog size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Delete “{saved.name}”?</AlertDialogTitle>
                <AlertDialogDescription>faceslop stops checking it. Your favorites stay.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep</AlertDialogCancel>
                <Button
                  variant="destructive"
                  slot="close"
                  onPress={() => {
                    remove.mutate(saved.id);
                  }}
                >
                  Delete
                </Button>
              </AlertDialogFooter>
            </AlertDialog>
          </AlertDialogTrigger>
        </ItemActions>
        {(update.isError || remove.isError) && (
          <div className="basis-full">
            <InlineError error={update.error ?? remove.error} />
          </div>
        )}
      </Item>
    </li>
  );
}

/** "View new": runs the saved search now and shows only what appeared since it was last viewed. */
export function SavedSearchRun({ id }: { readonly id: number }) {
  const queryClient = useQueryClient();
  const format = useFormat();
  const run = useQuery(savedSearchRunQuery(id, queryClient));
  const { data: list } = useQuery(savedSearchesQuery);
  const saved = run.data?.savedSearch ?? list?.find((s) => s.id === id);
  const headingId = useId();

  let status = '';
  if (run.isPending) status = 'Checking Facebook for new listings…';
  else if (run.isSuccess) {
    status =
      run.data.newListings.length > 0
        ? `${format.plural(run.data.newListings.length, 'listing', 'listings')} since you last looked`
        : 'Up to date';
  }

  return (
    <section aria-labelledby={headingId} className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="truncate text-lg font-semibold tracking-tight">
            {saved === undefined ? 'New listings' : `New in “${saved.name}”`}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground" aria-live="polite">
            {status}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saved !== undefined && (
            <Link to="/search" search={saved.params} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Full search
            </Link>
          )}
          <Link to="/saved" search={{}} aria-label="Close new listings" className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}>
            <X aria-hidden="true" />
          </Link>
        </div>
      </div>
      <div className="mt-6">
        {run.isPending ? (
          <ListingGridSkeleton count={5} />
        ) : run.isError ? (
          <ErrorState
            error={run.error}
            onRetry={() => {
              void run.refetch();
            }}
            retrying={run.isFetching}
          />
        ) : run.data.newListings.length > 0 ? (
          <ListingGrid listings={run.data.newListings} />
        ) : (
          <EmptyState icon={Sparkles} title="Nothing new since you last looked">
            faceslop will keep an eye on it{saved?.autoCheck === true ? ' in the background' : ''}.
          </EmptyState>
        )}
      </div>
    </section>
  );
}
