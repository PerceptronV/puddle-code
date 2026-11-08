import {
  huddleToolExecutionCommandSchema,
  parseHuddleTriggerReport,
  huddleRuntimeInspectionSchema,
  huddleRunAcceptedSchema,
  huddleStoppedSchema,
  huddleHistoryPageSchema,
  huddleHistoryOwnersSchema,
  parseHuddleRetainedHistory,
  huddleReadoutObserveAcceptedSchema,
  parseHuddleReview,
  parseHuddleRetainedRevision,
  supportsApplicationFeature,
  type HuddleToolExecutionCommand,
} from '@puddle/shared';
import { huddleMutation } from '../mutation.js';

export class HuddleExecutionClient {
  readonly supported: boolean;
  readonly readoutObservation: boolean;
  readonly customTriggers: boolean;
  readonly revisionReview: boolean;
  readonly retainedHistory: boolean;
  readonly retainedRevision: boolean;
  readonly recovery: boolean;
  readonly autoStart: boolean;
  readonly triggerInspection: boolean;
  constructor(
    private readonly request: (path: string, body?: unknown) => Promise<unknown>,
    protocol?: { major: number; minor: number },
  ) {
    this.triggerInspection = supportsApplicationFeature(protocol, { major: 28, minor: 17 });
    this.autoStart = supportsApplicationFeature(protocol, { major: 28, minor: 16 });
    this.recovery = supportsApplicationFeature(protocol, { major: 28, minor: 15 });
    this.supported = supportsApplicationFeature(protocol, { major: 28, minor: 2 });
    this.readoutObservation = supportsApplicationFeature(protocol, { major: 28, minor: 6 });
    this.customTriggers = supportsApplicationFeature(protocol, { major: 28, minor: 7 });
    this.retainedRevision = supportsApplicationFeature(protocol, { major: 28, minor: 13 });
    this.retainedHistory = supportsApplicationFeature(protocol, { major: 28, minor: 12 });
    this.revisionReview = supportsApplicationFeature(protocol, { major: 28, minor: 10 });
  }
  async execute(raw: HuddleToolExecutionCommand) {
    if (!this.supported)
      throw new Error('Huddle runtime tools require compatible daemon protocol 28.2 or newer');
    const command = huddleToolExecutionCommandSchema.parse(raw);
    const path = `/sessions/${command.session_id}`;
    if (command.action === 'retained-revision') {
      if (!this.retainedRevision)
        throw new Error('Retained revision review requires daemon protocol 28.13 or newer');
      return parseHuddleRetainedRevision(
        command.request,
        await this.request(`${path}/revision/retained`, command.request),
      );
    }
    if (command.action === 'history-owners' || command.action === 'retained-history') {
      if (!this.retainedHistory)
        throw new Error('Retained huddle history requires daemon protocol 28.12 or newer');
      return command.action === 'history-owners'
        ? huddleHistoryOwnersSchema.parse(
            await this.request(`${path}/history/owners`, command.request),
          )
        : parseHuddleRetainedHistory(
            command.request,
            await this.request(`${path}/history/retained`, command.request),
          );
    }
    if (command.action === 'revision' || command.action === 'diff') {
      if (!this.revisionReview)
        throw new Error('Huddle revision review requires daemon protocol 28.10 or newer');
      return parseHuddleReview(
        command.request,
        await this.request(`${path}/${command.action}`, command.request),
      );
    }
    if (command.action === 'triggers') {
      if (!this.triggerInspection)
        throw new Error('Trigger inspection requires daemon protocol 28.17 or newer');
      return parseHuddleTriggerReport(
        command.request.target,
        await this.request(`${path}/triggers`, command.request),
      );
    }
    if (command.action === 'runtime') {
      const query = new URLSearchParams();
      if (this.readoutObservation) query.set('include_readout_observation', 'true');
      if (this.customTriggers) query.set('include_custom_triggers', 'true');
      if (this.recovery) query.set('include_recovery', 'true');
      if (this.autoStart) query.set('include_auto_start', 'true');
      if (this.triggerInspection) query.set('include_trigger_inspection', 'true');
      return huddleRuntimeInspectionSchema.parse(
        await this.request(`${path}/runtime${query.size ? '?' + query.toString() : ''}`),
      );
    }
    if (command.action === 'history') {
      if (command.request.include_readout_observation && !this.readoutObservation)
        throw new Error('Readout observation history requires daemon protocol 28.6 or newer');
      return huddleHistoryPageSchema.parse(await this.request(`${path}/history`, command.request));
    }
    if (command.action === 'auto-start' && !this.autoStart)
      throw new Error('Huddle auto-start settings require daemon protocol 28.16 or newer');
    if (command.action === 'recover' && !this.recovery)
      throw new Error('Huddle recovery requires daemon protocol 28.15 or newer');
    if (command.action === 'observe-readout' && !this.readoutObservation)
      throw new Error('Readout observation requires daemon protocol 28.6 or newer');
    const action =
      command.action === 'resume'
        ? 'rearm'
        : command.action === 'observe-readout'
          ? 'readouts/observe'
          : command.action;
    return huddleMutation(
      `Inspect runtime and history for session ${command.session_id} before another action.`,
      async () => {
        const response = await this.request(`${path}/${action}`, command.request);
        if (command.action === 'run') return huddleRunAcceptedSchema.parse(response);
        if (command.action === 'stop') return huddleStoppedSchema.parse(response);
        if (command.action === 'observe-readout')
          return huddleReadoutObserveAcceptedSchema.parse(response);
        return huddleRuntimeInspectionSchema.parse(response);
      },
    );
  }
}
