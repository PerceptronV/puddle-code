/**
 * The PTY owns each CLI process tree. The private socket carries commands and
 * structured stdout; only deliberately rendered text reaches the terminal.
 * Kept inline so bundled releases need no extra executable or module lookup.
 */
export const SCRIPT_TERMINAL_SOURCE = String.raw`
const net = require('node:net');
const { spawn } = require('node:child_process');
const socket = net.connect(process.argv[1]);
let child = null, current = null, buffer = '', stopping = false, killTimer = null, release = null;
const send = (message) => {
  if (!socket.destroyed) return socket.write(JSON.stringify(message) + '\n');
  return false;
};
const kill = () => {
  const active = child;
  if (!active?.pid || killTimer) return;
  const pid = active.pid;
  try { process.kill(-pid, 'SIGTERM'); } catch {}
  killTimer = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    killTimer = null;
    release?.();
  }, 500);
};
const stop = () => {
  if (stopping) return;
  stopping = true;
  kill();
  setTimeout(() => process.exit(0), 550);
};
process.on('SIGHUP', stop);
process.on('SIGTERM', stop);
socket.on('close', stop);
socket.on('error', stop);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (data) => {
  if (data.includes(3)) send({ type: 'interrupt' });
});
socket.on('connect', () => {
  process.stdout.write('Puddlang scripted session. Ctrl+C interrupts the current turn.\r\n');
  send({ type: 'ready' });
});
socket.setEncoding('utf8');
socket.on('data', (data) => {
  buffer += data;
  if (buffer.length > 2 * 1024 * 1024) return stop();
  for (;;) {
    const end = buffer.indexOf('\n');
    if (end < 0) break;
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    let message;
    try { message = JSON.parse(line); } catch { return stop(); }
    if (message.type === 'display') {
      process.stdout.write(String(message.text).replace(/\r?\n/g, '\r\n'));
    } else if (message.type === 'cancel') {
      // Completion may already be in flight when cancellation arrives.
      if (message.id === current) kill();
    } else if (message.type === 'run' && child === null && !stopping) {
      const id = current = message.id;
      const env = { ...process.env, ...message.env };
      // Structured execution reports through its owner, not inherited hooks.
      delete env.PUDDLE_AGENT_SIGNAL_URL;
      delete env.PUDDLE_AGENT_SIGNAL_NONCE;
      const proc = child = spawn(message.binary, message.args, {
        env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      for (const name of ['stdout', 'stderr']) proc[name].on('data', (bytes) => {
        if (!send({ type: name, id, data: bytes.toString('base64') })) proc[name].pause();
      });
      socket.on('drain', drain);
      function drain() { proc.stdout.resume(); proc.stderr.resume(); }
      proc.on('error', (error) => send({ type: 'error', id, error: error.message }));
      proc.stdin.on('error', () => {});
      proc.stdin.end(message.stdin);
      proc.on('close', (code, signal) => {
        socket.off('drain', drain);
        release = () => {
          child = null; current = null; release = null;
          send({ type: 'exit', id, code, signal });
        };
        if (killTimer) {
          try { process.kill(-proc.pid, 0); }
          catch { clearTimeout(killTimer); killTimer = null; }
        }
        // Do not admit the next turn while cancelled descendants still live.
        if (!killTimer) release();
      });
    } else return stop();
  }
});
`;
