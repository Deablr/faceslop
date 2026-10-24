import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { LocateFixed } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { Field } from '@/components/ui/field';
import { InputGroupAddon } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { locationsQuery } from '@/lib/queries';
import type { LocationOption } from '@/shared/domain';
import { toClientError } from '@/shared/errors';

export interface ChosenLocation {
  readonly id: string;
  readonly name: string;
}

interface LocationPickerProps {
  readonly label: string;
  readonly value: ChosenLocation | null;
  readonly onChange: (value: ChosenLocation | null) => void;
  /** What "no location" means here, e.g. "Your Facebook location". */
  readonly emptyLabel?: string;
  readonly isDisabled?: boolean;
}

const MIN_QUERY = 2;

/**
 * City / neighborhood typeahead (Facebook's own location search, debounced). Typing never changes
 * the value; picking a suggestion does. "Use my Facebook location" clears it.
 */
export function LocationPicker({
  label,
  value,
  onChange,
  emptyLabel = 'Your Facebook location',
  isDisabled = false,
}: LocationPickerProps) {
  const [text, setText] = useState(value?.name ?? '');
  // Follow the value's name when it changes from outside (e.g. the name of the URL's location
  // arriving with the results), unless the user has typed something of their own.
  const [shownName, setShownName] = useState(value?.name);
  if (shownName !== value?.name) {
    setShownName(value?.name);
    if (text === (shownName ?? '')) setText(value?.name ?? '');
  }
  const typed = text.trim();
  const debounced = useDebouncedValue(typed, 300);
  // Showing the chosen place's name is not a search.
  const q = debounced === value?.name ? '' : debounced;
  const locations = useQuery({ ...locationsQuery(q), placeholderData: keepPreviousData });
  const options: readonly LocationOption[] = q.length >= MIN_QUERY ? (locations.data ?? []) : [];

  let status: string;
  if (typed.length < MIN_QUERY) status = 'Type a city or neighborhood.';
  else if (locations.isError) status = toClientError(locations.error).message;
  else if (locations.isFetching || q !== typed) status = 'Searching…';
  else status = 'No places found.';

  return (
    <Field data-disabled={isDisabled}>
      <Combobox
        allowsEmptyCollection
        items={options}
        inputValue={text}
        onInputChange={setText}
        value={value?.id ?? null}
        onChange={(key) => {
          const option = options.find((o) => o.id === key);
          if (option === undefined) return;
          onChange({ id: option.id, name: option.name });
          setText(option.name);
        }}
        // Leaving without picking a suggestion keeps the old value, so show its name again
        // (otherwise the box would read "Bould" while the search still uses Denver).
        onBlur={() => {
          setText(value?.name ?? '');
        }}
        isDisabled={isDisabled}
        className="w-full"
      >
        <Label className="mb-3">{label}</Label>
        <ComboboxInput placeholder={emptyLabel} className="w-full" disabled={isDisabled}>
          {locations.isFetching && (
            <InputGroupAddon align="inline-end">
              <Spinner aria-label="Searching places" />
            </InputGroupAddon>
          )}
        </ComboboxInput>
        <ComboboxContent>
          <ComboboxList<LocationOption> renderEmptyState={() => <ComboboxEmpty>{status}</ComboboxEmpty>}>
            {(option) => (
              <ComboboxItem id={option.id} textValue={option.name}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{option.name}</span>
                  {option.subtitle !== null && (
                    <span className="truncate text-xs text-muted-foreground">{option.subtitle}</span>
                  )}
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {value !== null && (
        <Button
          variant="link"
          size="sm"
          className="self-start"
          isDisabled={isDisabled}
          onPress={() => {
            onChange(null);
            setText('');
          }}
        >
          <LocateFixed aria-hidden="true" />
          Use my Facebook location
        </Button>
      )}
    </Field>
  );
}
