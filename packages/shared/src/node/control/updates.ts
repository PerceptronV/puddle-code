import type { Duplex } from 'node:stream';
import {
  hostUpdateCommandSchema,
  type HostUpdateCommand,
  type HostUpdateReply,
} from '../../api/connection/host-updates.js';
import { HostControlRequests } from './requests.js';

/** The existing host-only update surface shares bounded correlation with maintenance. */
export class HostUpdateRequests extends HostControlRequests<HostUpdateCommand, HostUpdateReply> {
  constructor(channel: Duplex) {
    super(channel, { type: 'host-update', parse: hostUpdateCommandSchema.parse });
  }
}
