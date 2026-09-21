import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { WebSocketServer } from 'ws';
const app = createServer((req, res) => {
  if (req.url?.startsWith('/stream')) {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-application': 'kept' });
    const timer = setInterval(() => res.write('stream-data\n'), 250);
    res.on('close', () => clearInterval(timer));
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': 'application=kept; Path=/',
    });
    res.end(
      JSON.stringify({
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      }),
    );
  });
});
const wss = new WebSocketServer({ server: app });
wss.on('connection', (socket, req) => {
  socket.send(JSON.stringify({ url: req.url, headers: req.headers }));
  socket.on('message', (data) => socket.send(data.toString()));
});
app.listen(0, '127.0.0.1', () => process.stdout.write(`READY PORT:${app.address().port}\n`));
if (process.stdin.isTTY) process.stdin.setRawMode(true);
createInterface({ input: process.stdin }).on('line', (line) =>
  process.stdout.write(`INPUT:${line}\n`),
);
