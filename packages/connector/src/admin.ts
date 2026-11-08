import { profileMutation } from './mutation.js';
import { requireNoHostRemoval } from '@puddle/shared/node/host-control';
import { profileDirectory } from './profile-state.js';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  connectorConfigSchema,
  connectorRegistrationSchema,
  connectorSetupSchema,
  connectorLocalRequestSchema,
  remoteAdminResponseSchema,
  type ConnectorLocalRequest,
  type RemoteAdminResponse,
} from '@puddle/shared';
import {
  atomicPrivateJson,
  ipcPath,
  jsonLines,
  privatePath,
  readPrivateJson,
  syncPrivateDirectory,
} from '@puddle/shared/node';
import { installConnectorSupervisor, supervisorKind } from './supervisor.js';
import { createIdentity } from '@puddle/remote-transport';
import { DeviceStore } from './devices.js';
import { deleteRegistration } from './delete-registration.js';
import {
  checkRetirementCapacity,
  flushRegistrationCleanup,
  retireRegistration,
} from './registration-cleanup.js';

async function exchange(
  home: string,
  request: ConnectorLocalRequest,
  profile: string,
): Promise<RemoteAdminResponse> {
  const path = ipcPath(home, `remote-${profile}`);
  privatePath(path);
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Connector control unavailable'));
    }, 5000);
    const stop = jsonLines(
      socket,
      (value) => {
        const result = remoteAdminResponseSchema.parse(value);
        socket.destroy();
        resolve(result);
      },
      () => {
        socket.destroy();
        reject(new Error('Invalid connector response'));
      },
    );
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(timer);
      stop();
      reject(new Error('Connector control unavailable'));
    });
  });
}
async function requestUnlocked(
  home: string,
  value: unknown,
  profile: string,
  requireCurrent: () => void = () => {},
): Promise<RemoteAdminResponse> {
  requireCurrent();
  profileDirectory(home, profile); // Validate before constructing an IPC name.
  const request = connectorLocalRequestSchema.parse(value);
  let result: RemoteAdminResponse;
  try {
    result = await exchange(home, request, profile);
  } catch (error) {
    requireCurrent();
    const directory = profileDirectory(home, profile);
    if (request.t === 'delete_registration') {
      // A timeout or lost acknowledgement does not prove the live writer has stopped.
      // Only mutate offline when its socket is absent or refuses connections.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
      deleteRegistration(directory);
      await flushRegistrationCleanup(directory);
      return { enabled: false, connected: false };
    }
    const path = join(directory, 'config.json');
    const config = connectorConfigSchema.parse(readPrivateJson(path));
    if (request.t === 'status')
      return { enabled: config.enabled, connected: false, host: config.host };
    if (request.t === 'disable') {
      if (config.enabled)
        atomicPrivateJson(path, { ...config, enabled: false }, { syncDirectory: true });
      else syncPrivateDirectory(directory);
      return { enabled: false, connected: false };
    }
    // Revocation can be made durable with the connector stopped.
    if (request.t === 'revoke' || request.t === 'devices' || request.t === 'maintenance') {
      if (request.t === 'maintenance') {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
      }
      const devices = new DeviceStore(directory);
      try {
        if (request.t === 'revoke') devices.revoke(request.id);
        if (request.t === 'maintenance')
          devices.setMaintenance(request.id, request.enabled, config.account, config.host);
        return { devices: devices.list(config.host) };
      } finally {
        devices.close();
      }
    }
    throw new Error('Start the configured connector before pairing or approving a browser', {
      cause: error,
    });
  }
  requireCurrent();
  if (request.t === 'delete_registration' && !result.error)
    await flushRegistrationCleanup(profileDirectory(home, profile));
  return result;
}
async function configureUnlocked(
  home: string,
  value: unknown,
  profile: string,
): Promise<RemoteAdminResponse> {
  requireNoHostRemoval(home);
  const setup = connectorSetupSchema.parse(value);
  if (setup.managed) supervisorKind(home); // Refuse frontend-bound lifetimes before consuming the code.
  const path = join(profileDirectory(home, profile), 'config.json');
  const existing = existsSync(path) ? connectorConfigSchema.parse(readPrivateJson(path)) : null;
  if (existing?.enabled)
    throw new Error('Remote access is already enabled; disable it before changing registration');
  let config;
  if (setup.code && setup.service && setup.app) {
    if (existing) checkRetirementCapacity(profileDirectory(home, profile), existing);
    const response = await fetch(`${setup.service}/remote/register`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: setup.code }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('Host registration failed or expired');
    if (!response.body) throw new Error('Invalid host registration response');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024) throw new Error('Host registration response is too large');
      chunks.push(chunk);
    }
    const registration = connectorRegistrationSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
    config = { ...registration, service: setup.service, app: setup.app, enabled: true };
  } else if (existing && !setup.service && !setup.app && !setup.code)
    config = { ...existing, enabled: true };
  else
    throw new Error(
      'First registration requires the service origin, application origin and registration code',
    );
  requireNoHostRemoval(home);
  // A new registration has a new service/account/host context. Never carry old
  // approvals or unused invitations across that administrative trust change.
  if (setup.code && existsSync(join(profileDirectory(home, profile), 'devices.db'))) {
    const devices = new DeviceStore(profileDirectory(home, profile));
    try {
      devices.revokeAll();
    } finally {
      devices.close();
    }
  }
  if (setup.code && existing) retireRegistration(profileDirectory(home, profile), existing);
  atomicPrivateJson(path, connectorConfigSchema.parse(config));
  try {
    if (setup.managed) installConnectorSupervisor(home);
  } catch (error) {
    atomicPrivateJson(path, { ...config, enabled: false });
    throw error;
  }
  await flushRegistrationCleanup(profileDirectory(home, profile));
  return { enabled: true, host: config.host, connected: false };
}

