import { NODE_ICON_BY_NAME } from '../../appearance/node-icons';
import type { HuddleComponent, PROFILE_ICON_COLOURS } from '@puddle/shared';

export const nodeGroups = [
  { id: 'triggers', title: 'Triggers', colour: 'text-identity-gold', colourKey: 'gold' },
  { id: 'agents', title: 'Agents', colour: 'text-icon-blue', colourKey: 'blue' },
  { id: 'flow', title: 'Logic & data', colour: 'text-icon-violet', colourKey: 'violet' },
  { id: 'readouts', title: 'Readouts', colour: 'text-icon-green', colourKey: 'green' },
] as const satisfies readonly {
  id: string;
  title: string;
  colour: string;
  colourKey: (typeof PROFILE_ICON_COLOURS)[number];
}[];

const icons = {
  manual: 'play',
  interval: 'clock',
  calendar: 'calendar-days',
  date: 'calendar-clock',
  'calendar-date': 'calendar-range',
  filetree: 'folder-tree',
  git: 'git-branch',
  session: 'activity',
  'turn-completed': 'check-check',
  result: 'file-output',
  file: 'file-output',
  prompt: 'message-square',
  review: 'check-check',
  spawn: 'plus',
  resume: 'play',
  restart: 'rotate-ccw',
  'native-prompt': 'message-square',
  'native-review': 'check-check',
  'prompt-spawned': 'message-square',
  'review-spawned': 'check-check',
  transform: 'braces',
  format: 'type',
  condition: 'git-fork',
  merge: 'merge',
  join: 'combine',
};
export function cataloguePresentation(component: HuddleComponent) {
  const group =
    component.category === 'trigger'
      ? 'triggers'
      : component.category === 'readout'
        ? 'readouts'
        : component.id.startsWith('puddle.agent.')
          ? 'agents'
          : 'flow';
  const key = component.id.split('.').at(-1)!;
  const icon =
    icons[key as keyof typeof icons] ??
    (group === 'agents' ? 'message-square' : group === 'triggers' ? 'radio' : 'code');
  return {
    group,
    Icon: NODE_ICON_BY_NAME[icon]!,
    appearance: { icon, colour: nodeGroups.find((item) => item.id === group)!.colourKey },
  };
}
