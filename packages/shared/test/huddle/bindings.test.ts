import { describe, expect, it } from 'vitest';
import {
  resolveHuddleParameters,
  renderHuddlePrompt,
} from '../../src/huddle/validation/bindings.js';
import { reviewHuddleFixture } from '../helpers/huddle.js';

describe('huddle settings and prompt resolution', () => {
  it('resolves explicit variables while keeping host resource lookup separate', () => {
    const { definition, agent } = reviewHuddleFixture();
    expect(
      resolveHuddleParameters(definition, definition.nodes[1]!, agent, {
        worktree: '/srv/project',
        coder: 'coder-session',
        reviewer: 'reviewer-session',
      }),
    ).toEqual({ worktree: '/srv/project', agent: 'coder-session' });
    expect(() =>
      resolveHuddleParameters(definition, definition.nodes[1]!, agent, {
        worktree: '/srv/project',
        coder: 1,
        reviewer: 'reviewer-session',
      }),
    ).toThrow('Invalid huddle variable: coder');
  });

  it('never substitutes a default for an explicit unavailable binding', () => {
    const { definition, agent } = reviewHuddleFixture();
    definition.variables['coder']!.required = false;
    agent.parameters['agent']!.default = 'different-session';
    expect(() =>
      resolveHuddleParameters(definition, definition.nodes[1]!, agent, {
        worktree: '/srv/project',
        reviewer: 'reviewer-session',
      }),
    ).toThrow('Missing bound variable: coder');
  });

  it('preserves literal null and rejects undeclared settings', () => {
    const { definition, agent } = reviewHuddleFixture();
    agent.parameters['agent']!.schema = { type: ['string', 'null'] };
    definition.nodes[1]!.parameters['agent'] = { kind: 'literal', value: null };
    const variables = {
      worktree: '/srv/project',
      coder: 'coder-session',
      reviewer: 'reviewer-session',
    };
    expect(
      resolveHuddleParameters(definition, definition.nodes[1]!, agent, variables)['agent'],
    ).toBeNull();
    expect(() =>
      resolveHuddleParameters(definition, definition.nodes[1]!, agent, {
        ...variables,
        secret: 'no',
      }),
    ).toThrow('Unknown huddle variable');
  });

  it('renders only named JSON references, preserving shell text and avoiding recursive expansion', () => {
    expect(
      renderHuddlePrompt('Task: {{input.task}}; ready: {{ready}}', {
        input: { task: '$(touch /tmp/no) {{ready}}' },
        ready: false,
      }),
    ).toBe('Task: $(touch /tmp/no) {{ready}}; ready: false');
    expect(() => renderHuddlePrompt('{{input.missing}}', { input: {} })).toThrow(
      'Missing prompt reference',
    );
    expect(() => renderHuddlePrompt('{{process.exit()}}', {})).toThrow('Invalid prompt reference');
    expect(() => renderHuddlePrompt('{{constructor}}', {})).toThrow('Invalid prompt reference');
    expect(() => renderHuddlePrompt('{{x}}{{x}}', { x: 'a'.repeat(100_000) })).toThrow('exceeds');
  });
});
