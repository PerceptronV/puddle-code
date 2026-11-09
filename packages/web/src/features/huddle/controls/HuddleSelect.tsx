import type { ReactNode } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';

/** Schema-driven choices use the same dropdown surface as the rest of Puddle. */
export function HuddleSelect({
  id,
  label,
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
}: {
  id?: string;
  label?: string;
  value: string;
  onValueChange(value: string): void;
  options: readonly { value: string; label: ReactNode; disabled?: boolean }[];
  placeholder?: string;
  disabled?: boolean;
}) {
  // Prefix values so a legitimate empty-string enum value is supported by Radix.
  const selected = options.some((option) => option.value === value) ? `value:${value}` : '';
  return (
    <Select
      value={selected}
      onValueChange={(next) => onValueChange(next.slice(6))}
      disabled={disabled}
    >
      <SelectTrigger data-value={value} id={id} aria-label={label} className="min-w-0">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            data-value={option.value}
            key={option.value}
            value={`value:${option.value}`}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
