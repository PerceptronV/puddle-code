import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** Exercise the shipped captured-source worker without a daemon, service or agent. */
export async function smokeHuddleWorker(stage, nodePath = join(stage, 'bin/node')) {
  const component = {
    format: 1,
    id: 'puddle.fixture.script',
    version: 1,
    category: 'script',
    title: 'Smoke',
    entry: './run.ts',
    dependencies: ['./helper.ts'],
    inputs: { value: { schema: { type: 'number' } } },
    outputs: { completed: { schema: { type: 'number' } } },
  };
  const job = {
    invocationId: randomUUID(),
    revision: 'a'.repeat(64),
    node: 'smoke',
    manifest: 'node.json',
    component,
    inputs: { value: 21 },
    parameters: {},
    bindings: {},
    files: {
      'node.json': JSON.stringify(component),
      'helper.ts': 'export const double = (value: number) => value * 2;',
      'run.ts': `import {HuddleNode} from 'puddlang/huddle'; import {z} from 'zod';
        import {double} from './helper.ts';
        export default HuddleNode({contract:'./node.json',run({inputs}) {
          return {completed:double(z.number().parse(inputs.value))};
        }});`,
    },
  };
  const child = spawn(nodePath, [join(stage, 'daemon/huddle/runner.js')], {
    cwd: stage,
    env: {},
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
  });
  let diagnostic = '';
  let response = Buffer.alloc(0);
  const socket = child.stdio[3];
  child.stderr.on('data', (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-8192);
  });
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    if (response.length + chunk.length > 8192) {
      child.kill('SIGKILL');
      return;
    }
    response = Buffer.concat([response, chunk]);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
      const body = Buffer.from(JSON.stringify({ type: 'start', job }));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
    if (response.length < 4 || response.readUInt32BE() !== response.length - 4)
      throw new Error(`Huddle archive worker response is incomplete: ${diagnostic}`);
    const result = JSON.parse(response.subarray(4).toString('utf8'));
    if (code !== 0 || result.type !== 'finished' || result.outputs.completed !== 42)
      throw new Error(
        `Huddle archive worker smoke failed: ${JSON.stringify(result)} ${diagnostic}`,
      );
  } finally {
    clearTimeout(timer);
  }
}
