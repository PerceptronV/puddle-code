import {
  IMAGE_UPLOAD_POLICY,
  type ImageUploadRequest,
  type ImageUploadProgress,
  type PasteImageMime,
  type PasteImageRequest,
} from '@puddle/shared';

interface Upload {
  id: string;
  session: string;
  mime: PasteImageMime;
  size: number;
  received: number;
  parts: Buffer[];
  started: number;
  updated: number;
  abort?: AbortController;
}

export class ImageUploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One bounded, ephemeral upload per admitted browser connection; no partial host files. */
export class ImageUploads {
  private current: Upload | null = null;
  private readonly used = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly now = () => performance.now()) {
    this.timer = setInterval(() => this.expire(), 1000);
    this.timer.unref();
  }

  private expire(): void {
    const upload = this.current;
    if (
      upload &&
      (this.now() - upload.updated >= IMAGE_UPLOAD_POLICY.idleMs ||
        this.now() - upload.started >= IMAGE_UPLOAD_POLICY.lifetimeMs)
    )
      this.clear();
  }
  private clear(): void {
    const upload = this.current;
    this.current = null;
    upload?.abort?.abort();
    if (upload) upload.parts = [];
  }
  dispose(): void {
    clearInterval(this.timer);
    this.clear();
  }

  accept(
    session: string,
    request: ImageUploadRequest,
    abort: AbortController,
  ): { progress: ImageUploadProgress } | { paste: PasteImageRequest; release(): void } {
    this.expire();
    if (request.action === 'start') {
      if (this.current) throw new ImageUploadError(409, 'An image upload is already in progress.');
      if (this.used.has(request.upload) || this.used.size >= 1024)
        throw new ImageUploadError(
          409,
          'Upload identifier was already used or the connection upload limit was reached.',
        );
      this.used.add(request.upload);
      this.current = {
        id: request.upload,
        session,
        mime: request.mime,
        size: request.size,
        received: 0,
        parts: [],
        started: this.now(),
        updated: this.now(),
      };
      return { progress: { received: 0 } };
    }
    const upload = this.current;
    if (request.action === 'cancel') {
      if (upload?.id === request.upload && upload.session === session) this.clear();
      return { progress: { received: 0 } };
    }
    if (!upload || upload.id !== request.upload || upload.session !== session)
      throw new ImageUploadError(410, 'The image upload expired or is no longer available.');
    if (upload.abort) throw new ImageUploadError(409, 'The image is already being saved.');
    if (request.action === 'chunk') {
      const bytes = Buffer.from(request.data, 'base64');
      if (
        request.offset !== upload.received ||
        bytes.length === 0 ||
        bytes.length > IMAGE_UPLOAD_POLICY.chunkBytes ||
        bytes.toString('base64') !== request.data ||
        upload.received + bytes.length > upload.size
      ) {
        this.clear();
        throw new ImageUploadError(400, 'Invalid, repeated or out-of-order image chunk.');
      }
      upload.parts.push(bytes);
      upload.received += bytes.length;
      upload.updated = this.now();
      return { progress: { received: upload.received } };
    }
    if (upload.received !== upload.size) {
      this.clear();
      throw new ImageUploadError(400, 'The image upload is incomplete.');
    }
    upload.abort = abort;
    const data = Buffer.concat(upload.parts, upload.received).toString('base64');
    upload.parts = [];
    return {
      paste: { mime: upload.mime, data },
      release: () => {
        if (this.current === upload) this.clear();
      },
    };
  }
}
