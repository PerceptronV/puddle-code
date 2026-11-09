import assert from 'node:assert/strict';
import { createPuddlangClient } from '../../puddlang/client.js';
import type { HuddleExecutableCase } from './fixture.js';

/** No host bridge or network fallback. This is a test double, not a security sandbox. */
export function fixtureMocks(fixture: HuddleExecutableCase) {
  let fetches = 0,
    operations = 0;
  const unexpected: string[] = [];
  const answer = (response: HuddleExecutableCase['operations'][number]['response']) => {
    if ('error' in response) throw new Error(response.error);
    return structuredClone(response.reply);
  };
  const api = createPuddlangClient(async (operation) => {
    const expected = fixture.operations[operations++];
    try {
      assert.ok(expected, 'Unexpected agent operation');
      assert.deepEqual(
        JSON.parse(JSON.stringify(operation)),
        expected.request,
        'Agent operation differs from fixture',
      );
    } catch (error) {
      unexpected.push(String(error));
      throw error;
    }
    return answer(expected.response);
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const expected = fixture.fetch[fetches++];
    try {
      assert.ok(expected, 'Unexpected fetch; no network fallback is available');
      assert.equal(request.url, expected.url, 'Fetch URL differs from fixture');
      assert.equal(request.method, expected.method, 'Fetch method differs from fixture');
      if (expected.body !== undefined)
        assert.equal(await request.text(), expected.body, 'Fetch body differs from fixture');
    } catch (error) {
      unexpected.push(String(error));
      throw error;
    }
    request.signal.throwIfAborted();
    const value = answer(expected.response);
    return new Response([204, 205, 304].includes(expected.status) ? null : JSON.stringify(value), {
      status: expected.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    api,
    fetch,
    verify() {
      assert.deepEqual(unexpected, [], 'Unexpected calls occurred even if the adapter caught them');
      assert.equal(fetches, fixture.fetch.length, 'Unconsumed fetch fixtures');
      assert.equal(operations, fixture.operations.length, 'Unconsumed agent operation fixtures');
    },
  };
}
