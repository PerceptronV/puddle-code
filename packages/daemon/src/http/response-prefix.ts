/** Retain only a bounded prefix (plus one source chunk), preserving streaming and cancellation. */
export async function responsePrefix(body: ReadableStream<Uint8Array>, limit: number) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let ended = false;
  while (bytes <= limit) {
    const chunk = await reader.read();
    if (chunk.done) {
      ended = true;
      reader.releaseLock();
      break;
    }
    chunks.push(chunk.value);
    bytes += chunk.value.byteLength;
    if (bytes > limit) break;
  }
  return {
    chunks,
    bytes,
    ended,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          if (ended) controller.close();
        },
        async pull(controller) {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            reader.releaseLock();
          } else controller.enqueue(chunk.value);
        },
        cancel(reason) {
          return ended ? undefined : reader.cancel(reason);
        },
      }),
  };
}
