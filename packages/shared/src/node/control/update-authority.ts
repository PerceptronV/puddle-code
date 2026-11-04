import {
  PROTOCOL_VERSION,
  versionResponseSchema,
  parseHostReleaseVersion,
  type VersionResponse,
  type HostUpdateCommand,
  type HostUpdateReply,
} from '../../index.js';

export interface HostUpdateConnectionScope {
  /** Exact identity obtained through trusted local/SSH inspection before connecting. */
  outgoing: Pick<VersionResponse, 'version' | 'protocol'>;
  targetVersion: string;
}

/** Local migration connection, never an application/API compatibility exemption. */
export class HostUpdateOnlyScope {
  private readonly outgoing: HostUpdateConnectionScope['outgoing'];
  private readonly targetVersion: string;
  private target: HostUpdateConnectionScope['outgoing'] | null = null;
  private operation: string | null = null;
  private begun = false;
  private observing = false;
  private adopted = false;

  constructor(input: HostUpdateConnectionScope) {
    const outgoing = versionResponseSchema.parse(input.outgoing);
    const { major, minor } = outgoing.protocol;
    if (
      major >= PROTOCOL_VERSION.major ||
      major < 25 ||
      (major === 25 && minor < 7) ||
      !parseHostReleaseVersion(input.targetVersion)
    )
      throw new Error('Host update migration requires a supported older host and exact target');
    this.outgoing = { version: outgoing.version, protocol: { ...outgoing.protocol } };
    this.targetVersion = input.targetVersion;
  }

  accepts(peer: VersionResponse): boolean {
    const matches = (expected: HostUpdateConnectionScope['outgoing']) =>
      peer.version === expected.version &&
      peer.protocol.major === expected.protocol.major &&
      peer.protocol.minor === expected.protocol.minor;
    if (this.target && this.observing && matches(this.target)) {
      this.adopted = true;
      return true;
    }
    return !this.adopted && matches(this.outgoing);
  }

  before(command: HostUpdateCommand): void {
    if (command.action === 'status') {
      if (command.id && this.operation && command.id !== this.operation)
        throw new Error('Host update migration is bound to another operation');
      return;
    }
    if (this.observing) throw new Error('Accepted host update migration is observation-only');
    if (command.action === 'begin') {
      if (
        this.begun ||
        command.targets.length !== 1 ||
        command.targets[0]?.component !== 'daemon' ||
        command.targets[0].version !== this.targetVersion
      )
        throw new Error('Host update migration requires one exact daemon target without replay');
      this.begun = true;
      return;
    }
    if (
      !this.operation ||
      command.reference.id !== this.operation ||
      !['stage', 'inspect', 'apply', 'cancel'].includes(command.action)
    )
      throw new Error('Host update migration is bound to another operation or action');
    if (
      command.action === 'stage' &&
      (command.receipt.record.component !== 'daemon' ||
        command.receipt.record.version !== this.targetVersion)
    )
      throw new Error('Host update migration stage changed its target');
    if (command.action === 'apply') {
      if (!this.target) throw new Error('Host update migration has no verified staged target');
      // Latch before sending: a lost acknowledgement never permits another mutation.
      this.observing = true;
    }
  }

  observed(reply: HostUpdateReply): void {
    const operation = reply.operation;
    if (!operation) return;
    if (
      (this.operation && operation.id !== this.operation) ||
      operation.targets.length !== 1 ||
      operation.targets[0]?.component !== 'daemon' ||
      operation.targets[0].version !== this.targetVersion
    )
      throw new Error('Host update migration response changed its operation or target');
    this.operation = operation.id;
    const stage = operation.stages.find(({ record }) => record.component === 'daemon');
    if (stage) {
      if (stage.record.version !== this.targetVersion)
        throw new Error('Staged daemon version changed its target');
      if (stage.record.protocol.major !== PROTOCOL_VERSION.major)
        throw new Error('Staged daemon is incompatible with the requesting client');
      const target = { version: stage.record.version, protocol: { ...stage.record.protocol } };
      if (
        this.target &&
        (target.version !== this.target.version ||
          target.protocol.major !== this.target.protocol.major ||
          target.protocol.minor !== this.target.protocol.minor)
      )
        throw new Error('Staged daemon identity changed');
      this.target = target;
    }
    if (operation.dispatch_id) this.observing = true;
  }
}
