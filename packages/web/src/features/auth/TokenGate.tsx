import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { tokenStore } from '../../lib/auth';

/** Shown when no daemon token is stored (or after a 401 cleared it). */
export function TokenGate() {
  const [value, setValue] = useState('');

  return (
    <div className="flex min-h-screen items-center justify-center bg-ground p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-6">
        <h1 className="font-mono text-xl font-semibold text-fg">puddle</h1>
        <p className="mt-2 text-sm text-fg-secondary">
          This page needs the daemon&apos;s access token. Launch the UI with
          <code className="mx-1 rounded bg-elevated px-1.5 py-0.5 font-mono text-xs text-accent">
            puddle start
          </code>
          and it arrives automatically — or paste it from
          <code className="mx-1 rounded bg-elevated px-1.5 py-0.5 font-mono text-xs text-accent">
            ~/.puddle/token
          </code>
          on the machine running puddled.
        </p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) tokenStore.set(value.trim());
          }}
        >
          <Input
            placeholder="paste token"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="font-mono"
            autoFocus
          />
          <Button type="submit" disabled={!value.trim()}>
            Connect
          </Button>
        </form>
      </div>
    </div>
  );
}
