import { useEffect, useState } from 'react';

/** `value`, but only after it has stopped changing for `delayMs` (e.g. a typeahead query). */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      window.clearTimeout(id);
    };
  }, [value, delayMs]);
  return debounced;
}
