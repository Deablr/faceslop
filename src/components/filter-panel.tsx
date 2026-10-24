import { useQuery } from '@tanstack/react-query';
import { useId, useState, type SubmitEvent } from 'react';
import { LocationPicker } from '@/components/location-picker';
import { RadiusSelect } from '@/components/radius-select';
import { SelectField } from '@/components/select-field';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { categoriesQuery } from '@/lib/queries';
import { cn } from '@/lib/utils';
import {
  CONDITION_OPTIONS,
  DAYS_OPTIONS,
  DELIVERY_OPTIONS,
  SORT_OPTIONS,
  humanizeSlug,
  isNearbyBrowse,
  searchIdentity,
  toApiParams,
  validateSearchPageSearch,
  type SearchPageSearch,
} from '@/lib/search-params';
import type { Condition, DaysSinceListed, DeliveryMethod, SortBy } from '@/shared/domain';

/** A location id, with its name when we know it (the URL may carry only the id). */
interface DraftLocation {
  readonly id: string;
  readonly name: string | null;
}

interface Draft {
  readonly location: DraftLocation | null;
  readonly radiusKm: number | undefined;
  readonly category: string | undefined;
  readonly minPrice: string;
  readonly maxPrice: string;
  readonly sortBy: SortBy;
  readonly daysSinceListed: DaysSinceListed | undefined;
  readonly conditions: readonly Condition[];
  readonly delivery: DeliveryMethod;
  readonly exact: boolean;
}

function toDraft(search: SearchPageSearch): Draft {
  return {
    location: search.location === undefined ? null : { id: search.location, name: search.locationName ?? null },
    radiusKm: search.radiusKm,
    category: search.category,
    minPrice: search.minPrice === undefined ? '' : String(search.minPrice),
    maxPrice: search.maxPrice === undefined ? '' : String(search.maxPrice),
    sortBy: search.sortBy ?? 'best_match',
    daysSinceListed: search.daysSinceListed,
    conditions: search.conditions ?? [],
    delivery: search.delivery ?? 'all',
    exact: search.exact ?? false,
  };
}

/**
 * The name to show for the draft's location: its own, or (for the URL's location, when the URL had
 * only the id) the name the current results reported. Resolved at render time, so results arriving
 * never reset the draft.
 */
function locationNameOf(location: DraftLocation, search: SearchPageSearch, resolvedLocationName: string | null): string | null {
  return location.name ?? (location.id === search.location ? resolvedLocationName : null);
}

function fromDraft(draft: Draft, search: SearchPageSearch, resolvedLocationName: string | null): SearchPageSearch {
  return validateSearchPageSearch({
    query: search.query,
    category: draft.category,
    location: draft.location?.id,
    locationName: draft.location === null ? undefined : (locationNameOf(draft.location, search, resolvedLocationName) ?? undefined),
    radiusKm: draft.radiusKm,
    minPrice: draft.minPrice,
    maxPrice: draft.maxPrice,
    sortBy: draft.sortBy,
    daysSinceListed: draft.daysSinceListed,
    conditions: draft.conditions,
    delivery: draft.delivery,
    exact: draft.exact,
  });
}

const ALL_CATEGORIES = 'all';
const ANY_TIME = 'any';
const DAYS_BY_ID: Readonly<Record<string, DaysSinceListed>> = { '1': 1, '7': 7, '30': 30 };
const isSortBy = (id: string): id is SortBy => SORT_OPTIONS.some((o) => o.value === id);
const isDelivery = (id: string): id is DeliveryMethod => DELIVERY_OPTIONS.some((o) => o.value === id);

interface FilterPanelProps {
  /** The surface it sits on, so the sticky Apply bar matches it. */
  readonly surface: 'background' | 'popover';
  readonly search: SearchPageSearch;
  /** The location name reported by the current results, for when the URL only has an id. */
  readonly resolvedLocationName: string | null;
  readonly onApply: (next: SearchPageSearch) => void;
}

/**
 * Filters are a draft until "Apply": every search costs a Facebook page load, so one deliberate
 * apply beats a new search per click. Remount it (key) when the URL search changes, and only
 * then: results arriving must not throw away what the user is editing.
 */
