import { describe, expect, it } from 'vitest';
import {
  compilationSupported,
  compilationSettingsSupported,
  crossFiletreeTransferSupported,
  nativeConversationSyncSupported,
} from '../src/lib/protocol-support';

describe('cross-filetree transfer compatibility gate', () => {
  it('stays disabled until protocol 16.3 is positively identified', () => {
    expect(crossFiletreeTransferSupported(undefined)).toBe(false);
    expect(crossFiletreeTransferSupported({ major: 16, minor: 2 })).toBe(false);
    expect(crossFiletreeTransferSupported({ major: 16, minor: 3 })).toBe(true);
    expect(crossFiletreeTransferSupported({ major: 17, minor: 0 })).toBe(true);
  });
});

describe('compilation compatibility gate', () => {
  it('enables host-side providers from protocol 17.1', () => {
    expect(compilationSupported({ major: 17, minor: 0 })).toBe(false);
    expect(compilationSupported({ major: 17, minor: 1 })).toBe(true);
    expect(compilationSupported({ major: 18, minor: 0 })).toBe(true);
  });

  it('enables per-file command settings from protocol 17.3', () => {
    expect(compilationSettingsSupported({ major: 17, minor: 2 })).toBe(false);
    expect(compilationSettingsSupported({ major: 17, minor: 3 })).toBe(true);
    expect(compilationSettingsSupported({ major: 18, minor: 0 })).toBe(true);
  });
});

describe('native conversation compatibility gate', () => {
  it('enables activation refresh only from protocol 16.4', () => {
    expect(nativeConversationSyncSupported({ major: 16, minor: 3 })).toBe(false);
    expect(nativeConversationSyncSupported({ major: 16, minor: 4 })).toBe(true);
    expect(nativeConversationSyncSupported({ major: 17, minor: 0 })).toBe(true);
  });
});
