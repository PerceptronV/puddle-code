import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { runtimeReleaseCapabilities } from '@puddle/shared';
import { huddleExecutionFixture } from '../../helpers/huddle/execution.js';
import { spawnGraphSnapshot } from '../../helpers/huddle/spawn-graph.js';
import { runtimeTestAdapter } from '../../helpers/runtime-test-adapter.js';
import { HuddleExecutionService } from '../../../src/huddle/execution/service.js';
import { AccountStore } from '../../../src/db/stores/accounts.js';
import { AdapterRegistry } from '../../../src/agents/registry.js';
import { runtimeDirectory } from '../../../src/runtime/ownership/storage.js';

async function fixture() {
  const f = await huddleExecutionFixture();
  const older = runtimeReleaseCapabilities('1.2.3');
  delete older.roles.huddle!.spawns;
  writeFileSync(join(f.installed.release, 'RUNTIME_CAPABILITIES.json'), JSON.stringify(older));
  const accounts = new AccountStore(f.db);
  const account = accounts.create({
    profile_id: f.profile.id,
    agent_type: runtimeTestAdapter.id,
    label: 'fixture',
    config_dir: f.home,
    skip_permissions_default: false,
  });
  accounts.setLoggedIn(account.id, true);
  const adapters = new AdapterRegistry([runtimeTestAdapter]);
  const execution = new HuddleExecutionService({
    ...f,
    accounts,
    adapters,
    controls: f.controls.huddles,
    agentBinding: () => {
      throw new Error('Spawn-only admission must not attach an existing agent');
    },
  });
  const graph = spawnGraphSnapshot(f.session.huddle_id!, {
    projectId: f.project.id,
    worktree: realpathSync(f.home),
    accountId: account.id,
    agent: account.agent_type,
  });
  const save = () => {
    for (const [name, content] of Object.entries({
      ...graph.snapshot.files,
      'huddle.json': JSON.stringify(graph.snapshot.definition),
      'nodes/example/node.json': JSON.stringify(graph.snapshot.components.worker),
    })) {
      mkdirSync(dirname(join(f.root, name)), { recursive: true });
      writeFileSync(join(f.root, name), content);
    }
  };
  const input = async () => ({ expected_digest: (await f.source()).digest, variables: {} });
  const start = async () => execution.start(f.profile.id, f.session.id, await input(), () => true);
  const enable = () => {
    const metadata = runtimeReleaseCapabilities('1.2.3');
    metadata.roles.huddle = { ...metadata.roles.huddle!, spawns: 1 };
    writeFileSync(join(f.installed.release, 'RUNTIME_CAPABILITIES.json'), JSON.stringify(metadata));
  };
  return { ...f, execution, accounts, account, adapters, graph, save, input, start, enable };
}

it('rejects unavailable and changed resource choices before retaining a launch', async () => {
  const f = await fixture();
  try {
    f.enable();
    const worker = f.graph.snapshot.definition.nodes.find((node) => node.id === 'worker')!;
    for (const value of ['', 'fixture', '01', '1e0', '-1', '9007199254740992']) {
      worker.parameters.account = { kind: 'literal', value };
      f.save();
      await expect(f.start()).rejects.toMatchObject({ code: 'invalid_account' });
    }
    worker.parameters.account = { kind: 'literal', value: String(f.account.id) };
    worker.parameters.project = { kind: 'literal', value: 'other-project' };
    f.save();
    await expect(f.start()).rejects.toMatchObject({ code: 'huddle_project_unavailable' });
    worker.parameters.project = { kind: 'literal', value: f.project.id };
    f.save();
    f.accounts.setLoggedIn(f.account.id, false);
    await expect(f.start()).rejects.toMatchObject({ code: 'huddle_account_unavailable' });
    f.accounts.setLoggedIn(f.account.id, true);
    const other = f.profiles.create({ name: 'other', branch_prefix: '' });
    const account = f.accounts.create({ ...f.account, profile_id: other.id, label: 'other' });
    f.accounts.setLoggedIn(account.id, true);
    worker.parameters.account = { kind: 'literal', value: String(account.id) };
    f.save();
    await expect(f.start()).rejects.toMatchObject({ code: 'huddle_account_unavailable' });
    worker.parameters.account = { kind: 'literal', value: String(f.account.id) };
    worker.parameters.provider = { kind: 'literal', value: 'missing' };
    f.save();
    await expect(f.start()).rejects.toMatchObject({ code: 'unknown_agent_type' });
    worker.parameters.provider = { kind: 'literal', value: runtimeTestAdapter.id };
    f.save();
    const adapter = vi
      .spyOn(f.adapters, 'get')
      .mockReturnValue({ ...runtimeTestAdapter, scriptedTurns: undefined });
    await expect(f.start()).rejects.toMatchObject({ code: 'huddle_provider_unavailable' });
    adapter.mockReturnValue({ ...runtimeTestAdapter, id: 'different-provider' });
    await expect(f.start()).rejects.toMatchObject({ code: 'huddle_account_provider_mismatch' });
    adapter.mockRestore();
    f.storage.assertAdmission.mockImplementationOnce(async () => {
      f.accounts.setLoggedIn(f.account.id, false);
    });
    await expect(f.start()).rejects.toMatchObject({ code: 'huddle_account_unavailable' });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.runtimes.hasUnreleasedHuddle(f.session.id)).toBe(false);
  } finally {
    await f.close();
  }
});

