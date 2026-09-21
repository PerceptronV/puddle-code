import { useEffect, useRef, useState } from 'react';
import {
  desktopRegistrationSchema,
  registrationStatusSchema,
  REMOTE_POLICY,
  type CockpitRemoteRequest,
  type DesktopRegistration,
} from '@puddle/shared';
import { api } from '../../../lib/api';

const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export function useRegistration(
  disabled: boolean,
  enable: (request: CockpitRemoteRequest) => Promise<boolean>,
) {
  const [attempt, setAttempt] = useState<{
    request: DesktopRegistration;
    code: string;
    url: string;
  } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const enableRef = useRef(enable);
  useEffect(() => {
    enableRef.current = enable;
  }, [enable]);
  useEffect(() => {
    if (!attempt) return;
    const timer = setTimeout(
      () => {
        generation.current += 1;
        setAttempt(null);
        setError('Sign-in expired. Try again.');
      },
      Math.max(0, attempt.request.expires - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [attempt]);
  useEffect(() => {
    if (!attempt || disabled) return;
    const current = generation.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (attempt.request.expires <= Date.now()) throw new Error('Sign-in expired. Try again.');
        const { ready } = registrationStatusSchema.parse(
          await api('POST', '/cockpit/remote/registration', {
            service: attempt.request.service,
            code: attempt.code,
          }),
        );
        if (stopped || current !== generation.current) return;
        if (attempt.request.expires <= Date.now()) throw new Error('Sign-in expired. Try again.');
        if (ready) {
          // Clear the verifier before the one-shot mutation. Never retry an uncertain enable.
          setAttempt(null);
          await enableRef.current({
            t: 'enable',
            registration: {
              service: attempt.request.service,
              app: attempt.request.app,
              code: attempt.code,
            },
          });
        } else timer = setTimeout(() => void poll(), 2000);
      } catch (failure) {
        if (stopped || current !== generation.current) return;
        setAttempt(null);
        setError(failure instanceof Error ? failure.message : 'Sign-in failed. Try again.');
      }
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [attempt, disabled]);
  const begin = async (service: string, app: string, label: string) => {
    const current = ++generation.current;
    setPreparing(true);
    setError('');
    try {
      const code = hex(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = hex(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))),
      );
      if (current !== generation.current) return;
      const parsed = desktopRegistrationSchema.safeParse({
        service: service.trim(),
        app: app.trim(),
        label: label.trim(),
        challenge,
        expires: Date.now() + REMOTE_POLICY.invitationMs,
      });
      if (!parsed.success)
        throw new Error('Enter a host name and exact HTTPS application and relay origins.');
      const request = parsed.data;
      const url = `${request.app}/#register=${encodeURIComponent(JSON.stringify(request))}`;
      setAttempt({ request, code, url });
      // Electron opens HTTPS links in the system browser. A visible link also handles popup blocking.
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not start sign-in.');
    } finally {
      setPreparing(false);
    }
  };
  return {
    attempt,
    preparing,
    error,
    begin,
    cancel: () => {
      generation.current += 1;
      setAttempt(null);
    },
  };
}
