import { createServer, type Socket } from 'node:net';
import { expect, it } from 'vitest';
import { createMailer } from '../src/mail.js';

it('refuses authentication when an SMTP server cannot upgrade to TLS', async () => {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 fixture ESMTP\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(line.split(' ')[0]!);
        if (line.startsWith('EHLO')) socket.write('250-fixture\r\n250 AUTH PLAIN\r\n');
        else if (line === 'STARTTLS') socket.write('454 TLS unavailable\r\n');
        else if (line.startsWith('AUTH')) socket.write('235 Authenticated\r\n');
        else socket.end('221 Bye\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const mail = createMailer(
    `smtp://owner:fixture-secret@127.0.0.1:${address.port}?requireTLS=false&ignoreTLS=true`,
  );
  try {
    await expect(mail.verify()).rejects.toThrow();
    expect(commands).toContain('STARTTLS');
    expect(commands).not.toContain('AUTH');
  } finally {
    mail.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
