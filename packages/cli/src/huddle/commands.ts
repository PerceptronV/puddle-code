import {
  huddleToolDefinitionSchema,
  huddleToolLocationSchema,
  type HuddleLocation,
  type HuddleOpen,
} from '@puddle/shared';
import type { HuddleClient } from './client.js';

export const huddleHelp = `  pudl huddle list --project ID --worktree /absolute/host/worktree
  pudl huddle inspect <huddle-id> --project ID --worktree /absolute/host/worktree
  pudl huddle validate <huddle-id> --project ID --worktree /absolute/host/worktree

Connection: --host user@host --profile name-or-id
All paths refer to the selected execution host. Output is JSON. Validation exits
1 for graph errors; source/connection errors go to stderr and also exit 1.
These commands inspect saved source only: no scripts, provider calls or activation.
`;

export type HuddleCommand =
  { action: 'list'; input: HuddleLocation } | { action: 'inspect' | 'validate'; input: HuddleOpen };

/** Validate before opening local authority or an SSH transport. */
export function parseHuddleCommand(
  args: string[],
  options: { project?: string; worktree?: string },
): HuddleCommand {
  const [action, id] = args;
  const location = { project_id: options.project, worktree: options.worktree };
  if (action === 'list' && args.length === 1)
    return { action, input: huddleToolLocationSchema.parse(location) };
  if ((action === 'inspect' || action === 'validate') && args.length === 2)
    return { action, input: huddleToolDefinitionSchema.parse({ ...location, huddle_id: id }) };
  throw new Error(huddleHelp);
}

export async function runHuddleCommand(
  client: Pick<HuddleClient, 'list' | 'inspect' | 'validate'>,
  command: HuddleCommand,
  print: (value: unknown) => void,
): Promise<number> {
  if (command.action === 'list') print(await client.list(command.input));
  else if (command.action === 'inspect') print(await client.inspect(command.input));
  else {
    const result = await client.validate(command.input);
    print(result);
    return result.valid ? 0 : 1;
  }
  return 0;
}
