import { describe, expect, it, vi } from 'vitest';
import type { LifecycleLaunchContext } from '../../../src/agents/adapter.js';
import { RuntimeAgent } from '../../../src/runtime/execution/agent.js';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';
import { fakeAdapter } from '../../helpers/daemon-fixtures.js';
import { prepare } from '../../helpers/runtime-fixture.js';

describe('provider-neutral runtime capacity failure', () => {
  it.each(['during', 'after'] as const)(
    'keeps lifecycle failure sticky %s preparation without disposing provider resources',
    async (when) => {
      const { home, launch } = prepare('interactive');
      const allowance = new RuntimeBufferBudget({ bytes: 1024, count: 16 });
      let provider!: LifecycleLaunchContext;
      const dispose = vi.fn(async () => {});
      const control = { ready: true, ask: vi.fn(async () => 'answer') };
      const adapter = {
        ...fakeAdapter({ id: 'runtime-test' }),
        prepareLifecycleLaunch: async (context: LifecycleLaunchContext) => {
          provider = context;
          expect(context.bufferAllowance).toBe(allowance);
          if (when === 'during') context.reportLifecycleUnavailable?.();
          return { args: context.args, control, dispose };
        },
      };
      const state = vi.fn();
      const runtime = new RuntimeAgent(
        home,
        launch,
        adapter,
        { writeInput: vi.fn(), lifecycle: vi.fn(), collision: vi.fn(), state },
        allowance,
      );
      try {
        const command = await runtime.prepare();
        if (when === 'after') {
          expect(runtime.state().native_sync).toBe('full');
          provider.reportLifecycleUnavailable?.();
        }
        expect(runtime.state()).toMatchObject({ native_sync: 'fallback', control_ready: false });
        expect(runtime.control()).toBeNull();
        provider.reportStatus?.('waiting_input');
        runtime.output('still running');
        expect(runtime.state().native_sync).toBe('fallback');
        expect(dispose).not.toHaveBeenCalled();
        const response = await fetch(command.env['PUDDLE_AGENT_SIGNAL_URL']!, {
          method: 'POST',
          body: JSON.stringify({
            nonce: command.env['PUDDLE_AGENT_SIGNAL_NONCE'],
            state: 'working',
          }),
        });
        expect(response.status).toBe(503);
        await response.arrayBuffer();
        expect(allowance.usedBytes).toBe(0);
      } finally {
        await runtime.close();
      }
      expect(dispose).toHaveBeenCalledOnce();
    },
  );
});
