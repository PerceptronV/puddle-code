import { useState } from 'react';
import type { CockpitRemoteRequest } from '@puddle/shared';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { useRegistration } from './use-registration';

export function RegistrationForm({
  service = 'https://charles.waddlelabs.ai',
  app = 'https://puddle.waddlelabs.ai',
  hostName,
  busy,
  disabled,
  enable,
  cancel,
}: {
  service?: string;
  app?: string;
  hostName: string;
  busy: boolean;
  disabled: boolean;
  enable(request: CockpitRemoteRequest): Promise<boolean>;
  cancel?: () => void;
}) {
  const [serviceOrigin, setServiceOrigin] = useState(service);
  const [appOrigin, setAppOrigin] = useState(app);
  const [label, setLabel] = useState(hostName);
  const registration = useRegistration(disabled, enable);
  const locked = disabled || registration.preparing || !!registration.attempt;
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!locked) void registration.begin(serviceOrigin, appOrigin, label);
      }}
    >
      <label className="grid gap-1.5 text-sm">
        Application origin
        <Input
          type="url"
          required
          value={appOrigin}
          onChange={(e) => setAppOrigin(e.target.value)}
          placeholder="https://app.example.com"
          autoComplete="off"
          disabled={locked}
        />
      </label>
      <label className="grid gap-1.5 text-sm">
        Relay origin
        <Input
          type="url"
          required
          value={serviceOrigin}
          onChange={(e) => setServiceOrigin(e.target.value)}
          placeholder="https://relay.example.com"
          autoComplete="off"
          disabled={locked}
        />
      </label>
      <label className="grid gap-1.5 text-sm">
        Host name
        <Input
          required
          maxLength={80}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={locked}
        />
      </label>
      {cancel && (
        <p className="text-xs text-fg-muted">
          Saving a new registration revokes existing browser approvals and invitations.
        </p>
      )}
      {registration.error && (
        <p role="alert" className="text-sm text-danger">
          {registration.error}
        </p>
      )}
      {registration.attempt ? (
        <div className="space-y-3 text-sm">
          <p role="status">
            Confirm this host in your browser. Match request{' '}
            <strong className="font-mono">
              {registration.attempt.request.challenge.slice(0, 8).toUpperCase()}
            </strong>
            . Sign-in expires in five minutes.
          </p>
          <a
            href={registration.attempt.url}
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:opacity-80"
          >
            Continue in browser ↗
          </a>
          <Button type="button" variant="ghost" onClick={registration.cancel}>
            Cancel sign-in
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={locked || !label.trim() || !serviceOrigin || !appOrigin}>
            {busy
              ? 'Enabling…'
              : registration.preparing
                ? 'Preparing sign-in…'
                : 'Sign in and enable'}
          </Button>
          {cancel && (
            <Button type="button" variant="ghost" disabled={locked} onClick={cancel}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </form>
  );
}
