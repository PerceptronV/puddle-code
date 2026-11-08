import {
  huddleToolDefinitionSchema,
  huddleToolLocationSchema,
  huddleToolCreateSchema,
  huddleToolExecutionCommandSchema,
  huddleExecutionToolSchemas,
  huddleToolPlacementCommandSchema,
  type HuddleLocation,
  type HuddleOpen,
  type HuddleCreate,
  type HuddleToolExecutionCommand,
  type HuddleToolPlacementCommand,
} from '@puddle/shared';
import type { HuddleClient } from './client.js';

export const huddleHelp = `  pudl huddle list --project ID --worktree /absolute/host/worktree
  pudl huddle inspect <huddle-id> --project ID --worktree /absolute/host/worktree
  pudl huddle validate <huddle-id> --project ID --worktree /absolute/host/worktree
  pudl huddle create --name NAME --project ID --worktree /absolute/host/worktree
  pudl huddle open <huddle-id> --project ID --worktree /absolute/host/worktree
  pudl huddle runtime <session-id>
  pudl huddle session|archive|unarchive <session-id>
  pudl huddle start|apply|run|interrupt|resume|stop <session-id> --request JSON
  pudl huddle history|observe-readout <session-id> --request JSON
  pudl huddle revision|diff <session-id> --request JSON

Connection: --host user@host --profile name-or-id
All paths refer to the selected execution host. Output is JSON. Validation exits
1 for graph errors; source/connection errors go to stderr and also exit 1.
Create/open save source/placements without activation; open returns session.id.
Runtime commands use that placement's declared worktree. Start/Apply require an
explicit expected_digest and variables; Apply and later mutations require the
exact target from runtime inspection. Run also requires node, event_id and data.
History requires owner, collection, after and parent for invocations/operations.
Pass the existing HTTP request body as JSON; no targets, variables or event ids
are filled automatically. Start/Apply/Resume arm triggers and may execute code.
Never retry a failed mutation automatically: inspect runtime/history first.
Archive stops the placement's current owner before hiding it; it is not bound to
a reviewed runtime target. Unarchive leaves it stopped. Neither deletes source
or worktrees. Use session to inspect archive status, including after lost replies.
Revision requires target; diff also requires expected_digest from saved source.
Both are read-only (host 28.10+). Add entry: {kind: "file"|"component", path: "..."}
to read exact retained/before-and-after text; otherwise get the change inventory.
`;

export type HuddleCommand =
  | { action: 'list'; input: HuddleLocation }
  | { action: 'inspect' | 'validate' | 'open'; input: HuddleOpen }
  | { action: 'create'; input: HuddleCreate }
  | { action: 'placement'; command: HuddleToolPlacementCommand }
  | { action: 'execution'; command: HuddleToolExecutionCommand };

/** Validate before opening local authority or an SSH transport. */
export function parseHuddleCommand(
  args: string[],
  options: { project?: string; worktree?: string; name?: string; request?: string },
): HuddleCommand {
  const [action, id] = args;
  if (action === 'session' || action === 'archive' || action === 'unarchive') {
    if (args.length !== 2 || Object.values(options).some((value) => value !== undefined))
      throw new Error(huddleHelp);
    return {
      action: 'placement',
      command: huddleToolPlacementCommandSchema.parse({ action, session_id: id }),
    };
  }
  if (action && Object.hasOwn(huddleExecutionToolSchemas, action)) {
    if (
      args.length !== 2 ||
      options.project !== undefined ||
      options.worktree !== undefined ||
      options.name !== undefined
    )
      throw new Error(huddleHelp);
    return {
      action: 'execution',
      command: huddleToolExecutionCommandSchema.parse({
        action,
        session_id: id,
        ...(options.request === undefined ? {} : { request: JSON.parse(options.request) }),
      }),
    };
  }
  if (options.request !== undefined || (action !== 'create' && options.name !== undefined))
    throw new Error(huddleHelp);
  const location = { project_id: options.project, worktree: options.worktree };
  if (action === 'create' && args.length === 1)
    return { action, input: huddleToolCreateSchema.parse({ ...location, name: options.name }) };
  if (action === 'list' && args.length === 1)
    return { action, input: huddleToolLocationSchema.parse(location) };
  if ((action === 'inspect' || action === 'validate' || action === 'open') && args.length === 2)
    return { action, input: huddleToolDefinitionSchema.parse({ ...location, huddle_id: id }) };
  throw new Error(huddleHelp);
}

export async function runHuddleCommand(
  client: Pick<
    HuddleClient,
    'list' | 'inspect' | 'validate' | 'create' | 'open' | 'execution' | 'placement'
  >,
  command: HuddleCommand,
  print: (value: unknown) => void,
): Promise<number> {
  if (command.action === 'list') print(await client.list(command.input));
  else if (command.action === 'inspect') print(await client.inspect(command.input));
  else if (command.action === 'open') print(await client.open(command.input));
  else if (command.action === 'create') print(await client.create(command.input));
  else if (command.action === 'execution') print(await client.execution.execute(command.command));
  else if (command.action === 'placement') print(await client.placement.execute(command.command));
  else {
    const result = await client.validate(command.input);
    print(result);
    return result.valid ? 0 : 1;
  }
  return 0;
}
