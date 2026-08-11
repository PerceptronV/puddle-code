import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNTITLED_SESSION } from '@puddle/shared';
import { requestActiveTabSave } from '../src/features/editor/active-tab-save';
import { registerSaver, saverKey } from '../src/features/editor/save-registry';
import {
  forgetUntitledContent,
  publishUntitledContent,
  setUntitledSaveHandler,
} from '../src/features/editor/untitled-save-store';

afterEach(() => {
  setUntitledSaveHandler(null);
  forgetUntitledContent('untitled-1.md');
});

describe('requestActiveTabSave', () => {
  it('saves only the ordinary file tab it is given', () => {
    const envSave = vi.fn();
    const otherSave = vi.fn();
    const saveAs = vi.fn();
    const removeEnv = registerSaver(saverKey('session', '.env'), envSave);
    const removeOther = registerSaver(saverKey('session', 'other.ts'), otherSave);
    setUntitledSaveHandler(saveAs);
    publishUntitledContent('untitled-1.md', 'draft');

    expect(requestActiveTabSave({ session: 'session', path: '.env' })).toBe(true);
    expect(envSave).toHaveBeenCalledOnce();
    expect(otherSave).not.toHaveBeenCalled();
    expect(saveAs).not.toHaveBeenCalled();

    removeEnv();
    removeOther();
  });

  it('opens save-as only when the active tab itself is untitled', () => {
    const saveAs = vi.fn();
    setUntitledSaveHandler(saveAs);
    publishUntitledContent('untitled-1.md', 'draft');

    expect(
      requestActiveTabSave({
        kind: 'untitled',
        session: UNTITLED_SESSION,
        path: 'untitled-1.md',
      }),
    ).toBe(true);
    expect(saveAs).toHaveBeenCalledWith({ name: 'untitled-1.md', content: 'draft' });
  });
});
