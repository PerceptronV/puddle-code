import {
  desktopWindowCommandSchema,
  type DesktopWindowLifecycleBridge,
  type DesktopPaneFocus,
  type DesktopWindowTransferCommand,
  type DesktopWorkspaceVersion,
  type DesktopContentMoveCommand,
  type DesktopProjectCommand,
} from '@puddle/shared';

interface WorkingSetCheckpoint {
  checkpoint(): Promise<void>;
  resume(): void;
}

/** Keep the interaction fence until main either closes the window or cancels. */
export async function registerRendererLifecycle(
  bridge: DesktopWindowLifecycleBridge,
  workingSets: () => Iterable<WorkingSetCheckpoint>,
  fence: (active: boolean) => void,
  reportError: (error: unknown) => void,
  activate?: (request: DesktopPaneFocus) => Promise<void>,
  transfer?: (
    command: DesktopWindowTransferCommand,
  ) => Promise<DesktopWorkspaceVersion | undefined>,
  move?: (command: DesktopContentMoveCommand) => void,
  project?: (command: DesktopProjectCommand) => void,
): Promise<() => void> {
  let queue = Promise.resolve();
  const unsubscribe = bridge.onCommand((value) => {
    queue = queue
      .then(async () => {
        const command = desktopWindowCommandSchema.parse(value);
        let error: string | undefined;
        let version: DesktopWorkspaceVersion | undefined;
        try {
          if (command.kind === 'checkpoint') {
            fence(true);
            const results = await Promise.allSettled(
              [...workingSets()].map((workingSet) => workingSet.checkpoint()),
            );
            const failure = results.find((result) => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
          } else if (command.kind === 'activate-tab') {
            if (!activate) throw new Error('This window cannot activate the requested tab');
            await activate(command);
          } else if (command.kind === 'resume') {
            for (const workingSet of workingSets()) workingSet.resume();
            fence(false);
          } else if (command.kind === 'navigate-project' || command.kind === 'open-project') {
            if (!project) throw new Error('Project window navigation is unavailable');
            project(command);
          } else if (command.kind === 'move-pane' || command.kind === 'move-tab') {
            if (!move) throw new Error('This window cannot move the requested pane');
            // Acknowledge dispatch, not completion: a successful move may retire
            // this renderer. The handoff itself retains its durable outcome.
            move(command);
          } else {
            if (!transfer) throw new Error('This window cannot receive a transfer');
            version = await transfer(command);
          }
        } catch (reason) {
          error = (reason instanceof Error ? reason.message : 'Could not save this window').slice(
            0,
            2048,
          );
        }
        await bridge.reply({
          id: command.id,
          ...(error ? { error } : {}),
          ...(version ? { version } : {}),
        });
      })
      .catch(reportError);
  });
  try {
    await bridge.ready();
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return unsubscribe;
}