it('gates Start and Apply on owner spawn support and retains explicit activation bindings', async () => {
  const f = await fixture();
  try {
    const started = await f.start();
    if (!started.owner?.connected) throw new Error('Expected connected owner');
    const initial = started.owner.target;
    f.save();
    await expect(
      f.execution.apply(
        f.profile.id,
        f.session.id,
        { ...(await f.input()), target: initial },
        () => true,
      ),
    ).rejects.toMatchObject({ code: 'huddle_execution_unsupported' });
    expect((await f.execution.inspect(f.profile.id, f.session.id, () => true)).owner).toMatchObject(
      { target: initial },
    );
    await f.execution.stop(f.profile.id, f.session.id, { target: initial }, () => true);
    await expect(f.start()).rejects.toMatchObject({ code: 'huddle_execution_unsupported' });
    expect(f.run).toHaveBeenCalledTimes(1);
    f.enable();
    f.graph.snapshot.definition.variables.selectedAccount = {
      schema: { type: 'number' },
      editor: 'account',
      default: f.account.id,
    };
    f.graph.snapshot.components.worker!.parameters.account!.schema = { type: 'number' };
    f.graph.snapshot.definition.nodes.find((node) => node.id === 'worker')!.parameters.account = {
      kind: 'variable',
      name: 'selectedAccount',
    };
    f.save();
    const supported = await f.start();
    if (!supported.owner?.connected) throw new Error('Expected supporting owner');
    const target = supported.owner.target;
    const launchPath = join(runtimeDirectory(f.home, target.runtimeId), 'launch.json');
    expect(JSON.parse(readFileSync(launchPath, 'utf8')).initial.bindings).toEqual(f.graph.bindings);
    const account = f.accounts.create({ ...f.account, label: 'second' });
    f.accounts.setLoggedIn(account.id, true);
    f.graph.snapshot.definition.nodes.find((node) => node.id === 'worker')!.parameters.account = {
      kind: 'literal',
      value: account.id,
    };
    f.save();
    const apply = vi.spyOn(f.controls.huddles, 'apply');
    const changed = await f.execution.apply(
      f.profile.id,
      f.session.id,
      { ...(await f.input()), target },
      () => true,
    );
    expect(apply.mock.calls[0]![1].bindings.worker).toEqual({
      ...f.graph.bindings.worker,
      account: String(account.id),
    });
    expect(JSON.parse(readFileSync(launchPath, 'utf8')).initial.bindings).toEqual(f.graph.bindings);
    if (!changed.owner?.connected) throw new Error('Expected applied owner');
    expect(changed.owner.target.activationId).not.toBe(target.activationId);
    await f.execution.stop(
      f.profile.id,
      f.session.id,
      { target: changed.owner.target },
      () => true,
    );
  } finally {
    await f.close();
  }
});
