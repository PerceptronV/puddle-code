import type { ComponentLogger, Logger } from '@libp2p/interface';

// Never allow DEBUG or browser localStorage to enable transport diagnostics.
const quiet: Logger = Object.assign(() => {}, {
  error: () => {},
  trace: () => {},
  enabled: false,
  newScope: (): Logger => quiet,
});
export const privateLogger: ComponentLogger = { forComponent: () => quiet };
