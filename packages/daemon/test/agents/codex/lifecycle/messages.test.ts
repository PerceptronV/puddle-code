import { describe, expect, it, vi } from 'vitest';
import { RuntimeBufferBudget } from '../../../../src/runtime/resources/budget.js';
import { CodexMessageInspection } from '../../../../src/agents/codex/lifecycle/messages.js';
import { runtimeJsonDecodeBytes } from '../../../../src/runtime/transport/decoding.js';

describe('native JSON structural admission', () => {
  it('pauses dense JSON before parsing and retains structural credit until work is released', () => {
    const body = Buffer.from(`[${Array(10000).fill('{}').join(',')}]`);
    const owner = new RuntimeBufferBudget({ bytes: 4 * 1024 * 1024, count: 10 });
    const occupied = owner.reserve(3 * 1024 * 1024)!;
    const inspection = new CodexMessageInspection(body, owner);
    const parse = vi.spyOn(JSON, 'parse');
    expect(inspection.read()).toBeNull();
    expect(parse).not.toHaveBeenCalled();
    occupied();
    expect(inspection.read()).toHaveLength(10000);
    expect(parse).toHaveBeenCalledOnce();
    expect(owner.usedBytes).toBeGreaterThan(8 * body.length);
    expect(inspection.read()).toHaveLength(10000);
    expect(parse).toHaveBeenCalledOnce();
    inspection.close();
    expect(owner.usedBytes).toBe(0);
    parse.mockRestore();
  });
  it('retains native depth/value compatibility independently of IPC traversal restrictions', () => {
    const bodies = [
      Buffer.from('['.repeat(150) + '0' + ']'.repeat(150)),
      Buffer.from(`[${Array(70000).fill('0').join(',')}]`),
    ];
    for (const body of bodies) {
      expect(() => runtimeJsonDecodeBytes(body)).toThrow();
      const budget = new RuntimeBufferBudget({ bytes: 32 * 1024 * 1024, count: 10 });
      const inspection = new CodexMessageInspection(body, budget);
      expect(inspection.read()).not.toBeNull();
      inspection.close();
      expect(budget.usedBytes).toBe(0);
    }
  });
  it('accepts native bodies above the IPC byte ceiling without shrinking the 100 MiB native limit', () => {
    const body = Buffer.from(
      JSON.stringify({ method: 'native/large', params: { text: 'x'.repeat(9 * 1024 * 1024) } }),
    );
    expect(() => runtimeJsonDecodeBytes(body)).toThrow('byte limit');
    const budget = new RuntimeBufferBudget({ bytes: 10000, count: 10 });
    const inspection = new CodexMessageInspection(body, budget);
    expect(inspection.read()?.[0]?.method).toBe('native/large');
    inspection.close();
    expect(budget.usedBytes).toBe(0);
  });
});
