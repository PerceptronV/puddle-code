import { useId, useState } from 'react';
import {
  resolveHuddleParameters,
  type HuddleComponent,
  type HuddleDefinition,
  type HuddleNodeDefinition,
} from '@puddle/shared';
import { Label } from '../../../components/ui/label';
import { Disclosure } from '../../../components/ui/disclosure';
import { Textarea } from '../../../components/ui/input';
import { initialHuddleVariables, parseHuddleVariables } from '../execution/forms';

interface Props {
  definition: HuddleDefinition;
  node: HuddleNodeDefinition;
  component: HuddleComponent;
}

export function BindingPreview(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure
      className="py-2"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      summary="Preview bindings"
      summaryClassName="rounded-md px-2 py-1 text-xs hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {open && <Preview {...props} />}
    </Disclosure>
  );
}

function Preview({ definition, node, component }: Props) {
  const id = useId();
  const [text, setText] = useState(() => initialHuddleVariables(definition));
  let rendered: string | undefined;
  let error: string | undefined;
  try {
    rendered = JSON.stringify(
      resolveHuddleParameters(definition, node, component, parseHuddleVariables(definition, text)),
      null,
      2,
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Cannot resolve these settings';
  }
  return (
    <div className="flex flex-col gap-2 pt-2 text-xs">
      <p className="text-fg-muted">
        Current draft settings after Apply setting, using the sample variables below. These samples
        are not saved or used to start a huddle.
      </p>
      <Label htmlFor={id}>Sample variables (JSON)</Label>
      <Textarea
        id={id}
        rows={5}
        maxLength={262144}
        className="font-mono text-xs"
        value={text}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
      />
      {error ? (
        <p role="status" className="whitespace-pre-wrap break-words text-fg-muted">
          {error}
        </p>
      ) : (
        <pre
          role="region"
          aria-label="Resolved node settings"
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words"
        >
          {rendered}
        </pre>
      )}
      <p className="text-fg-muted">
        Resource values are requested selectors. Start or Apply checks the host, worktrees, accounts
        and sessions. Active revision shows the resource bindings captured by a running huddle.
      </p>
    </div>
  );
}
