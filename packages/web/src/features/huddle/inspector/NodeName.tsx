import { useId, useState } from 'react';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { nestedIsland } from '../controls/HuddlePanel';
import { graphActionClass } from './GraphEditing';

export function NodeName({
  value,
  fallback,
  disabled,
  rename,
}: {
  value: string;
  fallback: string;
  disabled: boolean;
  rename(value: string): void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <form
      className={`${nestedIsland} flex flex-col gap-2`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) {
          rename(draft ?? value);
          setDraft(null);
        }
      }}
    >
      <Label htmlFor={id}>Node name</Label>
      <Input
        id={id}
        value={draft ?? value}
        placeholder={fallback}
        maxLength={200}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="submit" className={graphActionClass} disabled={disabled || draft === null}>
        Rename node
      </button>
      {disabled && (
        <p className="text-xs text-fg-muted">Renaming requires a host supporting node labels.</p>
      )}
    </form>
  );
}
