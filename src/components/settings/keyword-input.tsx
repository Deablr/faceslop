import { Plus, X } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { normalizeKeywords } from '@/shared/domain';

interface KeywordInputProps {
  readonly id: string;
  readonly values: readonly string[];
  readonly onChange: (values: readonly string[]) => void;
}

/** Free-text words: Enter or comma adds (case-insensitive, de-duplicated), each chip removes. */
export function KeywordInput({ id, values, onChange }: KeywordInputProps) {
  const [text, setText] = useState('');

  const add = () => {
    const words = text.split(',');
    setText('');
    const next = normalizeKeywords([...values, ...words]);
    if (next.length !== values.length) onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && text === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <InputGroup>
        <InputGroupInput
          id={id}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onBlur={add}
          enterKeyHint="done"
          placeholder="e.g. broken, parts only"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Add keyword" onPress={add} isDisabled={text.trim() === ''}>
            <Plus aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {values.length > 0 && (
        <ul aria-label="Excluded keywords" className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <li key={value} className="inline-flex h-7 items-center gap-0.5 rounded-md bg-secondary pr-0.5 pl-2.5 text-sm text-secondary-foreground">
              {value}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove “${value}”`}
                onPress={() => {
                  onChange(values.filter((v) => v !== value));
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
