import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_UPLOAD_POLICY, imageUploadRequestSchema, type RemoteMessage } from '@puddle/shared';
import { ImageUploads } from '../src/image-uploads.js';
import { RemoteUpstream } from '../src/upstream.js';
import { permittedRequest } from '../src/policy.js';

const session = crypto.randomUUID();
const managers: ImageUploads[] = [];
const upstreams: RemoteUpstream[] = [];
afterEach(() => {
  managers.splice(0).forEach((manager) => manager.dispose());
  upstreams.splice(0).forEach((upstream) => upstream.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  let now = 0;
  const manager = new ImageUploads(() => now);
  managers.push(manager);
  const upload = crypto.randomUUID();
  const send = (body: object, target = session) =>
    manager.accept(
      target,
      imageUploadRequestSchema.parse({ upload, ...body }),
      new AbortController(),
    );
  return {
    manager,
    upload,
    send,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('connection-owned image staging', () => {
  it('preserves all 4 MiB, including GIF bytes, and permits only one active upload', () => {
    const f = fixture();
    const bytes = Buffer.alloc(IMAGE_UPLOAD_POLICY.imageBytes, 0xa5);
    f.send({ action: 'start', mime: 'image/gif', size: bytes.length });
    expect(() =>
      f.send({ action: 'start', mime: 'image/png', size: 1, upload: crypto.randomUUID() }),
    ).toThrow('already in progress');
    for (let offset = 0; offset < bytes.length; offset += IMAGE_UPLOAD_POLICY.chunkBytes) {
      const data = bytes.subarray(offset, offset + IMAGE_UPLOAD_POLICY.chunkBytes);
      expect(f.send({ action: 'chunk', offset, data: data.toString('base64') })).toEqual({
        progress: { received: offset + data.length },
      });
    }
    const completed = f.send({ action: 'finish' });
    if (!('paste' in completed)) throw new Error('Expected a completed image');
    expect(completed.paste.mime).toBe('image/gif');
    expect(Buffer.from(completed.paste.data, 'base64').equals(bytes)).toBe(true);
    expect(() => f.send({ action: 'finish' })).toThrow('already being saved');
    completed.release();
    expect(() => f.send({ action: 'finish' })).toThrow('no longer available');
    expect(() => f.send({ action: 'start', mime: 'image/png', size: 1 })).toThrow('already used');
  });

  it.each([
    { action: 'chunk', offset: 1, data: 'YQ==' },
    { action: 'chunk', offset: 0, data: 'YWI=' },
    { action: 'chunk', offset: 0, data: 'YR==' },
    { action: 'finish' },
  ])('discards invalid or incomplete uploads: %j', (body) => {
    const f = fixture();
    f.send({ action: 'start', mime: 'image/png', size: 1 });
    expect(() => f.send(body)).toThrow();
    expect(() => f.send({ action: 'finish' })).toThrow('no longer available');
  });

  it('rejects chunk replay, cross-placement access, and cross-connection access', () => {
    const f = fixture();
    f.send({ action: 'start', mime: 'image/png', size: 2 });
    const chunk = { action: 'chunk', offset: 0, data: 'YQ==' };
    expect(() => f.send(chunk, crypto.randomUUID())).toThrow('no longer available');
    expect(() => fixture().send({ ...chunk, upload: f.upload })).toThrow('no longer available');
    f.send(chunk);
    expect(() => f.send(chunk)).toThrow('repeated or out-of-order');
  });

  it('discards cancellations and expires stalled uploads even after timer suspension', () => {
    for (const stop of ['cancel', 'expire', 'dispose']) {
      const f = fixture();
      f.send({ action: 'start', mime: 'image/png', size: 1 });
      if (stop === 'cancel') f.send({ action: 'cancel' });
      else if (stop === 'expire') f.advance(IMAGE_UPLOAD_POLICY.idleMs);
      else f.manager.dispose();
      expect(() => f.send({ action: 'chunk', offset: 0, data: 'YQ==' })).toThrow(
        'no longer available',
      );
    }
  });

  it('enforces the total lifetime even while chunks keep arriving', () => {
    const f = fixture();
    f.send({ action: 'start', mime: 'image/png', size: 10 });
    for (let offset = 0; offset < 5; offset++) {
      f.advance(50_000);
      f.send({ action: 'chunk', offset, data: 'YQ==' });
    }
    f.advance(50_000);
    expect(() => f.send({ action: 'chunk', offset: 5, data: 'YQ==' })).toThrow(
      'no longer available',
    );
  });

  it('aborts a final save on cancellation without clearing a subsequent upload', () => {
    const f = fixture();
    f.send({ action: 'start', mime: 'image/png', size: 1 });
    f.send({ action: 'chunk', offset: 0, data: 'YQ==' });
    const abort = new AbortController();
    const result = f.manager.accept(session, { action: 'finish', upload: f.upload }, abort);
    f.send({ action: 'cancel' });
    expect(abort.signal.aborted).toBe(true);
    const upload = crypto.randomUUID();
    f.send({ action: 'start', mime: 'image/png', size: 1, upload });
    if (!('paste' in result)) throw new Error('Expected a completed image');
    result.release();
    expect(f.send({ action: 'chunk', offset: 0, data: 'YQ==', upload })).toEqual({
      progress: { received: 1 },
    });
  });
});

describe('image upload policy and upstream authority', () => {
  const path = `/api/worktrees/${session}/paste-upload`;
  it('keeps ordinary request limits and rejects neighbouring operations and destinations', () => {
    const upload = crypto.randomUUID();
    const start = {
      action: 'start',
      upload,
      mime: 'image/png',
      size: IMAGE_UPLOAD_POLICY.imageBytes,
    };
    const request = (body: unknown, url = path) =>
      permittedRequest({ t: 'request', id: crypto.randomUUID(), method: 'POST', path: url, body });
    expect(request(start).upload).toEqual(start);
    for (const body of [
      { ...start, size: IMAGE_UPLOAD_POLICY.imageBytes + 1 },
      { ...start, mime: 'image/svg+xml' },
      { ...start, root: '/tmp' },
      { ...start, path: '../escape' },
      { ...start, token: 'substitute' },
      {
        action: 'chunk',
        upload,
        offset: 0,
        data: Buffer.alloc(IMAGE_UPLOAD_POLICY.chunkBytes + 1).toString('base64'),
      },
    ])
      expect(() => request(body)).toThrow();
    for (const url of [
      path + '?root=/tmp',
      path + '?path=image.png',
      path + '/chunk',
      path.replace(session, '00000000-0000-0000-0000-000000000000'),
      path.replace('paste-upload', 'upload'),
    ])
      expect(() => request(start, url)).toThrow();
    expect(() =>
      request(
        { mime: 'image/png', data: 'a'.repeat(256 * 1024) },
        path.replace('paste-upload', 'paste'),
      ),
    ).toThrow('too large');
  });

  it('stages without daemon writes, then uses the existing authenticated paste route exactly once', async () => {
    const responses: RemoteMessage[] = [];
    let valid = true;
    const upstream = new RemoteUpstream(
      '/tmp/unused-image-test',
      {
        send: async (message) => {
          responses.push(message);
        },
      },
      () => valid,
      vi.fn(),
    );
    upstreams.push(upstream);
    vi.spyOn(upstream.authority, 'credential').mockReturnValue('host-owned-test-credential');
    vi.spyOn(upstream.authority, 'resource').mockImplementation(() => ({
      id: 'resource',
      release: vi.fn(),
      valid: () => valid,
    }));
    const fetcher = vi.fn().mockResolvedValue(Response.json({ path: '.puddle/pastes/image.png' }));
    vi.stubGlobal('fetch', fetcher);
    const upload = crypto.randomUUID();
    const send = (body: object) =>
      upstream.request({
        t: 'request',
        id: crypto.randomUUID(),
        method: 'POST',
        path,
        body: { upload, ...body },
      });
    await send({ action: 'start', mime: 'image/png', size: 1 });
    await send({ action: 'chunk', offset: 0, data: 'YQ==' });
    expect(fetcher).not.toHaveBeenCalled();
    await send({ action: 'finish' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `http://127.0.0.1:0/api/worktrees/${session}/paste`,
      expect.objectContaining({
        body: JSON.stringify({ mime: 'image/png', data: 'YQ==' }),
        headers: expect.objectContaining({
          authorization: 'Bearer host-owned-test-credential',
          'x-puddle-resource': 'resource',
        }),
      }),
    );
    await send({ action: 'finish' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(responses.at(-1)).toMatchObject({ status: 410 });
    const next = crypto.randomUUID();
    await send({ action: 'start', upload: next, mime: 'image/png', size: 1 });
    await send({ action: 'chunk', upload: next, offset: 0, data: 'YQ==' });
    vi.spyOn(upstream.authority, 'resource').mockReturnValue({
      id: 'expired-resource',
      release: vi.fn(),
      valid: () => false,
    });
    await send({ action: 'finish', upload: next });
    expect(fetcher).toHaveBeenCalledTimes(1);
    valid = false;
    await expect(
      send({ action: 'start', upload: crypto.randomUUID(), mime: 'image/png', size: 1 }),
    ).rejects.toThrow('capacity');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('advertises the capability only on a successful encrypted version response', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const upstream = new RemoteUpstream('/tmp/unused-image-test', { send }, () => true, vi.fn());
    upstreams.push(upstream);
    vi.spyOn(upstream.authority, 'credential').mockReturnValue('test-credential');
    vi.spyOn(upstream.authority, 'resource').mockReturnValue({
      id: 'resource',
      release: vi.fn(),
      valid: () => true,
    });
    const version = { version: 'test', protocol: { major: 21, minor: 1 } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(version)));
    await upstream.request({
      t: 'request',
      id: crypto.randomUUID(),
      method: 'GET',
      path: '/api/version',
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200, body: { ...version, remote_image_uploads: true } }),
    );
  });
});
