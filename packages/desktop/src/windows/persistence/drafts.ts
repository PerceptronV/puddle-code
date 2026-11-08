import type { DesktopWorkspaceContent } from '@puddle/shared';

export function bufferIdentity(buffer: DesktopWorkspaceContent['buffers'][number]): string {
  return JSON.stringify([buffer.session, buffer.path, buffer.root ?? null]);
}

export function assertDraftsRetained(
  before: DesktopWorkspaceContent,
  after: DesktopWorkspaceContent[],
): void {
  for (const buffer of before.buffers) {
    if (
      !after.some((content) =>
        content.buffers.some(
          (next) =>
            bufferIdentity(next) === bufferIdentity(buffer) &&
            next.content === buffer.content &&
            next.baseMtimeMs === buffer.baseMtimeMs,
        ),
      )
    )
      throw new Error('Window transfer would discard an unsaved buffer');
  }
}
