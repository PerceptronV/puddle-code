import type { DesktopBufferSnapshot } from '@puddle/shared';
import type { ReactNode } from 'react';
import { Button } from '../../../components/ui/button';
import { ControlTray } from '../../../components/ui/control-tray';
import { Textarea } from '../../../components/ui/input';
import { downloadBlob } from '../../../lib/download-blob';

/** Local recovery never recreates a missing host file or executes a saved document. */
export function DraftRecovery({
  draft,
  actions,
}: {
  draft: DesktopBufferSnapshot;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-col gap-2" data-window-draft-recovery>
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm" title={draft.path}>
          {draft.path}
        </span>
        <ControlTray label={`Recovery actions for ${draft.path}`} className="shrink-0">
          <Button
            variant="ghost"
            onClick={() =>
              downloadBlob(
                new Blob([draft.content], { type: 'text/plain;charset=utf-8' }),
                draft.path.split('/').at(-1) || 'recovered-draft.txt',
              )
            }
          >
            Download recovered text
          </Button>
          {actions}
        </ControlTray>
      </div>
      <Textarea
        aria-label={`Recovered text for ${draft.path}`}
        readOnly
        value={draft.content}
        rows={12}
        className="font-mono text-xs"
      />
    </div>
  );
}
