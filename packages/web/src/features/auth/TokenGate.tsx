import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { tokenStore } from '../../lib/auth';

/**
 * Shown when no daemon token is stored (or after a 401 cleared it).
 * Boxless by design (HUMANS.md): text and input sit directly on the ground.
 */
export function TokenGate() {
  const [value, setValue] = useState('');

  return (
    <div className="flex min-h-screen items-center justify-center bg-ground">
      <div className="flex w-full max-w-md flex-col gap-10 px-8 pb-24">
        <h1 className="font-mono text-2xl font-semibold text-fg">puddle</h1>
        <div className="flex flex-col gap-3 text-sm leading-relaxed text-fg-secondary">
          <p>This page needs the daemon&apos;s access token.</p>
          <p>
            Launch the UI with <span className="font-mono text-accent">puddle start</span> and it
            arrives automatically — or paste it from{' '}
            <span className="font-mono text-accent">~/.puddle/token</span> on the machine running
            puddled.
          </p>
        </div>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) tokenStore.set(value.trim());
          }}
        >
          <Input
            placeholder="paste token"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-10 font-mono"
            autoFocus
          />
          <Button type="submit" size="lg" className="self-start px-6" disabled={!value.trim()}>
            Connect
          </Button>
        </form>
      </div>
    </div>
  );
}
