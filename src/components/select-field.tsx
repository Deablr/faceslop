import { useId } from 'react';
import { Field, FieldDescription, FieldTitle } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export interface SelectOption {
  readonly id: string;
  readonly label: string;
}

interface SelectFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (id: string) => void;
  readonly options: readonly SelectOption[];
  readonly description?: string;
  readonly isDisabled?: boolean;
}

/** A labelled single-choice Select (React Aria) whose options are plain strings. */
export function SelectField({ label, value, onChange, options, description, isDisabled = false }: SelectFieldProps) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <Field data-disabled={isDisabled}>
      <FieldTitle id={labelId}>{label}</FieldTitle>
      <Select
        aria-labelledby={labelId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        value={value}
        onChange={(key) => {
          if (key !== null) onChange(String(key));
        }}
        isDisabled={isDisabled}
        className="w-full"
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} id={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description !== undefined && <FieldDescription id={descriptionId}>{description}</FieldDescription>}
    </Field>
  );
}
