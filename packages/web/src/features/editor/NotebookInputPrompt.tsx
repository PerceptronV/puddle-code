import { useState } from 'react';
import type { CompilationFileTarget, NotebookExecution } from '@puddle/shared';
import { api } from '../../lib/api';

export function NotebookInputPrompt({
  source,
  execution,
}: {
  source: CompilationFileTarget;
  execution: NotebookExecution;
}) {
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = execution.input;
  if (!input) return null;
  return (
    <form
      className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        setError(null);
        void api('POST', '/api/notebooks/input', {
          source,
          run_id: execution.id,
          input_id: input.id,
          value,
        })
          .then(() => setValue(''))
          .catch((error: unknown) => {
            setError(error instanceof Error ? error.message : 'Input failed');
            setPending(false);
          });
      }}
    >
      <label className="flex items-center gap-2">
        {input.prompt || 'Kernel input'}
        <input
          autoFocus
          type={input.password ? 'password' : 'text'}
          value={value}
          disabled={pending}
          onChange={(event) => setValue(event.target.value)}
          className="rounded-sm bg-surface px-2 py-1 outline-none"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="cursor-pointer text-fg-secondary hover:text-fg disabled:opacity-40"
      >
        Send
      </button>
      {error && (
        <span role="alert" className="text-danger">
          {error}
        </span>
      )}
    </form>
  );
}
