// Create or edit a group watch: which new posts to report (keywords, exclusions) and how often to look.
import { useId, useState, type ReactNode } from 'react';
import { InlineError } from '@/components/error-state';
import { SelectField } from '@/components/select-field';
import { KeywordInput } from '@/components/settings/keyword-input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { useCreateGroupWatch, useUpdateGroupWatch } from '@/hooks/mutations';
import { DEFAULT_WATCH_INTERVAL_MINUTES, type GroupWatch } from '@/shared/domain';

const INTERVALS = [
  { id: '5', label: 'Every 5 minutes' },
  { id: '10', label: 'Every 10 minutes' },
  { id: '15', label: 'Every 15 minutes' },
  { id: '30', label: 'Every 30 minutes' },
  { id: '60', label: 'Every hour' },
  { id: '180', label: 'Every 3 hours' },
  { id: '720', label: 'Twice a day' },
  { id: '1440', label: 'Once a day' },
] as const;

/** Close enough to say in words: "every 15 min", "every hour". */
export function describeInterval(minutes: number): string {
  return INTERVALS.find((i) => i.id === String(minutes))?.label.toLowerCase() ?? `every ${String(minutes)} minutes`;
}

/** "Posts mentioning golden or doodle, but not iso" or "Every new post". */
export function describeWatch(watch: Pick<GroupWatch, 'keywords' | 'excludeKeywords'>): string {
  const quote = (words: readonly string[]) => words.map((w) => `“${w}”`).join(' or ');
  const base = watch.keywords.length === 0 ? 'Every new post' : `Posts mentioning ${quote(watch.keywords)}`;
  return watch.excludeKeywords.length === 0 ? base : `${base}, except ${quote(watch.excludeKeywords)}`;
}

interface WatchDialogProps {
  /** The group a new watch is for; ignored when editing. */
  readonly group: { readonly id: string; readonly name: string };
  /** Editing this watch (else creating one). */
  readonly watch?: GroupWatch;
  /** The trigger button's content. */
  readonly children: ReactNode;
  readonly variant?: 'default' | 'outline' | 'ghost';
}

export function WatchDialog({ group, watch, children, variant = 'outline' }: WatchDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button variant={variant} size="sm">
        {children}
      </Button>
      <Dialog>
        {/* Mounted only while open, so the form starts from the watch's current values each time. */}
        {open && (
          <WatchForm
            group={group}
            watch={watch}
            onDone={() => {
              setOpen(false);
            }}
          />
        )}
      </Dialog>
    </DialogTrigger>
  );
}

function WatchForm({ group, watch, onDone }: { readonly group: WatchDialogProps['group']; readonly watch: GroupWatch | undefined; readonly onDone: () => void }) {
  const id = useId();
  const [keywords, setKeywords] = useState<readonly string[]>(watch?.keywords ?? []);
  const [excluded, setExcluded] = useState<readonly string[]>(watch?.excludeKeywords ?? []);
  const [intervalMinutes, setIntervalMinutes] = useState(String(watch?.intervalMinutes ?? DEFAULT_WATCH_INTERVAL_MINUTES));
  const create = useCreateGroupWatch();
  const update = useUpdateGroupWatch();
  const saving = create.isPending || update.isPending;
  const name = watch?.groupName ?? group.name;

  const save = () => {
    const fields = { keywords: [...keywords], excludeKeywords: [...excluded], intervalMinutes: Number(intervalMinutes) };
    if (watch === undefined) create.mutate({ groupId: group.id, groupName: group.name, ...fields }, { onSuccess: onDone });
    else update.mutate({ id: watch.id, patch: fields }, { onSuccess: onDone });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{watch === undefined ? `Watch ${name}` : `Edit watch on ${name}`}</DialogTitle>
        <DialogDescription>
          faceslop checks the group’s newest posts as you and sends the ones that match to your webhooks. Posts already
          there when you start watching don’t count.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-5">
        <Field>
          <FieldLabel htmlFor={`${id}-keywords`}>Keywords</FieldLabel>
          <KeywordInput
            id={`${id}-keywords`}
            values={keywords}
            onChange={setKeywords}
            listLabel="Keywords"
            placeholder="e.g. golden, doodle, corgi"
          />
          <FieldDescription>
            A post matches when a word in it starts with any of these (“golden” matches “Goldendoodle”). Leave empty to
            get every new post. Photo-only posts have no text, so only a watch without keywords gets them.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-excluded`}>Skip posts with</FieldLabel>
          <KeywordInput
            id={`${id}-excluded`}
            values={excluded}
            onChange={setExcluded}
            listLabel="Skipped keywords"
            placeholder="e.g. iso, looking for, rehome fee"
          />
        </Field>
        <SelectField
          label="Check"
          value={intervalMinutes}
          onChange={setIntervalMinutes}
          options={INTERVALS}
          description="Each check reads the group as your Facebook account. Checking very often makes Facebook more likely to ask you to verify it’s you."
        />
        <InlineError error={create.error ?? update.error} />
      </div>
      <DialogFooter>
        <Button variant="outline" slot="close" isDisabled={saving}>
          Cancel
        </Button>
        <Button isPending={saving} onPress={save}>
          {watch === undefined ? 'Start watching' : 'Save'}
        </Button>
      </DialogFooter>
    </>
  );
}
