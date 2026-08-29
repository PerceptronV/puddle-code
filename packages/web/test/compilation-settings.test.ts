import { describe, expect, it } from 'vitest';
import { commandDraft, commandOverride } from '../src/features/editor/compilation-settings';

const slot = {
  mode: 'on_demand' as const,
  run_when: 'when_clicked' as const,
  default_command: 'latexmk {{source}}',
  override_command: null,
};

describe('compilation command drafts', () => {
  it('starts from an override, then a provider default', () => {
    expect(commandDraft(slot)).toBe('latexmk {{source}}');
    expect(commandDraft({ ...slot, override_command: 'tectonic {{source}}' })).toBe(
      'tectonic {{source}}',
    );
  });

  it('stores custom text and clears a redundant default override', () => {
    expect(commandOverride(slot, ' custom {{source}} ')).toBe('custom {{source}}');
    expect(
      commandOverride({ ...slot, override_command: 'custom {{source}}' }, 'latexmk {{source}}'),
    ).toBeNull();
  });
});
