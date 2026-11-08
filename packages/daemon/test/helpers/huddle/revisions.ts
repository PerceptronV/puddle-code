import {
  manualHuddleFixture,
  manualComponent,
  resultComponent,
} from '../../../../shared/test/helpers/huddle.js';
import { huddleRevisionDigest } from '../../../src/huddle/definitions/revision.js';
import type { HuddleDefinitionSnapshot } from '../../../src/huddle/definitions/capture.js';
import type { HuddleLedgerFixture } from './ledger.js';

export function revisionFixture(
  f: HuddleLedgerFixture,
  name = 'Retained huddle',
): HuddleDefinitionSnapshot {
  const definition = manualHuddleFixture();
  definition.id = f.identity.huddleId;
  definition.name = name;
  definition.variables['answer'] = {
    schema: { type: 'number' },
    required: true,
    default: 42,
    editor: 'number',
  };
  const files = { 'huddle.json': JSON.stringify(definition) };
  const components = { run: manualComponent, result: resultComponent };
  return {
    format: 1,
    digest: huddleRevisionDigest(files, components),
    definition,
    files,
    components,
    diagnostics: [],
  };
}