/** Local/SSH-only recovery. This operation is absent from the encrypted admin protocol. */
async function resetUnlocked(home: string, profile: string): Promise<void> {
  await requestUnlocked(home, { t: 'disable' }, profile);
  const directory = profileDirectory(home, profile);
  const devices = new DeviceStore(directory);
  try {
    devices.revokeAll();
  } finally {
    devices.close();
  }
  atomicPrivateJson(join(directory, 'identity.json'), [...(await createIdentity())]);
}

export function administrativeRequest(
  home: string,
  value: unknown,
  profile: string,
): Promise<RemoteAdminResponse> {
  const request = connectorLocalRequestSchema.parse(value);
  return request.t === 'status' || request.t === 'devices'
    ? requestUnlocked(home, request, profile)
    : profileMutation(home, profile, () => requestUnlocked(home, request, profile));
}

/** Removal reconciles durable disablement under the same lock as configuration writers. */
export function disableConnectorIfEnabled(
  home: string,
  profile: string,
  requireCurrent: () => void,
): Promise<void> {
  return profileMutation(home, profile, async () => {
    requireCurrent();
    const directory = profileDirectory(home, profile);
    let config;
    try {
      config = connectorConfigSchema.parse(
        readPrivateJson(join(directory, 'config.json'), 64 * 1024),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!config.enabled) {
      syncPrivateDirectory(directory);
      return;
    }
    const result = await requestUnlocked(home, { t: 'disable' }, profile, requireCurrent);
    requireCurrent();
    if (result.error) throw new Error('Could not disable remote access');
  });
}
export function configureConnector(
  home: string,
  value: unknown,
  profile: string,
): Promise<RemoteAdminResponse> {
  return profileMutation(home, profile, () => configureUnlocked(home, value, profile));
}
export function resetConnectorIdentity(home: string, profile: string): Promise<void> {
  return profileMutation(home, profile, () => resetUnlocked(home, profile));
}
