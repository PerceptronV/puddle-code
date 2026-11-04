import type { ConfirmHostUpdateInterruption } from './apply.js';

/** Shared wording; the coordinator binds the actual consent to this exact review. */
export function hostUpdateInterruptionMessage(
  host: string,
  { operation, review }: Parameters<ConfirmHostUpdateInterruption>[0],
): string {
  const { terminals, notebooks, compilation, programmes } = review.affected;
  const targets = operation.targets.map(({ component, version }) => `${component} ${version}`);
  return (
    `Updating ${targets.join(' and ')} on ${host} will interrupt ` +
    `${terminals} daemon-owned terminal(s), ${notebooks} notebook kernel(s), ` +
    `${compilation} compilation task(s) and ${programmes} programme(s).\n\n` +
    'Their shell jobs and in-memory state will be lost. Independently hosted runtimes keep running. ' +
    'Interrupted programmes and uncertain commands will not be replayed.'
  );
}
