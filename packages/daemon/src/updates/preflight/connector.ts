import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  connectorInspectionResponseSchema,
  type ConnectorInspectionResponse,
  type HostUpdateOperation,
  type HostServiceReplacement,
} from '@puddle/shared';
import { ipcPath, jsonLines, privatePath } from '@puddle/shared/node';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import {
  inspectHostServiceManager,
  inspectRunningService,
} from '../../host/supervision/inspection.js';
import { prepareServiceReplacement } from '../../host/supervision/replacement.js';
import { readInstalledCapabilities } from '@puddle/shared/node/host-control';

type Identity = Omit<ConnectorInspectionResponse, 't' | 'nonce'>;
export interface UpdateConnector {
  identity: Identity | null;
  service?: HostServiceReplacement;
  state: 'not-required' | 'absent' | 'running' | 'unknown';
  blockers: Array<{ code: 'connector_inventory_unknown'; target: 'connector' }>;
}

/** An absent/refused socket is distinct from an old, malformed, slow or unavailable manager. */
export async function inspectConnectorManager(
  home: string,
): Promise<ConnectorInspectionResponse | null> {
  const path = ipcPath(home, 'remote');
  try {
    privatePath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const nonce = randomUUID();
    let settled = false;
    const finish = (error: Error | null, result: ConnectorInspectionResponse | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Connector inspection timed out')), 5000);
    timer.unref();
    const stop = jsonLines(
      socket,
      (value) => {
        const result = connectorInspectionResponseSchema.parse(value);
        if (result.nonce !== nonce) throw new Error('Connector inspection nonce mismatch');
        finish(null, result);
      },
      () => finish(new Error('Invalid connector inspection')),
      16 * 1024,
    );
    socket.on('connect', () => socket.write(JSON.stringify({ t: 'inspect', nonce }) + '\n'));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') finish(null);
      else finish(error);
    });
    socket.on('close', () => finish(new Error('Connector inspection unavailable')));
  });
}

/** Unknown/stopped installations block daemon replacement; runtime-default changes need no connector action. */
export class HostUpdateConnector {
  constructor(
    private readonly home: string,
    private readonly userHome = homedir(),
    private readonly options: {
      platform?: NodeJS.Platform;
      uid?: number;
      run?: CompilationCommandRunner;
    } = {},
  ) {}

  async inspect(operation: HostUpdateOperation): Promise<UpdateConnector> {
    if (!operation.targets.some((target) => target.component === 'daemon'))
      return { identity: null, state: 'not-required', blockers: [] };
    try {
      const response = await inspectConnectorManager(this.home);
      if (!response) {
        // No configuration secrets are read. Any prior registration/installation
        // needs positive inventory, including a disabled or externally supervised one.
        for (const path of [
          join(this.home, 'remote'),
          join(this.userHome, '.config/systemd/user/puddle-connector.service'),
          join(this.userHome, 'Library/LaunchAgents/dev.puddle.connector.plist'),
        ]) {
          try {
            await lstat(path);
            throw new Error('Connector installation needs inspection');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        return { identity: null, state: 'absent', blockers: [] };
      }
      if (!response.ready) throw new Error('Connector manager is not ready');
      const root = await realpath(response.release_path);
      const versions = await realpath(join(this.home, 'bin/versions'));
      if (
        dirname(root) !== versions ||
        root !== response.release_path ||
        response.node_path !== join(root, 'bin/node') ||
        response.entry_path !== join(root, 'daemon/connector.mjs') ||
        (await realpath(response.node_path)) !== join(root, 'bin/node') ||
        (await realpath(response.entry_path)) !== join(root, 'daemon/connector.mjs')
      )
        throw new Error('Connector is not pinned to an installed generation');
      const capabilities = await readInstalledCapabilities(root);
      if (
        capabilities.version !== response.version ||
        capabilities.application.major !== response.application.major ||
        capabilities.application.minor !== response.application.minor ||
        capabilities.remote !== response.remote
      )
        throw new Error('Connector build metadata does not match the running manager');
      const { t: _type, nonce: _nonce, ...identity } = response;
      const manager = await inspectHostServiceManager(this.home, this.options);
      const name = manager.kind === 'systemd' ? 'puddle-connector.service' : 'dev.puddle.connector';
      const observed = await inspectRunningService(
        this.home,
        { ...manager, name },
        identity.pid,
        this.options.run,
      );
      const service = await prepareServiceReplacement(this.home, observed, {
        component: 'connector',
        run: this.options.run,
        definitionPath: join(this.userHome, 'Library/LaunchAgents', `${name}.plist`),
      });
      return { identity, service, state: 'running', blockers: [] };
    } catch {
      return {
        identity: null,
        state: 'unknown',
        blockers: [{ code: 'connector_inventory_unknown', target: 'connector' }],
      };
    }
  }
}
