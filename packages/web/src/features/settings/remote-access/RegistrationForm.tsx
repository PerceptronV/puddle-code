import { useState } from 'react';
import {
  cockpitRemoteRequestSchema,
  remoteOriginSchema,
  type CockpitRemoteRequest,
} from '@puddle/shared';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';

export function RegistrationForm({
  service = '',
  app = '',
  busy,
  disabled,
  enable,
}: {
  service?: string;
  app?: string;
  busy: boolean;
  disabled: boolean;
  enable(request: CockpitRemoteRequest): Promise<boolean>;
}) {
  const [serviceOrigin, setServiceOrigin] = useState(service);
  const [appOrigin, setAppOrigin] = useState(app);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const validApp = remoteOriginSchema.safeParse(appOrigin.trim());
  return (
    <form
      className="mt-5 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const request = cockpitRemoteRequestSchema.safeParse({
          t: 'enable',
          registration: { service: serviceOrigin.trim(), app: appOrigin.trim(), code: code.trim() },
        });
        if (!request.success) {
          setError(
            'Enter exact HTTPS origins and the 64-character registration code from your application.',
          );
          return;
        }
        setError('');
        // Registration codes are transient: never place them in a URL, query cache or storage.
        setCode('');
        void enable(request.data);
      }}
    >
      <p className="text-sm text-fg-secondary">
        Use your self-hosted relay and application. In the application, sign in and choose Add a
        host to create a five-minute registration code.
      </p>
      <label className="grid gap-1.5 text-sm">
        Relay origin
        <Input
          type="url"
          required
          value={serviceOrigin}
          onChange={(e) => setServiceOrigin(e.target.value)}
          placeholder="https://relay.example.com"
          autoComplete="off"
          disabled={disabled}
        />
      </label>
      <label className="grid gap-1.5 text-sm">
        Application origin
        <Input
          type="url"
          required
          value={appOrigin}
          onChange={(e) => setAppOrigin(e.target.value)}
          placeholder="https://app.example.com"
          autoComplete="off"
          disabled={disabled}
        />
      </label>
      {validApp.success && (
        <a
          href={validApp.data}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-accent hover:opacity-80"
        >
          Open application to register a host ↗
        </a>
      )}
      <label className="grid gap-1.5 text-sm">
        Registration code
        <Input
          type="password"
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" disabled={disabled || !code || !serviceOrigin || !appOrigin}>
        {busy ? 'Enabling…' : 'Enable remote access'}
      </Button>
    </form>
  );
}
