import { SelectField } from '@/components/select-field';
import { useFormat } from '@/hooks/use-format';

interface RadiusSelectProps {
  readonly label: string;
  /** Kilometres; null/undefined means Facebook's default. */
  readonly value: number | null | undefined;
  readonly onChange: (km: number | undefined) => void;
  readonly defaultLabel?: string;
  readonly isDisabled?: boolean;
}

const DEFAULT_ID = 'default';

/** Distance choices in the user's unit (miles where people expect them). */
export function RadiusSelect({ label, value, onChange, defaultLabel = 'Facebook default', isDisabled }: RadiusSelectProps) {
  const format = useFormat();
  const options = [
    { id: DEFAULT_ID, label: defaultLabel },
    ...format.radiusOptions(value).map((o) => ({ id: String(o.value), label: `Within ${o.label}` })),
  ];
  return (
    <SelectField
      label={label}
      value={value === null || value === undefined ? DEFAULT_ID : String(value)}
      onChange={(id) => {
        onChange(id === DEFAULT_ID ? undefined : Number(id));
      }}
      options={options}
      isDisabled={isDisabled}
    />
  );
}
