import { describe, expect, it } from 'vitest';
import { crossFiletreeTransferSupported } from '../src/lib/protocol-support';

describe('cross-filetree transfer compatibility gate', () => {
  it('stays disabled until protocol 16.3 is positively identified', () => {
    expect(crossFiletreeTransferSupported(undefined)).toBe(false);
    expect(crossFiletreeTransferSupported({ major: 16, minor: 2 })).toBe(false);
    expect(crossFiletreeTransferSupported({ major: 16, minor: 3 })).toBe(true);
    expect(crossFiletreeTransferSupported({ major: 17, minor: 0 })).toBe(true);
  });
});
