const owner = {
  runtimeId: '11111111-1111-4111-8111-111111111111',
  incarnation: '22222222-2222-4222-8222-222222222222',
};
const executionId = '33333333-3333-4333-8333-333333333333';
const invocationId = '44444444-4444-4444-8444-444444444444';
/** Recorded-only UI fixture: no owner object or execution control is constructed. */
export function retainedHistoryFixture() {
  let failed = false;
  return {
    fail(value: boolean) {
      failed = value;
    },
    request(action: string, input: { owner?: typeof owner; collection?: string; after?: number }) {
      if (action === 'owners')
        return Response.json({
          source: 'recorded-bindings',
          records: [
            {
              owner,
              build: 'recorded-fixture',
              recorded_state: 'exited',
              created_at: '2026-11-08T10:00:00.000Z',
              ended_at: '2026-11-08T10:30:00.000Z',
            },
          ],
          next: null,
        });
      if (failed)
        return Response.json(
          {
            error: {
              code: 'huddle_history_unavailable',
              message: 'Retained history is unavailable; no owner was started',
            },
          },
          { status: 409 },
        );
      const record =
        input.collection === 'executions'
          ? {
              id: executionId,
              revision: 'a'.repeat(64),
              state: 'completed',
              acceptedAt: 1,
              deadline: 100000,
              turns: 1,
              spawns: 0,
              invocations: 1,
            }
          : input.collection === 'invocations'
            ? {
                id: invocationId,
                executionId,
                revision: 'a'.repeat(64),
                node: 'review',
                iteration: 0,
                state: 'completed',
                inputs: { prompt: 'Review' },
                result: { answer: 'Retained after Stop' },
              }
            : {
                id: '55555555-5555-4555-8555-555555555555',
                invocationId,
                executionId,
                kind: 'readout',
                state: 'unknown',
                consumed: true,
                error: 'Destination reply was lost',
              };
      const records = input.after === 0 ? [{ ordinal: 1, record }] : [];
      return Response.json({
        source: 'retained-ledger',
        observed_at: '2026-11-08T11:00:00.000Z',
        history: {
          owner,
          collection: input.collection,
          records,
          next: records.length ? 1 : input.after,
        },
      });
    },
  };
}
