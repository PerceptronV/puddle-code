import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  hostReleaseCapabilities,
  type HostRemovalFinish,
  type HostRemovalRuntimeReview,
} from '@puddle/shared';
import type { Transport } from '../../../src/lib/transport/transport.js';
import { runRemove } from '../../../src/cli/manage.js';
import { parseArgs } from '../../../src/cli/args.js';
import { removeDaemon } from '../../../src/lib/installation/remove-daemon.js';

const cli = vi.hoisted(() => ({ transport: null as Transport | null, confirm: vi.fn() }));
vi.mock('../../../src/lib/transport/open.js', () => ({
  openHostTransport: async () => cli.transport,
}));
vi.mock('../../../src/cli/prompt.js', () => ({ confirm: cli.confirm, ask: vi.fn() }));
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
  cli.confirm.mockReset();
});
function fixture(kind: 'local' | 'ssh' = 'local') {
  const home = mkdtempSync(join(tmpdir(), 'puddle-remove-cli-'));
  homes.push(home);
  vi.stubEnv('PUDDLE_HOME', home);
  const review: HostRemovalRuntimeReview = {
    id: randomUUID(),
    fingerprint: 'a'.repeat(64),
    owners: [
      {
        id: randomUUID(),
        session: randomUUID(),
        version: '0.4.0',
        terminals: 2,
        stop_blocker: null,
      },
    ],
  };
  const state = {
    receipt: null as HostRemovalFinish | null,
    lost: false,
    wrongReceipt: false,
    failFinish: false,
    resume: false,
    old: false,
  };
  const commands: string[] = [];
  const transport: Transport = {
    kind,
    label: 'isolated host',
    async exec(command) {
      commands.push(command);
      let output: unknown = '';
      if (command.startsWith('if ') && command.includes('runtime-current'))
        return { code: 0, stdout: '', stderr: '' };
      if (command.includes('HOST_CAPABILITIES')) {
        const capabilities = hostReleaseCapabilities('0.4.0');
        if (state.old) capabilities.application.minor = 18;
        output = capabilities;
      } else if (command.includes('--inspect-removal-result')) output = state.receipt;
      else if (command.includes('--inspect-removal'))
        output = state.receipt
          ? { state: 'removed', id: review.id }
          : state.resume
            ? { state: 'removing', id: review.id }
            : { state: 'none' };
      else if (command.includes('--prepare-removal')) output = review;
      else if (command.includes('--finish-removal')) {
        if (state.failFinish) return { code: 1, stdout: '', stderr: 'private host details' };
        state.receipt = {
          id: state.wrongReceipt ? randomUUID() : review.id,
          fingerprint: review.fingerprint,
          attempt_id: command.split(' ').at(-2)!,
          disposition: command.endsWith(' stop') ? 'stop' : 'retain',
        };
        if (state.lost) throw new Error('Lost finish reply');
      } else throw new Error('Unexpected command; legacy deletion must not run');
      return { code: 0, stdout: JSON.stringify(output), stderr: '' };
    },
    async readFile() {
      return null;
    },
    async copyTo() {
      throw new Error('No copying');
    },
    dispose: vi.fn(),
  };
  cli.transport = transport;
  cli.confirm.mockResolvedValue(true);
  const logger = { info: vi.fn(), warn: vi.fn() };
  return { review, state, transport, commands, logger };
}

it.each(['local', 'ssh'] as const)(
  'public %s removal retains runtimes by default and never invokes legacy deletion',
  async (kind) => {
    const f = fixture(kind);
    expect(
      await runRemove({ cmd: 'remove', what: 'daemon', yes: true, purge: false }, f.logger),
    ).toBe(0);
    expect(f.state.receipt?.disposition).toBe('retain');
    expect(f.logger.info).toHaveBeenCalledWith(expect.stringContaining('runtimes retained'));
    expect(f.transport.dispose).toHaveBeenCalled();
    expect(f.commands.some((command) => /rm -rf|sh -s/.test(command))).toBe(false);
  },
);

