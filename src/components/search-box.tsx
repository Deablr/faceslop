import { useQuery } from '@tanstack/react-query';
import { useMatch, useNavigate } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useId, type SubmitEvent } from 'react';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { settingsQuery } from '@/lib/queries';
import { withSearchDefaults, type SearchPageSearch } from '@/lib/search-params';

interface SearchBoxProps {
  readonly size: 'lg' | 'sm';
}

/**
 * On the results page a new query keeps the current filters; anywhere else it starts a fresh
 * search from the default location in Settings (the server never fills that in).
 */
export function SearchBox({ size }: SearchBoxProps) {
  const id = useId();
  const navigate = useNavigate();
  const { data: settings } = useQuery(settingsQuery);
  const current = useMatch({ from: '/_app/search', shouldThrow: false, select: (match) => match.search });

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const raw = new FormData(e.currentTarget).get('q');
    const query = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
    let search: SearchPageSearch;
    if (current === undefined) {
      search = withSearchDefaults(query === undefined ? {} : { query }, settings);
    } else {
      const { query: _previous, exact, ...rest } = current;
      search = query === undefined ? rest : { ...rest, query, ...(exact === undefined ? {} : { exact }) };
    }
    void navigate({ to: '/search', search });
  };

  const large = size === 'lg';
  return (
    <form role="search" onSubmit={onSubmit} className="w-full">
      <Label htmlFor={id} className="sr-only">
        Search Marketplace
      </Label>
      <InputGroup className={large ? 'h-12' : 'h-9'}>
        <InputGroupAddon>
          <Search aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          // Re-sync with the URL when the query changes elsewhere (back button, a saved search).
          key={current?.query ?? ''}
          id={id}
          name="q"
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          defaultValue={current?.query ?? ''}
          placeholder={large ? 'A bike, a couch, a camera…' : 'Search Marketplace'}
        />
        {large && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton type="submit" variant="default" size="sm">
              Search
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
    </form>
  );
}
