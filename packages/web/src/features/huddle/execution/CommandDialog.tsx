import { useId, useState } from 'react';
import { manualHuddleTrigger, type HuddleCommandTarget, type HuddleDocument } from '@puddle/shared';
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
import type { HuddleCommand } from './api';

export type CommandReview =
  | { kind: 'start'; document: HuddleDocument }
  | { kind: 'apply' | 'run'; document?: HuddleDocument; target: HuddleCommandTarget };

export function CommandDialog({
  review,
  worktree,
  blocked,
  pending,
  error,
  send,
  onClose,
}: {
  review: CommandReview;
  worktree: string;
  blocked: string | null;
  pending: boolean;
  error: string | null;
  send(command: HuddleCommand): Promise<void>;
  onClose(): void;
}) {
  const id = useId();
  const [eventId] = useState(() => crypto.randomUUID());
  const triggers =
    review.document?.definition.nodes.filter(
      (node) => node.source.kind === 'builtin' && node.source.component === manualHuddleTrigger.id,
    ) ?? [];
  const [node, setNode] = useState(triggers[0]?.id ?? '');
  const [text, setText] = useState(() =>
    review.kind === 'run'
      ? 'null'
      : review.document
        ? initialHuddleVariables(review.document.definition)
        : '{}',
  );
  const [failure, setFailure] = useState<string | null>(null);
  const running = review.kind === 'run';
  const title = running
    ? 'Run huddle'
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
      <DialogContent showCloseButton={!pending}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {running
            ? 'Send one input to the active graph. Apply saved edits to use them in future runs.'
            : 'Use the saved files and the variables below. Unsaved script edits are not included. Starting does not send input.'}
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
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {running && (
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
                Suggestions come from saved source. Enter an existing trigger id if the active graph
                differs.
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
          {(blocked || error || failure) && (
            <p role="alert" className="whitespace-pre-wrap break-words text-xs text-fg-muted">
              {blocked ?? error ?? failure}
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
