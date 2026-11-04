import { join } from 'node:path';
import { RELEASE_NOTES_MAX_BYTES, releaseNotesSchema, type ReleaseNotes } from '@puddle/shared';
import { resolveInstalledRuntimeRelease } from '../../runtime/lifecycle/release.js';
import { readReleaseText } from './files.js';

declare const __PUDDLE_RELEASE_NOTES__: string | null | undefined;

const bundledNotes =
  typeof __PUDDLE_RELEASE_NOTES__ === 'undefined' ? null : __PUDDLE_RELEASE_NOTES__;

/** Public release content only; never substitute daemon notes for another build. */
export function installedReleaseNotes(
  home: string | undefined,
  version: string,
  daemonNotes: string | null = bundledNotes,
): ReleaseNotes {
  const releases: ReleaseNotes['releases'] = [];
  if (daemonNotes) {
    const running = releaseNotesSchema.safeParse({
      releases: [{ component: 'daemon', version, markdown: daemonNotes }],
    });
    if (running.success) releases.push(...running.data.releases);
  }
  if (home) {
    try {
      const runtime = resolveInstalledRuntimeRelease(home);
      const markdown = readReleaseText(
        join(runtime.releasePath, 'RELEASE_NOTES.md'),
        RELEASE_NOTES_MAX_BYTES,
      );
      const selected = releaseNotesSchema.safeParse({
        releases: [{ component: 'runtime', version: runtime.build, markdown }],
      });
      if (selected.success) releases.push(...selected.data.releases);
    } catch {
      // Legacy/missing/unreadable metadata omits this entry, without host paths.
    }
  }
  return { releases };
}
