import { useId } from 'react';
import type { HuddleCommandTarget } from '@puddle/shared';
import { Switch } from '../../../components/ui/switch';
import { Label } from '../../../components/ui/label';
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
  const id = useId();
  return (
    <div
      className="flex items-center gap-2"
      title="Recover this run when the host starts after a reboot. Stopped or interrupted huddles stay stopped. A fresh Start defaults off."
    >
      <Switch
        id={id}
        checked={enabled}
        disabled={disabled}
        onCheckedChange={(value) =>
          void send({
            action: 'auto-start',
            input: { target, expected: enabled, enabled: value },
          }).catch(() => {})
        }
      />
      <Label htmlFor={id} className="cursor-pointer text-xs">
        Auto-start after reboot
      </Label>
    </div>
  );
}