export function FilterPanel({ surface, search, resolvedLocationName, onApply }: FilterPanelProps) {
  const id = useId();
  const [draft, setDraft] = useState(() => toDraft(search));
  const { data: categories = [] } = useQuery(categoriesQuery);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const next = fromDraft(draft, search, resolvedLocationName);
  const dirty = searchIdentity(toApiParams(next)) !== searchIdentity(toApiParams(search));
  const min = draft.minPrice.trim() === '' ? null : Number(draft.minPrice);
  const max = draft.maxPrice.trim() === '' ? null : Number(draft.maxPrice);
  const priceError = min !== null && max !== null && min > max ? 'The minimum is higher than the maximum.' : null;
  // Today's picks (no query, no category) ignore every filter but the location.
  const nearby = isNearbyBrowse({ ...(search.query === undefined ? {} : { query: search.query }), ...(draft.category === undefined ? {} : { category: draft.category }) });

  const categoryOptions = [
    { id: ALL_CATEGORIES, label: 'All categories' },
    ...(draft.category !== undefined && !categories.some((c) => c.slug === draft.category)
      ? [{ id: draft.category, label: humanizeSlug(draft.category) }]
      : []),
    ...categories.map((c) => ({ id: c.slug, label: c.name })),
  ];

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (priceError === null) onApply(next);
  };

  const reset = () => {
    setDraft((d) => ({ ...toDraft(search.query === undefined ? {} : { query: search.query }), location: d.location, category: d.category }));
  };

  const toggleCondition = (condition: Condition, on: boolean) => {
    set('conditions', on ? [...draft.conditions, condition] : draft.conditions.filter((c) => c !== condition));
  };

  return (
    <form onSubmit={onSubmit} aria-label="Search filters">
      <FieldGroup>
        <LocationPicker
          label="Location"
          value={
            draft.location === null
              ? null
              : { id: draft.location.id, name: locationNameOf(draft.location, search, resolvedLocationName) ?? 'Chosen location' }
          }
          onChange={(location) => {
            set('location', location);
          }}
        />
        <SelectField
          label="Category"
          value={draft.category ?? ALL_CATEGORIES}
          onChange={(slug) => {
            set('category', slug === ALL_CATEGORIES ? undefined : slug);
          }}
          options={categoryOptions}
        />
        {nearby && (
          <p className="text-sm text-muted-foreground">These filters don’t apply to Today’s picks. Pick a category or search to use them.</p>
        )}
        <RadiusSelect
          label="Distance"
          value={draft.radiusKm}
          onChange={(km) => {
            set('radiusKm', km);
          }}
          isDisabled={nearby}
        />
        <FieldSet disabled={nearby}>
          <FieldLegend variant="label">Price</FieldLegend>
          <div className="flex items-center gap-2">
            <Input
              aria-label="Minimum price"
              inputMode="numeric"
              placeholder="Min"
              value={draft.minPrice}
              onChange={(e) => {
                set('minPrice', e.target.value.replace(/[^\d]/g, ''));
              }}
              aria-invalid={priceError !== null}
              disabled={nearby}
            />
            <span className="text-muted-foreground" aria-hidden="true">
              –
            </span>
            <Input
              aria-label="Maximum price"
              inputMode="numeric"
              placeholder="Max"
              value={draft.maxPrice}
              onChange={(e) => {
                set('maxPrice', e.target.value.replace(/[^\d]/g, ''));
              }}
              aria-invalid={priceError !== null}
              disabled={nearby}
            />
          </div>
          <FieldError>{priceError}</FieldError>
        </FieldSet>
        <SelectField
          label="Sort by"
          value={draft.sortBy}
          onChange={(value) => {
            if (isSortBy(value)) set('sortBy', value);
          }}
          options={SORT_OPTIONS.map((o) => ({ id: o.value, label: o.label }))}
          isDisabled={nearby}
        />
        <SelectField
          label="Date listed"
          value={draft.daysSinceListed === undefined ? ANY_TIME : String(draft.daysSinceListed)}
          onChange={(value) => {
            set('daysSinceListed', DAYS_BY_ID[value]);
          }}
          options={[{ id: ANY_TIME, label: 'Any time' }, ...DAYS_OPTIONS.map((o) => ({ id: String(o.value), label: o.label }))]}
          isDisabled={nearby}
        />
        <FieldSet disabled={nearby}>
          <FieldLegend variant="label">Condition</FieldLegend>
          <div className="flex flex-col gap-3">
            {CONDITION_OPTIONS.map((option) => (
              <Field key={option.value} orientation="horizontal" data-disabled={nearby}>
                <Checkbox
                  id={`${id}-condition-${option.value}`}
                  isSelected={draft.conditions.includes(option.value)}
                  onChange={(on) => {
                    toggleCondition(option.value, on);
                  }}
                  isDisabled={nearby}
                />
                <FieldLabel htmlFor={`${id}-condition-${option.value}`}>{option.label}</FieldLabel>
              </Field>
            ))}
          </div>
        </FieldSet>
        <FieldSet disabled={nearby}>
          <FieldLegend variant="label" id={`${id}-delivery`}>
            Delivery
          </FieldLegend>
          <RadioGroup
            aria-labelledby={`${id}-delivery`}
            value={draft.delivery}
            onChange={(value) => {
              if (isDelivery(value)) set('delivery', value);
            }}
            isDisabled={nearby}
          >
            {DELIVERY_OPTIONS.map((option) => (
              <Field key={option.value} orientation="horizontal" data-disabled={nearby}>
                <RadioGroupItem id={`${id}-delivery-${option.value}`} value={option.value} />
                <FieldLabel htmlFor={`${id}-delivery-${option.value}`}>{option.label}</FieldLabel>
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
        {search.query !== undefined && (
          <Field orientation="horizontal" data-disabled={nearby}>
            <Checkbox
              id={`${id}-exact`}
              isSelected={draft.exact}
              onChange={(on) => {
                set('exact', on);
              }}
              isDisabled={nearby}
            />
            <FieldLabel htmlFor={`${id}-exact`}>Exact matches only</FieldLabel>
          </Field>
        )}
      </FieldGroup>
      {/* Stays in reach at the bottom of the scrolling sidebar / sheet. */}
      <div className={cn('sticky bottom-0 mt-6 flex items-center gap-2 border-t py-4', surface === 'popover' ? 'bg-popover' : 'bg-background')}>
        <Button type="submit" isDisabled={!dirty || priceError !== null} className="flex-1">
          Apply filters
        </Button>
        <Button variant="ghost" onPress={reset}>
          Reset
        </Button>
      </div>
    </form>
  );
}
