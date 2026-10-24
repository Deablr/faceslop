import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bookmark, BookmarkCheck } from 'lucide-react';
import { useId, useState, type SubmitEvent } from 'react';
import { InlineError } from '@/components/error-state';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Popover, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { useCreateSavedSearch } from '@/hooks/mutations';
import { savedSearchesQuery } from '@/lib/queries';
import { searchIdentity } from '@/lib/search-params';
import type { SearchParams } from '@/shared/domain';

interface SaveSearchButtonProps {
  readonly params: SearchParams;
  readonly defaultName: string;
}

/** "Save search" popover; once saved, a quiet link to the saved searches instead. */
export function SaveSearchButton({ params, defaultName }: SaveSearchButtonProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [autoCheck, setAutoCheck] = useState(true);
  const create = useCreateSavedSearch();
  const identity = searchIdentity(params);
  const { data: alreadySaved = false } = useQuery({
    ...savedSearchesQuery,
    select: (list) => list.some((s) => searchIdentity(s.params) === identity),
  });

  if (alreadySaved) {
    return (
      <Link to="/saved" className={buttonVariants({ variant: 'outline' })}>
        <BookmarkCheck aria-hidden="true" />
        Saved search
      </Link>
    );
  }

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const raw = new FormData(e.currentTarget).get('name');
    const name = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : defaultName;
    create.mutate(
      { name, params, autoCheck },
      {
        onSuccess: () => {
          setOpen(false);
        },
      },
    );
  };

  return (
    <PopoverTrigger isOpen={open} onOpenChange={setOpen}>
      <Button variant="outline">
        <Bookmark aria-hidden="true" />
        Save search
      </Button>
      <Popover placement="bottom end" className="w-80">
        <PopoverHeader>
          <PopoverTitle slot="title">Save this search</PopoverTitle>
          <PopoverDescription>Come back to it later, and see only what’s new.</PopoverDescription>
        </PopoverHeader>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input id={`${id}-name`} name="name" defaultValue={defaultName} maxLength={100} />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor={`${id}-auto`} className="flex-1">
                Check for new listings in the background
              </FieldLabel>
              <Switch id={`${id}-auto`} isSelected={autoCheck} onChange={setAutoCheck} aria-label="Check in the background" />
            </Field>
            <FieldDescription>Background checks run quietly, one search at a time.</FieldDescription>
            <InlineError error={create.error} />
            <Field orientation="horizontal" className="justify-end">
              <Button
                variant="ghost"
                size="sm"
                onPress={() => {
                  setOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" isPending={create.isPending}>
                Save
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </Popover>
    </PopoverTrigger>
  );
}
