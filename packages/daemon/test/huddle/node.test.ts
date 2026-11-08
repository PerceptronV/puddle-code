import { describe, expect, it, vi } from 'vitest';
import { huddleComponentSchema } from '@puddle/shared';
import { HuddleNode } from '../../src/puddlang/huddle/node.js';
import { executeHuddleNode } from '../../src/puddlang/huddle/execute.js';
import type { HuddleNodeContext } from '../../src/puddlang/huddle/context.js';

function fixture() {
  const component = huddleComponentSchema.parse({
    format: 1,
    id: 'project.node.review',
    version: 1,
    category: 'script',
    title: 'Review',
    inputs: { request: { schema: { type: 'object' } } },
    parameters: { prompt: { schema: { type: 'string' }, editor: 'prompt' } },
    outputs: {
      completed: {
        schema: {
          type: 'object',
          properties: { approved: { type: 'boolean' } },
          required: ['approved'],
        },
      },
      turn: { schema: { type: 'string' }, emission: 'event', required: false },
    },
  });
  const abort = new AbortController();
  const emit = vi.fn(async (_port: string, _value: unknown) => {});
  const context: HuddleNodeContext = {
    inputs: { request: { task: 'Review' } },
    parameters: { prompt: 'Inspect changes' },
    bindings: {},
    signal: abort.signal,
    emit,
    puddlang: {
      spawn: async () => {
        throw new Error('No agent dispatch in this test');
      },
      attach: async () => {
        throw new Error('No agent dispatch in this test');
      },
    },
  };
  return { component, context, abort, emit };
}

describe('HuddleNode execution boundary', () => {
  it('runs explicit alternatives with one validated input and rejects empty alternatives', async () => {
    const s = fixture();
    s.component.activation = 'any';
    s.component.inputs['alternative'] = {
      schema: { type: 'string' },
      required: true,
      emission: 'completion',
    };
    const run = vi.fn(() => ({ completed: { approved: true } }));
    const node = HuddleNode({ contract: './node.json', run });
    await executeHuddleNode(node, s.component, { ...s.context, inputs: { alternative: 'review' } });
    expect(run).toHaveBeenCalledOnce();
    await expect(
      executeHuddleNode(node, s.component, { ...s.context, inputs: {} }),
    ).rejects.toThrow('Missing input');
    await expect(
      executeHuddleNode(node, s.component, { ...s.context, inputs: { alternative: 1 } }),
    ).rejects.toThrow('Invalid input');
    expect(run).toHaveBeenCalledOnce();
  });
  it('declares a node without executing it and validates completion outputs', async () => {
    const s = fixture();
    const run = vi.fn(() => ({ completed: { approved: true } }));
    const node = HuddleNode({ contract: './node.json', run });
    expect(run).not.toHaveBeenCalled();
    expect(Object.isFrozen(node)).toBe(true);
    expect(await executeHuddleNode(node, s.component, s.context)).toEqual({
      completed: { approved: true },
    });
    expect(() => HuddleNode({ contract: '../outside.json', run })).toThrow();
  });

  it('rejects bad inputs/settings before dispatch and bad approval values after execution', async () => {
    const s = fixture();
    const run = vi.fn(() => ({ completed: { approved: 'yes' } }));
    const node = HuddleNode({ contract: './node.json', run });
    await expect(
      executeHuddleNode(node, s.component, { ...s.context, inputs: {} }),
    ).rejects.toThrow('Missing input');
    await expect(
      executeHuddleNode(node, s.component, { ...s.context, parameters: { prompt: true } }),
    ).rejects.toThrow('Invalid node parameter');
    expect(run).not.toHaveBeenCalled();
    await expect(executeHuddleNode(node, s.component, s.context)).rejects.toThrow('Invalid output');
  });

  it('passes immutable snapshots without freezing or modifying the caller objects', async () => {
    const s = fixture();
    const node = HuddleNode({
      contract: './node.json',
      run: ({ inputs, parameters, bindings }) => {
        expect(Object.isFrozen(inputs)).toBe(true);
        expect(Object.isFrozen(inputs['request'])).toBe(true);
        expect(Object.isFrozen(parameters)).toBe(true);
        expect(Object.isFrozen(bindings)).toBe(true);
        return { completed: { approved: true } };
      },
    });
    const outputs = await executeHuddleNode(node, s.component, s.context);
    expect(Object.isFrozen(outputs['completed'])).toBe(true);
    expect(Object.isFrozen(s.context.inputs)).toBe(false);
  });

  it('awaits validated event emissions and rejects completion ports passed to emit', async () => {
    const s = fixture();
    const node = HuddleNode({
      contract: './node.json',
      run: async ({ emit }) => {
        await emit('turn', 'reply');
        return { completed: { approved: true } };
      },
    });
    await executeHuddleNode(node, s.component, s.context);
    expect(s.emit).toHaveBeenCalledExactlyOnceWith('turn', 'reply');
    const bad = HuddleNode({
      contract: './node.json',
      run: async ({ emit }) => {
        await emit('completed', { approved: true });
        return { completed: { approved: true } };
      },
    });
    await expect(executeHuddleNode(bad, s.component, s.context)).rejects.toThrow(
      'not an event port',
    );
    expect(s.emit).toHaveBeenCalledTimes(1);
  });

  it('refuses completion while an emission is unacknowledged and fences late emissions', async () => {
    const s = fixture();
    let acknowledge!: () => void;
    s.context.emit = () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
    let late!: HuddleNodeContext['emit'];
    const node = HuddleNode({
      contract: './node.json',
      run: ({ emit }) => {
        late = emit;
        void emit('turn', 'first');
        return { completed: { approved: true } };
      },
    });
    await expect(executeHuddleNode(node, s.component, s.context)).rejects.toThrow(
      'unawaited emissions',
    );
    acknowledge();
    await expect(late('turn', 'second')).rejects.toThrow('already finished');
  });

  it('does not accept output or events after cancellation, nor repair invalid outputs', async () => {
    const s = fixture();
    const node = HuddleNode({
      contract: './node.json',
      run: () => {
        s.abort.abort(new Error('Cancelled'));
        return { completed: { approved: true } };
      },
    });
    await expect(executeHuddleNode(node, s.component, s.context)).rejects.toThrow('Cancelled');
    expect(s.emit).not.toHaveBeenCalled();
    const next = fixture();
    await expect(
      executeHuddleNode(
        HuddleNode({ contract: './node.json', run: () => ({ other: true }) }),
        next.component,
        next.context,
      ),
    ).rejects.toThrow('Missing output');
  });
});
