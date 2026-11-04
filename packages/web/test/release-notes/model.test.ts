import { describe, expect, it } from 'vitest';
import {
  localReleaseHostKey,
  ReleaseNotesQueue,
} from '../../src/features/release-notes/state/queue';
import { ReleaseNotesSeen } from '../../src/features/release-notes/state/seen';
import { releaseSection } from '../../src/features/release-notes/markdown/sections';

const markdown = `# Changelog
## 0.4.0
### Cockpit
Browser changes.
### Daemon
Host changes.
#### Recovery
More detail.
### Runtime
Owner changes.
### Remote
Remote changes.
`;
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
function fixture() {
  const saved = storage();
  const queue = new ReleaseNotesQueue(new ReleaseNotesSeen(() => saved));
  const notes = [
    { component: 'daemon' as const, version: '0.4.0', markdown },
    { component: 'runtime' as const, version: '0.4.0', markdown },
  ];
  return { saved, queue, notes };
}

describe('installed release presentation', () => {
  it('opens first-use notes once and persists presentation across reconnects and new mounts', () => {
    const { saved, queue, notes } = fixture();
    queue.enqueue('host-a', notes);
    expect(queue.snapshot()).toHaveLength(1);
    const shown = queue.snapshot()[0]!;
    expect(shown.entries.map((entry) => entry.component)).toEqual(['daemon', 'runtime']);
    queue.presented(shown);
    queue.enqueue('host-a', notes);
    expect(queue.snapshot()).toHaveLength(1);
    queue.dismiss(shown);
    queue.enqueue('host-a', notes);
    expect(queue.snapshot()).toEqual([]);
    const reopened = new ReleaseNotesQueue(new ReleaseNotesSeen(() => saved));
    reopened.enqueue('host-a', notes);
    expect(reopened.snapshot()).toEqual([]);
  });

  it('does not mark queued later versions as viewed before they render', () => {
    const { saved, queue, notes } = fixture();
    queue.enqueue('host-a', [notes[0]!, { ...notes[1]!, version: '0.4.1' }]);
    queue.presented(queue.snapshot()[0]!);
    const reopened = new ReleaseNotesQueue(new ReleaseNotesSeen(() => saved));
    reopened.enqueue('host-a', [notes[0]!, { ...notes[1]!, version: '0.4.1' }]);
    expect(reopened.snapshot().map((group) => group.version)).toEqual(['0.4.1']);
  });

  it('merges delayed installed sections into an already rendered cockpit release', () => {
    const { queue, notes } = fixture();
    queue.enqueue('browser', [{ ...notes[0]!, component: 'cockpit' }]);
    queue.presented(queue.snapshot()[0]!);
    queue.enqueue('host-a', notes);
    expect(queue.snapshot()).toHaveLength(1);
    expect(queue.snapshot()[0]!.entries.map((entry) => entry.component)).toEqual([
      'cockpit',
      'daemon',
      'runtime',
    ]);
    expect(queue.snapshot()[0]!.entries[1]!.markdown).not.toContain('Owner changes');
  });

  it('scopes daemon/runtime versions to a stable host while cockpit is browser-wide', () => {
    const { queue, notes } = fixture();
    queue.enqueue('host-a', [...notes, { ...notes[0]!, component: 'cockpit' }]);
    queue.dismiss(queue.snapshot()[0]!);
    queue.enqueue('host-b', [...notes, { ...notes[0]!, component: 'cockpit' }]);
    expect(queue.snapshot()[0]!.entries.map((entry) => entry.component)).toEqual([
      'daemon',
      'runtime',
    ]);
    const host = { username: 'alice', hostname: 'server', home: '/home/alice' };
    expect(localReleaseHostKey({ ...host, displayName: 'New label' })).toBe(
      localReleaseHostKey(host),
    );
    expect(localReleaseHostKey({ ...host, home: '/other/alice' })).not.toBe(
      localReleaseHostKey(host),
    );
  });

  it('does not reopen a previously presented release after upgrade and downgrade', () => {
    const { queue, notes } = fixture();
    for (const version of ['0.4.0', '0.4.1']) {
      queue.enqueue('host-a', [{ ...notes[0]!, version }]);
      queue.dismiss(queue.snapshot()[0]!);
    }
    queue.enqueue('host-a', notes.slice(0, 1));
    expect(queue.snapshot()).toEqual([]);
  });

  it('never stacks host dialogs and never loses a section arriving during dismissal', () => {
    const { queue, notes } = fixture();
    queue.enqueue('host-a', [notes[0]!]);
    const old = queue.snapshot()[0]!;
    queue.enqueue('host-b', notes);
    expect(queue.snapshot()).toHaveLength(1);
    queue.dismiss(old);
    expect(queue.snapshot()[0]!.entries).toHaveLength(2);
  });

  it('presents differing same-version component documents separately before marking them seen', () => {
    const { saved, queue, notes } = fixture();
    const other = { ...notes[0]!, markdown: '### Daemon\nDifferent local build.' };
    queue.enqueue('host-a', [notes[0]!]);
    queue.enqueue('host-b', [other]);
    expect(queue.snapshot()).toHaveLength(2);
    queue.presented(queue.snapshot()[0]!);
    const reopened = new ReleaseNotesQueue(new ReleaseNotesSeen(() => saved));
    reopened.enqueue('host-b', [other]);
    expect(reopened.snapshot()[0]!.entries[0]!.markdown).toContain('Different local build');
  });

  it('keeps document-memory deduplication when browser storage is blocked', () => {
    const queue = new ReleaseNotesQueue(
      new ReleaseNotesSeen(() => {
        throw new Error('denied');
      }),
    );
    const note = { component: 'runtime' as const, version: '0.4.0', markdown };
    queue.enqueue('host-a', [note]);
    queue.dismiss(queue.snapshot()[0]!);
    queue.enqueue('host-a', [note]);
    expect(queue.snapshot()).toEqual([]);
  });

  it('leaves missing component notes unseen so later available metadata can present them', () => {
    const { queue, notes } = fixture();
    queue.enqueue('host-a', [{ ...notes[0]!, markdown: '### Runtime\nOwner only.' }]);
    expect(queue.snapshot()).toEqual([]);
    queue.enqueue('host-a', notes.slice(0, 1));
    expect(queue.snapshot()).toHaveLength(1);
  });
});

describe('component Markdown sections', () => {
  it('keeps nested details but excludes all neighbouring components and release headings', () => {
    expect(releaseSection(markdown, 'daemon')).toBe(
      '### Daemon\nHost changes.\n#### Recovery\nMore detail.',
    );
  });
  it('ignores section-looking text inside fenced examples and HTML comments', () => {
    expect(
      releaseSection(
        '```md\n### Daemon\nnot a section\n```\n<!--\n### Daemon\n-->\n### Runtime\nActual',
        'daemon',
      ),
    ).toBeNull();
  });
  it('accepts component heading anchors without selecting unrelated headings', () => {
    expect(
      releaseSection('<a id="daemon"></a>\n### Daemon\nActual\n### Remote\nOther', 'daemon'),
    ).toContain('Actual');
  });
});
