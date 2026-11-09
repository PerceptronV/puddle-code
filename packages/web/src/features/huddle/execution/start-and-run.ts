import {
  canonicalHuddleJson,
  huddleRunSchema,
  huddleStartSchema,
  type HuddleRun,
  type HuddleStart,
} from '@puddle/shared';
import { tokenStore } from '../../../lib/transport/auth';
import { browserTransport } from '../../../lib/transport/browser-transport';
import { sendHuddleCommand, type HuddleCommand } from './api';
import { reviewHuddleRevision } from './review/api';

export type HuddleExecutionCommand =
  | HuddleCommand
  | {
      action: 'start-and-run';
      input: HuddleStart;
      event: Omit<HuddleRun, 'target'>;
    };

/** One reviewed user action, using existing requests without retries or reconnect queues. */
export async function startAndRunHuddle(
  profile: string,
  session: string,
  command: Extract<HuddleExecutionCommand, { action: 'start-and-run' }>,
) {
  // Validate both halves before starting an owner, including all manual input limits.
  const start = huddleStartSchema.parse(command.input);
  const event = huddleRunSchema.omit({ target: true }).parse(command.event);
  const token = tokenStore.get();
  const transport = browserTransport();
  const checkConnection = () => {
    if (tokenStore.get() !== token || browserTransport() !== transport)
      throw new Error('The connection changed');
  };
  let step: 'start' | 'verify' | 'run' = 'start';
  try {
    const started = await sendHuddleCommand(profile, session, { action: 'start', input: start });
    step = 'verify';
    checkConnection();
    if (started.action !== 'state' || started.value.session_id !== session)
      throw new Error('Start returned another session');
    const owner = started.value.owner;
    if (
      started.value.unresolved ||
      !owner?.connected ||
      owner.stopping ||
      owner.lifecycle !== 'armed' ||
      !owner.target.activationId
    )
      throw new Error('The started graph is not available');
    // Start's inspection must not silently select a different revision or variable set.
    const review = await reviewHuddleRevision(profile, session, { target: owner.target });
    checkConnection();
    if (
      review.active.revision !== start.expected_digest ||
      canonicalHuddleJson(review.active.variables) !== canonicalHuddleJson(start.variables)
    )
      throw new Error('The active revision or variables changed');
    step = 'run';
    const reply = await sendHuddleCommand(profile, session, {
      action: 'run',
      input: { ...event, target: owner.target },
    });
    checkConnection();
    return reply;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'Request failed';
    throw new Error(
      `${step === 'start' ? 'Start was not confirmed; manual input was not sent.' : step === 'verify' ? 'Start succeeded, but manual input was not sent.' : 'Start succeeded; the manual input outcome needs inspection.'} ${detail}`,
      { cause },
    );
  }
}
