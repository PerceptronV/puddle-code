import { useState } from 'react';
import type { HuddleCommandTarget } from '@puddle/shared';
import { graphActionClass } from '../inspector/GraphEditing';
import type { HuddleCommand } from './api';
import { ControlTray } from '../../../components/ui/control-tray';

export function ReadoutObservation({
  operation,
  target,
  disabled,
  send,
  inspect,
}: {
  operation: string;
  target: HuddleCommandTarget;
  disabled: boolean;
  send(command: HuddleCommand): Promise<unknown>;
  inspect(): Promise<void>;
}) {
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1 py-2">
      <p className="text-fg-muted">Check whether the destination received this delivery.</p>
      <ControlTray label="Delivery observation" className="w-fit">
        <button
          type="button"
          className={graphActionClass}
          disabled={disabled || requested}
          onClick={() => {
            setRequested(true);
            setError(null);
            void send({
              action: 'readouts/observe',
              input: { target, operation_id: operation },
            }).catch((error: unknown) => {
              setError(error instanceof Error ? error.message : 'Cannot check delivery');
            });
          }}
        >
          Check delivery
        </button>
        {requested && (
          <button
            type="button"
            className={graphActionClass}
            disabled={disabled}
            onClick={() => {
              void inspect().then(
                () => {
                  setRequested(false);
                  setError(null);
                },
                (error: unknown) => {
                  setError(error instanceof Error ? error.message : 'Cannot inspect delivery');
                },
              );
            }}
          >
            Refresh delivery
          </button>
        )}
      </ControlTray>
      {requested && !error && (
        <p role="status" className="text-fg-muted">
          Check requested. The delivery result will refresh here; the ended graph stays ended.
        </p>
      )}
      {error && (
        <p role="alert" className="text-fg-muted">
          {error}
        </p>
      )}
    </div>
  );
}
