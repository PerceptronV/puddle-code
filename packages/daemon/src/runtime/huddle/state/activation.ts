import {
  canonicalHuddleJson,
  huddleControlStateSchema,
  huddleRevisionActivationSchema,
  type HuddleRevisionActivation,
  type HuddleControlState,
} from '@puddle/shared';
import { HuddleStateDatabase, stateJson } from './database.js';

/** Exact activation/control transactions; subscription hand-off belongs to the lifecycle caller. */
export class HuddleActivations {
  constructor(private readonly db: HuddleStateDatabase) {}

  current(): HuddleControlState {
    const row = this.db.get('control', 'current');
    return row
      ? huddleControlStateSchema.parse(JSON.parse(row.body))
      : { generation: 0, activationId: null, state: 'stopped', autoStart: false };
  }
  get(id: string): HuddleRevisionActivation {
    const row = this.db.get('revision-activations', id);
    if (!row) throw new Error('Huddle activation does not exist');
    return huddleRevisionActivationSchema.parse(JSON.parse(row.body));
  }

  /** Caller has published and validated the bundle and resolved host resources before entering. */
  apply(
    input: Omit<HuddleRevisionActivation, 'appliedAt'>,
    expectedGeneration: number,
    now = Date.now(),
  ) {
    const record = huddleRevisionActivationSchema.parse({ ...input, appliedAt: now });
    return this.db.atomic(() => {
      if (this.db.get('revision-activations', record.id)) {
        const original = this.get(record.id);
        const fingerprint = (value: HuddleRevisionActivation) =>
          canonicalHuddleJson(stateJson({ ...value, appliedAt: undefined }));
        if (fingerprint(original) !== fingerprint(record))
          throw new Error('Activation id conflicts with retained intent');
        return { activation: original, control: this.current(), duplicate: true };
      }
      const current = this.current();
      if (current.generation !== expectedGeneration)
        throw new Error('Huddle control changed before activation');
      this.db.put('revision-activations', record.id, record.revision, 'retained', record);
      const control = this.save({
        ...current,
        activationId: record.id,
        generation: current.generation + 1,
      });
      return { activation: record, control, duplicate: false };
    });
  }

  setIntent(expectedGeneration: number, state: HuddleControlState['state'], autoStart: boolean) {
    return this.db.atomic(() => {
      const current = this.current();
      if (current.generation !== expectedGeneration)
        throw new Error('Huddle control changed before lifecycle intent');
      if (state === 'armed' && !current.activationId)
        throw new Error('Activate a source revision before arming');
      return this.save({ ...current, generation: current.generation + 1, state, autoStart });
    });
  }

  private save(input: HuddleControlState) {
    const control = huddleControlStateSchema.parse(input);
    this.db.put('control', 'current', '', control.state, control, {
      bytes: control.state === 'armed' ? 128 : 0,
    });
    return control;
  }
}
