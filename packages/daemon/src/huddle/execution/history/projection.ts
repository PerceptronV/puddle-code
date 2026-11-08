import {
  huddleExecutionViewSchema,
  huddleInvocationViewSchema,
  huddleOperationViewSchema,
} from '@puddle/shared';
import type { readHuddleHistoryPage } from '../../../runtime/huddle/controller/history.js';

/** Explicit public records are shared by live IPC and retained-file observations. */
export function projectHuddleHistory(
  page: ReturnType<typeof readHuddleHistoryPage> & {
    owner: { runtimeId: string; incarnation: string };
  },
  include_readout_observation = false,
) {
  if (page.collection === 'executions')
    return {
      ...page,
      records: page.records.map(({ ordinal, record }) => ({
        ordinal,
        record: huddleExecutionViewSchema.parse(record),
      })),
    };
  if (page.collection === 'invocations')
    return {
      ...page,
      records: page.records.map(({ ordinal, record }) => ({
        ordinal,
        record: huddleInvocationViewSchema.parse(record),
      })),
    };
  return {
    ...page,
    records: page.records.map(({ ordinal, record }) => ({
      ordinal,
      record: huddleOperationViewSchema.parse({
        ...record,
        ...(include_readout_observation &&
        record.kind === 'readout' &&
        record.consumed &&
        record.state === 'unknown' &&
        typeof record.target === 'object' &&
        record.target !== null &&
        !Array.isArray(record.target) &&
        typeof record.target.support === 'object' &&
        record.target.support !== null &&
        !Array.isArray(record.target.support) &&
        record.target.support.reconciliation === 'observe'
          ? { readout_observation: true }
          : {}),
      }),
    })),
  };
}
