import { homedir } from 'node:os';
import { join } from 'node:path';
import { jsonLines } from '@puddle/shared/node';
import { disableAllProfiles, requireAllProfilesDisabled } from './host/disable.js';
import { continueRemovalDisable } from './host/removal.js';
import { administrativeRequest, configureConnector, resetConnectorIdentity } from './admin.js';
import { inspectConnector } from './inspect.js';
import { startConnectorManager } from './manager.js';
import {
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  connectorProfileSchema,
  connectorAdminSchema,
  connectorConfigureSchema,
} from '@puddle/shared';

const home = process.env.PUDDLE_HOME ?? join(homedir(), '.puddle');
if (process.argv.includes('--version')) {
  // Older installed clients require the legacy capability marker before remote administration.
  process.stdout.write(
    `puddle-connector remote protocol ${REMOTE_PROTOCOL_VERSION}; daemon protocol ${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}; frontend controls 2; legacy cockpit controls 2; delete registration 1; maintenance grants 1\n`,
  );
} else if (process.argv.includes('--disable-all')) {
  await disableAllProfiles(home);
} else if (process.argv.includes('--verify-disabled')) {
  requireAllProfilesDisabled(home);
} else if (process.argv.includes('--continue-removal-disable')) {
  if (process.argv[2] !== '--continue-removal-disable' || process.argv.length !== 4)
    throw new Error('Remote disable continuation requires one removal id');
  await continueRemovalDisable(home, process.argv[3]!);
} else if (
  ['--inspect', '--reset', '--admin', '--configure'].some((flag) => process.argv.includes(flag))
) {
  let used = false;
  const act = async (value: unknown) => {
    if (process.argv.includes('--configure')) {
      const { profile, setup } = connectorConfigureSchema.parse(value);
      return configureConnector(home, setup, profile);
    }
    if (process.argv.includes('--admin')) {
      const { profile, request } = connectorAdminSchema.parse(value);
      return administrativeRequest(home, request, profile);
    }
    const { profile } = connectorProfileSchema.parse(value);
    if (process.argv.includes('--inspect')) return inspectConnector(home, profile);
    await resetConnectorIdentity(home, profile);
    return { enabled: false, connected: false };
  };
  jsonLines(
    process.stdin,
    (value) => {
      if (used) return;
      used = true;
      void act(value)
        .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
        .catch(() => {
          process.stderr.write(
            'Puddle remote: operation failed; refresh status before retrying.\n',
          );
          process.exitCode = 1;
        });
    },
    () => {
      process.exitCode = 1;
    },
  );
} else {
  const connector = await startConnectorManager(home);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void connector.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
