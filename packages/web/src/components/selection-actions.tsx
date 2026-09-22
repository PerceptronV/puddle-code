import { Copy, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';

export function SelectionActions({
  text,
  label,
  clear,
}: {
  text: string;
  label: string;
  clear(): void;
}) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      onPointerDown={(event) => event.preventDefault()}
      className="absolute right-2 top-2 z-20 flex gap-1 rounded-md bg-elevated p-1 shadow-lg"
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            clear();
          } catch {
            toast.error('Could not copy the selection. Try again.');
          }
        }}
      >
        <Copy /> Copy
      </Button>
      <Button variant="ghost" size="icon" aria-label="Clear selection" onClick={clear}>
        <X />
      </Button>
    </div>
  );
}
