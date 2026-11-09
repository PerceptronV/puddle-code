import { RotateCcw } from 'lucide-react';
import { HuddleAction } from '../controls/HuddleAction';
import type { HuddleCommandTarget } from '@puddle/shared';
import type { HuddleCommand } from './api';

export function AutoStartControl({
  enabled,
  target,
  disabled,
  send,
}: {
  enabled: boolean;
  target: HuddleCommandTarget;
  disabled: boolean;
  send(command: HuddleCommand): Promise<void>;
}) {
  return (
    <HuddleAction
      icon={RotateCcw}
      label="Auto-start after reboot"
      aria-pressed={enabled}
      disabled={disabled}
      title={`Auto-start after reboot: ${enabled ? 'on' : 'off'}. Recover this run when the host starts; stopped or interrupted huddles stay stopped.`}
      onClick={() =>
        void send({
          action: 'auto-start',
          input: { target, expected: enabled, enabled: !enabled },
        }).catch(() => {})
      }
    />
  );
}
