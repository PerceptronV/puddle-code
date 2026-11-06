/** Fixed native-job viewer. Leaving the native view never opens an agent picker. */
export const CLAUDE_JOB_TERMINAL_SOURCE = String.raw`
const net = require('node:net');
const owner = net.connect(process.argv[1]);
let native = null, pending = '', closed = false, connected = false, attach = null;
let opening = false, header = Buffer.alloc(0), modes = [];
const send = (message) => {
  if (owner.destroyed || owner.writableLength > 65536) return close(1);
  owner.write(JSON.stringify(message) + '\n');
};
const leaveScreen = () => {
  process.stdout.write(modes.map(mode => '\x1b[?' + mode + 'l').join('') + '\x1b[?2026l\x1b[?1049l');
  modes = [];
};
const close = (code = 0) => {
  if (closed) return;
  closed = true; native?.destroy(); owner.destroy(); leaveScreen(); process.exit(code);
};
process.on('SIGTERM', () => close());
process.on('SIGHUP', () => close());
process.stdout.on('resize', () => send({ type: 'resize', attachId: attach?.attachId, cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }));
process.stdout.on('drain', () => native?.resume());
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (data) => {
  if (closed) return;
  if (!connected) {
    if (!opening && (data.includes(13) || data.includes(10))) { opening = true; send({ type: 'attach' }); }
    return; // Never retain input across a native detach or replacement.
  }
  if (!native.write(data)) process.stdin.pause();
});
const open = (message) => {
  if (closed || native || opening && attach) return;
  opening = true; attach = message; header = Buffer.alloc(0);
  const socket = native = net.connect(message.socket);
  const timeout = setTimeout(() => socket.destroy(), 5000);
  let acknowledged = false;
  socket.on('connect', () => socket.write(JSON.stringify({
    proto: 1, op: 'attach', short: message.job, auth: message.auth,
    cols: process.stdout.columns || 80, rows: process.stdout.rows || 24, attachId: message.attachId,
    caps: { imark: false, terminal: 'xterm-256color', mux: null, ssh: false, wheelFlood: false,
      hyperlinks: true, progressReporting: false, printsUnknownSequences: false, wtSession: false,
      isVscodeTerm: false, keyDialect: null, browser: null, colorLevel: 3, syncOutput: true, editor: null },
  }) + '\n'));
  socket.on('drain', () => process.stdin.resume());
  socket.on('data', (data) => {
    if (native !== socket) return;
    if (!acknowledged) {
      const newline = data.indexOf(10);
      const prefix = newline < 0 ? data : data.subarray(0, newline);
      if (header.length + prefix.length > 65536) return socket.destroy();
      header = Buffer.concat([header, prefix]);
      if (newline < 0) return;
      let result;
      try { result = JSON.parse(header.toString()); } catch { return socket.destroy(); }
      if (!result.ok || result.op !== 'attach' || result.workerCliVersion !== '2.1.318') return socket.destroy();
      acknowledged = true; clearTimeout(timeout);
      process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
      modes = Array.isArray(result.decModes) ? result.decModes.slice(0, 64).filter(mode => Number.isInteger(mode) && mode > 0 && mode < 10000) : [];
      for (const mode of modes) process.stdout.write('\x1b[?' + mode + 'h');
      send({ type: 'attached', attachId: message.attachId });
      data = data.subarray(newline + 1); header = Buffer.alloc(0);
    }
    if (data.length && !process.stdout.write(data)) socket.pause();
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    clearTimeout(timeout);
    if (native !== socket || closed) return;
    native = null; connected = false; opening = false; attach = null; header = Buffer.alloc(0);
    process.stdin.resume();
    leaveScreen();
    send({ type: 'detached', attachId: message.attachId, acknowledged });
  });
};
owner.on('connect', () => send({ type: 'hello', nonce: process.env.PUDDLE_AGENT_SIGNAL_NONCE }));
owner.on('error', () => close(1));
owner.on('close', () => close());
owner.setEncoding('utf8');
owner.on('data', (data) => {
  pending += data;
  if (Buffer.byteLength(pending) > 65536) return close(1);
  for (;;) {
    const end = pending.indexOf('\n'); if (end < 0) break;
    let message;
    try { message = JSON.parse(pending.slice(0, end)); } catch { return close(1); }
    pending = pending.slice(end + 1);
    if (message.type === 'connect') open(message);
    else if (message.type === 'ready') { if (native && message.attachId === attach?.attachId) { connected = true; opening = false; } }
    else if (message.type === 'notice') {
      opening = false;
      process.stdout.write(String(message.text).replace(/[\x00-\x1f\x7f]/g, ' ') + '\r\n');
    } else if (message.type === 'exit') close(message.code || 0);
    else return close(1);
  }
});
`;