it('uses the explicit CLI stop flag with the exact reviewed fingerprint', async () => {
  const f = fixture();
  const command = parseArgs(['remove', 'daemon', '--yes', '--stop-runtimes']);
  if (command.cmd !== 'remove') throw new Error('Wrong parsed command');
  expect(await runRemove(command, f.logger)).toBe(0);
  expect(f.commands.find((value) => value.includes('--finish-removal'))).toMatch(
    new RegExp(`${f.review.id} ${f.review.fingerprint} [0-9a-f-]+ stop$`),
  );
  expect(() => parseArgs(['remove', 'desktop', '--stop-runtimes'])).toThrow('only applies');
});

it('keeps runtime retention when the interactive stop question is declined', async () => {
  const f = fixture();
  cli.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(
    await runRemove({ cmd: 'remove', what: 'daemon', yes: false, purge: false }, f.logger),
  ).toBe(0);
  expect(f.state.receipt?.disposition).toBe('retain');
  expect(cli.confirm).toHaveBeenCalledTimes(2);
});

it('does nothing when initial removal consent is declined', async () => {
  const f = fixture();
  cli.confirm.mockResolvedValue(false);
  expect(
    await runRemove({ cmd: 'remove', what: 'daemon', yes: false, purge: false }, f.logger),
  ).toBe(0);
  expect(f.commands.some((command) => command.includes('--prepare-removal'))).toBe(false);
});

it('explicitly resumes the exact recorded removal and observes a lost final reply', async () => {
  const f = fixture('ssh');
  f.state.resume = true;
  f.state.lost = true;
  expect(
    await runRemove({ cmd: 'remove', what: 'daemon', yes: true, purge: false }, f.logger),
  ).toBe(0);
  expect(f.commands.find((command) => command.includes('--prepare-removal'))).toContain(
    f.review.id,
  );
  expect(f.commands.filter((command) => command.includes('--finish-removal'))).toHaveLength(1);
});

it.each(['wrongReceipt', 'failFinish'] as const)(
  'does not claim removal completion after %s',
  async (outcome) => {
    const f = fixture();
    f.state[outcome] = true;
    await expect(
      runRemove({ cmd: 'remove', what: 'daemon', yes: true, purge: false }, f.logger),
    ).rejects.toMatchObject({ code: 'upgrade_failed' });
    expect(f.commands.filter((command) => command.includes('--finish-removal'))).toHaveLength(1);
    expect(f.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('puddled removed'));
  },
);

it('refuses blocked runtime stops without silently retaining them', async () => {
  const f = fixture();
  f.review.owners[0]!.stop_blocker = 'stop_pending';
  await expect(
    runRemove(
      { cmd: 'remove', what: 'daemon', yes: true, purge: false, stopRuntimes: true },
      f.logger,
    ),
  ).rejects.toMatchObject({ code: 'upgrade_failed' });
  expect(f.commands.some((command) => command.includes('--finish-removal'))).toBe(false);
});

it('does not reuse a previous completion receipt for a newly failed finish attempt', async () => {
  const f = fixture();
  f.state.receipt = {
    id: f.review.id,
    fingerprint: f.review.fingerprint,
    disposition: 'retain',
    attempt_id: randomUUID(),
  };
  f.state.failFinish = true;
  await expect(
    runRemove({ cmd: 'remove', what: 'daemon', yes: true, purge: false }, f.logger),
  ).rejects.toMatchObject({ code: 'upgrade_failed' });
  expect(f.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('puddled removed'));
});

it.each(['old', 'purge'] as const)(
  'refuses unsupported %s removal before mutation',
  async (kind) => {
    const f = fixture();
    f.state.old = kind === 'old';
    await expect(
      runRemove({ cmd: 'remove', what: 'daemon', yes: true, purge: kind === 'purge' }, f.logger),
    ).rejects.toThrow();
    expect(f.commands.some((command) => command.includes('host-update.mjs'))).toBe(false);
    await expect(removeDaemon(f.transport)).rejects.toThrow('coordinated removal');
  },
);
