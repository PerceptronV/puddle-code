import { useRef, useState } from 'react';
import { ImagePlus, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { pasteImage } from '../terminal/paste-image';
import { IMAGE_ACCEPT } from '../terminal/prepare-image';

export function ImagePasteButton({
  session,
  term,
  ready,
}: {
  session: string;
  term: string;
  ready: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const insert = async (file: File) => {
    if (!ready || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const { resized } = await pasteImage(file, session, term);
      if (resized) toast('Image resized for remote access');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not insert the image.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <input
        ref={input}
        className="hidden"
        type="file"
        accept={IMAGE_ACCEPT}
        aria-label="Choose image"
        disabled={!ready || busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = ''; // allow selecting the same image again
          if (file) void insert(file);
        }}
      />
      <Button
        variant="ghost"
        aria-label="Insert image"
        title="Insert image"
        aria-busy={busy}
        disabled={!ready || busy}
        onClick={() => input.current?.click()}
      >
        {busy ? <LoaderCircle className="animate-spin" /> : <ImagePlus />}
      </Button>
    </>
  );
}
