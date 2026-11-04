import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicPrivateJson } from '@puddle/shared/node';
import { AdapterRegistry } from '../../src/agents/registry.js';
import { RuntimeHost } from '../../src/runtime/host.js';
import { RuntimeJournal } from '../../src/runtime/journal.js';
import {
  runtimeTestAdapter,
  runtimePresetTestAdapter,
  runtimeTerminalTestAdapter,
} from './runtime-test-adapter.js';

const args = process.argv.slice(2);
const host = await RuntimeHost.start(
  args[1]!,
  args[3]!,
  'runtime-test',
  new AdapterRegistry([runtimeTestAdapter, runtimePresetTestAdapter, runtimeTerminalTestAdapter]),
);
// Deterministically yield journal admission after the fixture controller's
// command has entered the host. No gate exists in ordinary fixture runs.
const flush = RuntimeJournal.prototype.flush;
RuntimeJournal.prototype.flush = async function () {
  const gate = join(args[1]!, 'journal-admission-gate.json');
  if (existsSync(gate)) {
    const wanted = JSON.parse(readFileSync(gate, 'utf8')) as { command: number };
    if (host.state().command_cursor >= wanted.command) {
      atomicPrivateJson(join(args[1]!, 'journal-admission-entered.json'), {
        command: host.state().command_cursor,
      });
      while (existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return flush.call(this);
};
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void host.stop().then(() => process.exit(0));
  });
