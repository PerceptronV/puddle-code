import { useEffect, useSyncExternalStore } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { COMPONENT_LABELS, RELEASE_COMPONENTS } from './markdown/sections';
import { ReleaseNotesPreview } from './markdown/ReleaseNotesPreview';
import { releaseNotesQueue, type ReleaseNotesGroup } from './state/queue';

function Presented({ group }: { group: ReleaseNotesGroup }) {
  useEffect(() => releaseNotesQueue.presented(group), [group]);
  return null;
}

/** Mount once per application shell; all connected hosts feed this single presentation queue. */
export function ReleaseNotesHost({ remote = false }: { remote?: boolean }) {
  const groups = useSyncExternalStore(releaseNotesQueue.subscribe, releaseNotesQueue.snapshot);
  const current = groups[0];
  useEffect(() => {
    if (!__PUDDLE_RELEASE_NOTES__) return;
    const components = remote ? (['cockpit', 'remote'] as const) : (['cockpit'] as const);
    releaseNotesQueue.enqueue(
      'browser',
      components.map((component) => ({
        component,
        version: __PUDDLE_RELEASE_VERSION__,
        markdown: __PUDDLE_RELEASE_NOTES__!,
      })),
    );
  }, [remote]);
  const sections = RELEASE_COMPONENTS.flatMap((component) => {
    const entry = current?.entries.find((value) => value.component === component);
    return entry ? [entry] : [];
  });
  return (
    <Dialog
      open={!!current}
      onOpenChange={(open) => {
        if (!open && current) releaseNotesQueue.dismiss(current);
      }}
    >
      {current && (
        <DialogContent wide className="gap-6">
          <Presented group={current} />
          <DialogHeader>
            <DialogTitle>What’s new in {current.version}</DialogTitle>
            <DialogDescription>
              {sections.map((entry) => COMPONENT_LABELS[entry.component]).join(' · ')} release notes
            </DialogDescription>
          </DialogHeader>
          <nav
            aria-label="Release note sections"
            className="flex flex-wrap gap-x-5 gap-y-2 text-sm"
          >
            {sections.map((entry) => (
              <a
                key={entry.component}
                className="text-fg-muted hover:text-fg"
                href={`#${entry.component}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.currentTarget
                    .closest('[role="dialog"]')
                    ?.querySelector(`#${entry.component}`)
                    ?.scrollIntoView({ block: 'nearest' });
                }}
              >
                {COMPONENT_LABELS[entry.component]}
              </a>
            ))}
          </nav>
          {sections.map((entry) => (
            <section
              key={entry.component}
              id={entry.component}
              aria-label={COMPONENT_LABELS[entry.component]}
            >
              <ReleaseNotesPreview markdown={entry.markdown} />
            </section>
          ))}
        </DialogContent>
      )}
    </Dialog>
  );
}
