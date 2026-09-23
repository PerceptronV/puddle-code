import { useState } from 'react';
import { ClipboardPaste, Copy, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';

export function SelectionActions({
  text,
  label,
  clear,
  paste,
}: {
  text: string;
  label: string;
  clear(): void;
  paste?(): Promise<void>;
}) {
  const [pasting, setPasting] = useState(false);
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
        disabled={!text || pasting}
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
      {paste && (
        <Button
          variant="ghost"
          size="sm"
          disabled={pasting}
          onClick={async () => {
            if (pasting) return;
            setPasting(true);
            try {
              await paste();
              clear();
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'Could not paste. Try again.');
            } finally {
              setPasting(false);
            }
          }}
        >
          <ClipboardPaste /> Paste
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Clear selection"
        disabled={pasting}
        onClick={clear}
      >
        <X />
      </Button>
    </div>
  );
}
