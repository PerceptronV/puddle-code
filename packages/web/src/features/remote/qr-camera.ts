/** Decode bounded camera frames locally; iOS does not require BarcodeDetector support. */
export function scanQrCamera(
  video: HTMLVideoElement,
  found: (value: string) => void,
  failed: (message: string) => void,
): () => void {
  let stopped = false;
  let stream: MediaStream | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(starting);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', hidden);
    stream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  };
  const fail = (message: string) => {
    if (stopped) return;
    stop();
    failed(message);
  };
  const hidden = () => fail('Camera stopped. Scan again when you return to Puddle.');
  const visibility = () => {
    if (document.hidden) hidden();
  };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', hidden);
  const starting = setTimeout(
    () => fail('The camera did not start. Check camera permission or paste a pairing link.'),
    20_000,
  );
  void (async () => {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error(
        'Camera access is unavailable. Open Puddle over HTTPS or paste a pairing link.',
      );
    const media = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    if (stopped) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = media;
    video.srcObject = stream;
    const [, { default: decode }] = await Promise.all([video.play(), import('jsqr')]);
    if (stopped) return;
    clearTimeout(starting);
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener(
        'ended',
        () => fail('Camera stopped. Scan again or paste a pairing link.'),
        { once: true },
      );
    });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not read the camera. Paste a pairing link instead.');
    const scan = () => {
      if (stopped) return;
      try {
        if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
          const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const frame = context.getImageData(0, 0, canvas.width, canvas.height);
          const code = decode(frame.data, frame.width, frame.height, {
            inversionAttempts: 'dontInvert',
          });
          if (code?.data) {
            stop();
            found(code.data);
            return;
          }
        }
        timer = setTimeout(scan, 200);
      } catch {
        fail('Could not read the camera. Scan again or paste a pairing link.');
      }
    };
    scan();
  })().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : '';
    fail(
      name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Camera access was blocked. Allow camera access for Puddle or paste a pairing link.'
        : name === 'NotFoundError' || name === 'NotReadableError'
          ? 'No camera is available. Close other camera apps or paste a pairing link.'
          : error instanceof Error
            ? error.message
            : 'Could not start the camera. Paste a pairing link instead.',
    );
  });
  return stop;
}
