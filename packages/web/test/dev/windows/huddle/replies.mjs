import assert from 'node:assert/strict';

/** Lose both replies after the real coordinator has committed one huddle move. */
export function huddleTransferReplies(coordinator) {
  let reference;
  const calls = { preparePane: 0, accept: 0, commit: 0 };
  const observed = new Set();
  const lost = new Set();
  return {
    async dispatch(windowId, method, request) {
      if (
        method === 'preparePane' &&
        request.destination.snapshot.layout_tree?.tabs.some((tab) => tab.type === 'huddle')
      ) {
        assert.ok(!reference || reference === request.id, 'a lost reply must not repeat the move');
        reference = request.id;
        calls.preparePane++;
      }
      const selected = reference !== undefined && request.id === reference;
      if (selected && (method === 'accept' || method === 'commit')) calls[method]++;
      const result = await coordinator[method](windowId, request);
      if (selected && (method === 'accept' || method === 'commit') && !lost.has(method)) {
        lost.add(method);
        throw new Error(`Synthetic lost huddle ${method} reply`);
      }
      if (selected && method === 'observe') {
        assert.equal(result.status, 'committed');
        observed.add(windowId);
      }
      return result;
    },
    verify() {
      assert.deepEqual(calls, { preparePane: 1, accept: 1, commit: 1 });
      assert.deepEqual([...lost].sort(), ['accept', 'commit']);
      assert.equal(observed.size, 2, 'both renderers recover through committed-state observation');
    },
  };
}
