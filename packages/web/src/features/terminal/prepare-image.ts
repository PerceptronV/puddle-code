import { REMOTE_POLICY, pasteImageMimeSchema, type PasteImageMime } from '@puddle/shared';

export const IMAGE_ACCEPT = pasteImageMimeSchema.options.join(',');
// Reserve room for the JSON body and encrypted request envelope, including its ids.
const REMOTE_IMAGE_BYTES = Math.floor(((REMOTE_POLICY.requestBytes - 1024) * 3) / 4);
// Matches the existing daemon image-paste cap; reject before reading/decoding the file.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export async function prepareImage(
  file: File,
  remote: boolean,
): Promise<{ blob: Blob; mime: PasteImageMime; resized: boolean }> {
  const mime = pasteImageMimeSchema.safeParse(file.type);
  if (!mime.success) throw new Error('Choose a PNG, JPEG, GIF or WebP image.');
  if (file.size === 0) throw new Error('This image is empty.');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Choose an image smaller than 20 MiB.');
  if (!remote || file.size <= REMOTE_IMAGE_BYTES)
    return { blob: file, mime: mime.data, resized: false };
  // Preserve animation rather than silently turning a GIF into its first frame.
  if (mime.data === 'image/gif')
    throw new Error(
      `Choose a GIF smaller than ${Math.floor(REMOTE_IMAGE_BYTES / 1024)} KiB for remote access.`,
    );

  // Decode the File directly: the remote app intentionally disallows blob: image URLs.
  const image = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare this image.');
    const type = mime.data === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    let scale = Math.min(1, 2048 / Math.max(image.width, image.height));
    for (let attempt = 0; attempt < 8; attempt++) {
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.85, 0.7, 0.55]) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, type, quality),
        );
        if (blob && blob.size <= REMOTE_IMAGE_BYTES)
          return { blob, mime: pasteImageMimeSchema.parse(blob.type), resized: true };
      }
      scale *= 0.75;
    }
    throw new Error('This image is too large to attach remotely. Choose a smaller image.');
  } finally {
    image.close();
  }
}
