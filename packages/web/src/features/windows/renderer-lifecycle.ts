import { desktopWindowCommandSchema, type DesktopWindowLifecycleBridge } from '@puddle/shared';

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
): Promise<() => void> {
  let queue = Promise.resolve();
  const unsubscribe = bridge.onCommand((value) => {
    queue = queue
      .then(async () => {
        const command = desktopWindowCommandSchema.parse(value);
        let error: string | undefined;
        try {
          if (command.kind === 'checkpoint') {
            fence(true);
            const results = await Promise.allSettled(
              [...workingSets()].map((workingSet) => workingSet.checkpoint()),
            );
            const failure = results.find((result) => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
          } else {
            for (const workingSet of workingSets()) workingSet.resume();
            fence(false);
          }
        } catch (reason) {
          error = (reason instanceof Error ? reason.message : 'Could not save this window').slice(
            0,
            2048,
          );
        }
        await bridge.reply({ id: command.id, ...(error ? { error } : {}) });
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
