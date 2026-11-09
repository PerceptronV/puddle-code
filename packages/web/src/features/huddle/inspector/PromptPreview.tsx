import { useId, useState } from 'react';
import { formatHuddleInputPrompt, isHuddleJson } from '@puddle/shared';
import { Label } from '../../../components/ui/label';

/** Preview data stays in this inspector; it is never a setting or execution input. */
export function PromptPreview({ template }: { template?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState('null');
  const [sampleTemplate, setSampleTemplate] = useState('');
  let output = '';
  let error: string | undefined;
  if (open) {
    try {
      const input: unknown = JSON.parse(sample);
      if (!isHuddleJson(input)) throw new Error('Sample input exceeds the supported JSON limits');
      output = formatHuddleInputPrompt(template ?? sampleTemplate, input);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Cannot preview this prompt';
    }
  }
  const fieldClass =
    'w-full resize-y rounded-md bg-surface p-2 text-sm text-fg outline-none focus-visible:ring-1 focus-visible:ring-ring';
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer rounded-md px-2 py-1 text-xs hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        Preview prompt
      </summary>
      {open && (
        <div className="flex flex-col gap-2 pt-2">
          <p className="text-xs text-fg-muted">
            Uses standard {'{{input}}'} substitutions with sample data. Custom script formatting may
            differ. Preview data is not saved or sent to an agent.
          </p>
          {template === undefined && (
            <>
              <Label htmlFor={`${id}-template`}>Sample prompt template</Label>
              <textarea
                id={`${id}-template`}
                value={sampleTemplate}
                rows={3}
                maxLength={131072}
                className={fieldClass}
                onChange={(event) => setSampleTemplate(event.target.value)}
              />
              <p className="text-xs text-fg-muted">
                This variable has no text default. Enter a sample template to preview; the host
                resolves the actual variable when starting the huddle.
              </p>
            </>
          )}
          <Label htmlFor={`${id}-input`}>Sample input (JSON)</Label>
          <textarea
            id={`${id}-input`}
            value={sample}
            rows={4}
            maxLength={262144}
            className={fieldClass}
            onChange={(event) => setSample(event.target.value)}
          />
          {error ? (
            <p className="text-xs text-fg-muted" role="status">
              {error}
            </p>
          ) : (
            <pre
              aria-label="Rendered prompt"
              role="region"
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm"
            >
              {output || '(Empty prompt)'}
            </pre>
          )}
        </div>
      )}
    </details>
  );
}
