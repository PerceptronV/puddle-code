import { useRef } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../../../components/ui/context-menu';
import { toastError } from '../../../lib/transport/errors';

/** Copy pixels at their original size; PNG is the portable clipboard image format. */
async function copyImage(image: HTMLImageElement, blob: Blob): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
    return Promise.reject(new Error('Image copying is unavailable in this browser.'));
  if (!image.complete || !image.naturalWidth)
    return Promise.reject(new Error('Wait for the image to finish loading.'));
  const png =
    blob.type === 'image/png'
      ? Promise.resolve(blob)
      : new Promise<Blob>((resolve, reject) => {
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Could not copy this image.');
          context.drawImage(image, 0, 0);
          canvas.toBlob((result) => {
            if (result) resolve(result);
            else reject(new Error('Could not copy this image.'));
          }, 'image/png');
        });
  // Start the clipboard write in the menu gesture, before asynchronous PNG encoding.
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

export function ImagePreview({ url, blob, path }: { url: string; blob: Blob; path: string }) {
  const image = useRef<HTMLImageElement>(null);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <img ref={image} src={url} alt={path} className="max-h-full max-w-full object-contain" />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            if (image.current) void copyImage(image.current, blob).catch(toastError);
          }}
        >
          Copy image
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
