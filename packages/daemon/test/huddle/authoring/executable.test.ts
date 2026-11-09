import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { huddleAuthoringFiles } from '@puddle/shared';
import { huddleTestingFiles } from '../../../../../scripts/lib/huddle/testing.mjs';

it('ships a portable executable kit using actual captured wrappers, fake I/O and per-case isolation', async () => {
  const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
  const files = huddleAuthoringFiles();
  expect(
    Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('testing/'))),
  ).toEqual(await huddleTestingFiles(repository));
  const home = mkdtempSync(join(tmpdir(), 'puddle-huddle-executable-'));
  try {
    const id = '0'.repeat(32);
    const root = join(home, '.puddle/huddle', id);
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    for (const [path, text] of Object.entries(files)) {
      if (path.startsWith('testing/')) write(path, text);
      if (path.startsWith('templates/')) write(path.replace('templates/', 'nodes/'), text);
    }
    write('huddle.json', files['examples/feed-report.json']!);
    write('fixtures/executable.json', files['fixtures/executable.json']!);
    mkdirSync(join(root, 'testing/node_modules'));
    symlinkSync(
      join(repository, 'packages/daemon/node_modules/zod'),
      join(root, 'testing/node_modules/zod'),
    );
    const run = (timeout = '10000') =>
      spawnSync(
        process.execPath,
        [
          join(root, 'testing/run.mjs'),
          '--worktree',
          home,
          '--huddle',
          id,
          '--fixture',
          'fixtures/executable.json',
          '--timeout',
          timeout,
        ],
        {
          encoding: 'utf8',
          timeout: 30000,
          env: { ...process.env, PUDDLE_FIXTURE_SECRET: 'must-not-inherit' },
        },
      );
    const passed = run();
    expect(passed.error, passed.stderr).toBeUndefined();
    expect(passed.status, passed.stdout + passed.stderr).toBe(0);
    expect(JSON.parse(passed.stdout)).toMatchObject({
      passed: true,
      cases: [{ passed: true }, { passed: true }, { passed: true }, { passed: true }],
    });

    const script = (body: string) =>
      write(
        'nodes/transform/run.ts',
        `import {HuddleNode} from 'puddlang/huddle';
export default HuddleNode({contract:'./node.json',async run(context) {${body}}});`,
      );
    script(
      `try { await fetch('https://unlisted.invalid'); } catch {} return {completed:process.env.PUDDLE_FIXTURE_SECRET ?? 'absent'};`,
    );
    write(
      'fixtures/executable.json',
      JSON.stringify({
        format: 1,
        cases: [
          {
            name: 'No fallback',
            node: 'transform',
            inputs: { value: null },
            expect: { outputs: { completed: 'absent' } },
          },
        ],
      }),
    );
    const rejected = run();
    expect(rejected.status).toBe(1);
    expect(JSON.parse(rejected.stdout).cases[0].error).toContain('Unexpected calls occurred');

    script(`return {completed:process.env.PUDDLE_FIXTURE_SECRET ?? 'absent'};`);
    expect(run().status).toBe(0);
    const handle = {
      runtime_id: '00000000-0000-4000-8000-000000000001',
      session_id: '00000000-0000-4000-8000-000000000002',
    };
    script(
      `const agent = await context.puddlang.attach('fixture-agent'); return {completed:await agent.ask('Hello')};`,
    );
    write(
      'fixtures/executable.json',
      JSON.stringify({
        format: 1,
        cases: [
          {
            name: 'Fake agent',
            node: 'transform',
            inputs: { value: null },
            operations: [
              {
                request: { op: 'attach', reference: 'fixture-agent' },
                response: { reply: handle },
              },
              {
                request: { op: 'ask', handle, request: { prompt: 'Hello' } },
                response: { reply: 'Fixture reply' },
              },
            ],
            expect: { outputs: { completed: 'Fixture reply' } },
          },
        ],
      }),
    );
    expect(run().status).toBe(0);
    write(
      'fixtures/executable.json',
      JSON.stringify({
        format: 1,
        cases: [
          { name: 'Deadline', node: 'transform', inputs: { value: null }, expect: { outputs: {} } },
        ],
      }),
    );
    script('setInterval(() => {}, 1000); await new Promise(() => {}); return {};');
    const timed = run('200');
    expect(timed.status).toBe(1);
    expect(JSON.parse(timed.stdout)).toMatchObject({
      passed: false,
      cases: [{ passed: false, error: expect.stringMatching(/ETIMEDOUT|SIGKILL/) }],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
