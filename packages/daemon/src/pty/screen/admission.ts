/** Only a refused host reservation with unresolved durable admission may yield. */
export class ScreenAdmissionError extends Error {
  constructor(
    message: string,
    readonly waitForAdmission: () => Promise<boolean>,
  ) {
    super(message);
  }
}

export async function admitScreen<T>(
  attempt: () => T,
  active: () => boolean,
  deadline = performance.now() + 5000,
): Promise<T> {
  for (;;) {
    if (!active()) throw new Error('Terminal screen preparation was cancelled');
    try {
      return attempt();
    } catch (error) {
      if (
        !(error instanceof ScreenAdmissionError) ||
        performance.now() >= deadline ||
        !(await error.waitForAdmission())
      )
        throw error;
    }
  }
}
