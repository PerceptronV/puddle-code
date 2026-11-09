import { useId, useState } from 'react';
import {
  manualHuddleTrigger,
  huddleHostTrigger,
  type HuddleCommandTarget,
  type HuddleDocument,
  type HuddleReview,
} from '@puddle/shared';
import { RevisionDetails } from './review/RevisionDetails';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../../components/ui/dialog';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { fieldSurface } from '../../../components/ui/recipes';
import { initialHuddleVariables, parseHuddleInput, parseHuddleVariables } from './forms';
import type { HuddleExecutionCommand } from './start-and-run';

export type CommandReview =
  | { kind: 'start'; document: HuddleDocument }
  | { kind: 'start-and-run'; document: HuddleDocument }
  | {
      kind: 'apply' | 'run';
      document?: HuddleDocument;
      target: HuddleCommandTarget;
      comparison?: HuddleReview;
    };

export function CommandDialog({
  review,
  profile,
  session,
  worktree,
  blocked,
  pending,
  error,
  send,
  onClose,
}: {
  review: CommandReview;
  profile: string;
  session: string;
  worktree: string;
  blocked: string | null;
  pending: boolean;
  error: string | null;
  send(command: HuddleExecutionCommand): Promise<void>;
  onClose(): void;
}) {
  const id = useId();
  const [eventId] = useState(() => crypto.randomUUID());
  const triggers =
    review.document?.definition.nodes.filter(
      (node) =>
        huddleHostTrigger(node, review.document?.components[node.id])?.id ===
        manualHuddleTrigger.id,
    ) ?? [];
  const [node, setNode] = useState(triggers[0]?.id ?? '');
  const [text, setText] = useState(() =>
    review.kind === 'run'
      ? 'null'
      : review.kind === 'apply' && review.comparison
        ? JSON.stringify(review.comparison.active.variables, null, 2)
        : review.document
          ? initialHuddleVariables(review.document.definition)
          : '{}',
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [manualText, setManualText] = useState('null');
  const running = review.kind === 'run';
  const combined = review.kind === 'start-and-run';
  const title = running
    ? 'Run huddle'
    : combined
      ? 'Start and run'
      : review.kind === 'start'
        ? 'Start saved graph'
        : 'Apply saved graph';
  const submit = async () => {
    if (blocked || pending) return;
    setFailure(null);
    try {
      if (review.kind === 'run') {
        if (!node.trim()) throw new Error('Choose a manual trigger');
        await send({
          action: 'run',
          input: {
            target: review.target,
            node: node.trim(),
            event_id: eventId,
            data: parseHuddleInput(text),
          },
        });
      } else {
        if (!review.document) throw new Error('Inspect saved source before continuing');
        if (review.document.diagnostics.some((note) => note.severity === 'error'))
          throw new Error('Fix the saved graph validation errors first');
        const input = {
          expected_digest: review.document.digest,
          variables: parseHuddleVariables(review.document.definition, text),
        };
        if (review.kind === 'start-and-run') {
          if (!triggers.some((trigger) => trigger.id === node.trim()))
            throw new Error('Choose a manual trigger from the saved graph');
          await send({
            action: 'start-and-run',
            input,
            event: { node: node.trim(), event_id: eventId, data: parseHuddleInput(manualText) },
          });
        } else
          await send(
            review.kind === 'start'
              ? { action: 'start', input }
              : { action: 'apply', input: { ...input, target: review.target } },
          );
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Cannot send this command');
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        showCloseButton={!pending}
        wide={review.kind === 'apply' && !!review.comparison}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {running
            ? 'Send one input to the active graph. Apply saved edits to use them in future runs.'
            : combined
              ? 'Start the saved revision with these variables, then send one manual input after confirming the active revision. Starting also arms automatic triggers, including past one-off dates set to fire. If either step is uncertain, inspect the outcome before continuing.'
              : 'Use the saved files and the variables below. Unsaved script edits are not included. Start arms automatic triggers; Apply resets their schedules. Both create a new activation, so past one-off dates set to fire may run again. Manual input is sent separately.'}
        </DialogDescription>
        {!running && (
          <div className="space-y-1 text-xs text-fg-muted">
            <p>{review.document?.definition.name}</p>
            <p className="break-all">{worktree}</p>
            <p>Saved revision {review.document?.digest.slice(0, 12)}</p>
            {Object.entries(review.document?.definition.variables ?? {}).map(([name, variable]) => (
              <p key={name}>
                {name}
                {variable.required ? ' · required' : ' · optional'}
                {variable.description ? ` · ${variable.description}` : ''}
              </p>
            ))}
          </div>
        )}
        {review.kind === 'apply' && review.comparison && (
          <RevisionDetails profile={profile} session={session} review={review.comparison} />
        )}
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {(running || combined) && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-node`}>Manual trigger</Label>
              <Input
                id={`${id}-node`}
                value={node}
                disabled={pending}
                list={`${id}-triggers`}
                onChange={(event) => setNode(event.target.value)}
              />
              <datalist id={`${id}-triggers`}>
                {triggers.map((trigger) => (
                  <option key={trigger.id} value={trigger.id} />
                ))}
              </datalist>
              <p className="text-xs text-fg-muted">
                {combined
                  ? 'Choose a manual trigger in this saved revision.'
                  : 'Suggestions come from saved source. Enter an existing trigger id if the active graph differs.'}
              </p>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-json`}>{running ? 'Input (JSON)' : 'Variables (JSON)'}</Label>
            <textarea
              id={`${id}-json`}
              className={`${fieldSurface} min-h-28 resize-y p-2 font-mono text-xs`}
              value={text}
              disabled={pending}
              spellCheck={false}
              onChange={(event) => {
                setText(event.target.value);
                setFailure(null);
              }}
            />
          </div>
          {combined && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-input`}>Input (JSON)</Label>
              <textarea
                id={`${id}-input`}
                className={`${fieldSurface} min-h-28 resize-y p-2 font-mono text-xs`}
                value={manualText}
                disabled={pending}
                spellCheck={false}
                onChange={(event) => {
                  setManualText(event.target.value);
                  setFailure(null);
                }}
              />
            </div>
          )}
          {(blocked || error || failure) && (
            <p role="alert" className="whitespace-pre-wrap break-words text-xs text-fg-muted">
              {combined && error ? error : (blocked ?? error ?? failure)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !!blocked}>
              {pending ? 'Sending…' : running ? 'Send input' : title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
