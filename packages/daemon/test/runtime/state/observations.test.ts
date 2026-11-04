import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_LIMITS } from '@puddle/shared';
import { RuntimeObservations } from '../../../src/runtime/state/observations.js';

describe('private runtime shell observations', () => {
  it('keeps the profile gate and denylist authoritative without forgetting existing names', () => {
    const observations = new RuntimeObservations({
      enabled: false,
      values: { EXISTING: 'initial', PUDDLE_SECRET: 'ignored', HOME: '/ignored' },
    });
    const warn = vi.fn();
    const delta = { op: 'set' as const, name: 'NEW', value: 'value' };
    expect(observations.state()).toEqual({ enabled: false, count: 1 });
    expect(observations.environment()).toEqual({});
    expect(observations.observe(delta, warn)).toBeNull();
    observations.configure(true);
    expect(observations.environment()).toEqual({ EXISTING: 'initial' });
    for (const name of ['HOME', 'PWD', 'PUDDLE_AGENT_HELPER_DIR', 'BAD=NAME', 'bad\x1bname'])
      expect(observations.observe({ ...delta, name }, warn)).toBeNull();
    expect(
      observations.observe({ ...delta, name: 'PATH', value: '/venv/bin' }, warn),
    ).toMatchObject({ name: 'PATH' });
    expect(observations.observe({ op: 'unset', name: 'EXISTING' }, warn)).toEqual({
      op: 'unset',
      name: 'EXISTING',
    });
    expect(observations.observe({ ...delta, value: '' }, warn)).toMatchObject({ value: '' });
    expect(observations.environment()).toEqual({ PATH: '/venv/bin', NEW: '' });
    observations.configure(false);
    expect(observations.observe({ op: 'unset', name: 'NEW' }, warn)).toBeNull();
    expect(observations.state()).toEqual({ enabled: false, count: 2 });
    expect(observations.environment()).toEqual({});
    observations.clear();
    expect(observations.state().count).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('bounds values in bytes, variable counts and warning bookkeeping without printing values', () => {
    const names = Array.from({ length: RUNTIME_LIMITS.environmentVariables }, (_, i) => `VAR_${i}`);
    const observations = new RuntimeObservations({
      enabled: true,
      values: Object.fromEntries(names.map((name) => [name, 'seed'])),
    });
    const warn = vi.fn();
    const secret = '😀'.repeat(RUNTIME_LIMITS.environmentValueBytes / 2);
    expect(observations.observe({ op: 'set', name: 'VAR_0', value: secret }, warn)).toBeNull();
    expect(
      observations.observe({ op: 'set', name: 'VAR_0', value: 'changed' }, warn),
    ).toMatchObject({ value: 'changed' });
    expect(observations.observe({ op: 'set', name: 'EXCESS', value: 'secret' }, warn)).toBeNull();
    observations.observe({ op: 'unset', name: 'VAR_1' }, warn);
    expect(
      observations.observe({ op: 'set', name: 'EXCESS', value: 'allowed' }, warn),
    ).not.toBeNull();
    for (let i = 0; i < 1000; i++)
      observations.observe({ op: 'set', name: `EXCESS_${i}`, value: secret }, warn);
    expect(warn).toHaveBeenCalledTimes(RUNTIME_LIMITS.environmentVariables);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('😀');
    expect(observations.state().count).toBe(RUNTIME_LIMITS.environmentVariables);
  });
});
