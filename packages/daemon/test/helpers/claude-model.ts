import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Synthetic Anthropic stream for opt-in native CLI acceptance; never contacts a provider. */
export async function claudeModel() {
  let calls = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) {
        response.writeHead(413).end();
        return;
      }
    }
    if (request.url?.includes('count_tokens')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    if (!request.url?.startsWith('/v1/messages')) {
      response.writeHead(404).end();
      return;
    }
    const input = JSON.parse(body);
    const message = {
      id: `fixture-${++calls}`,
      type: 'message',
      role: 'assistant',
      model: input.model,
      content: [{ type: 'text', text: 'Synthetic Claude reply.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 4 },
    };
    if (!input.stream) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(message));
      return;
    }
    response.setHeader('content-type', 'text/event-stream');
    for (const event of [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: message.content[0]!.text },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      { type: 'message_stop' },
    ])
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls: () => calls,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
