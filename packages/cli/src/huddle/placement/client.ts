import {
  huddleRuntimeInspectionSchema,
  huddleToolPlacementCommandSchema,
  huddleToolSessionSchema,
  supportsApplicationFeature,
  type HuddleToolPlacementCommand,
} from '@puddle/shared';
import { huddleMutation } from '../mutation.js';

type Request = (path: string, body?: unknown) => Promise<unknown>;

/** Placement lifecycle uses the same session routes as the sidebar. */
export class HuddlePlacementClient {
  readonly supported: boolean;
  constructor(
    private readonly scopedRequest: Request,
    private readonly sessionRequest: Request | undefined,
    protocol?: { major: number; minor: number },
  ) {
    this.supported =
      !!sessionRequest && supportsApplicationFeature(protocol, { major: 28, minor: 2 });
  }

  async execute(raw: HuddleToolPlacementCommand) {
    if (!this.supported || !this.sessionRequest)
      throw new Error('Huddle placement tools require compatible daemon protocol 28.2 or newer');
    const { action, session_id: id } = huddleToolPlacementCommandSchema.parse(raw);
    // Ordinary session routes are host-wide. First use the huddle route to verify
    // kind and selected profile on the host. Placement UUID, project/profile and
    // definition worktree are immutable; do not infer authority from caller data.
    const scoped = huddleRuntimeInspectionSchema.parse(
      await this.scopedRequest(`/sessions/${id}/runtime`),
    );
    if (scoped.session_id !== id)
      throw new Error('Huddle placement inspection returned another session');
    const read = async (mutation: boolean) => {
      const value = huddleToolSessionSchema.parse(
        await this.sessionRequest!(
          `/${id}${mutation ? '/' + action : ''}`,
          ...(mutation ? [{}] : []),
        ),
      );
      if (value.id !== id) throw new Error('Huddle placement reply returned another session');
      if (action === 'archive' && value.status !== 'archived')
        throw new Error('Huddle archive was not confirmed');
      if (action === 'unarchive' && value.status !== 'exited')
        throw new Error('Stopped huddle unarchive was not confirmed');
      return value;
    };
    if (action === 'session') return read(false);
    return huddleMutation(
      `Inspect session ${id} and its runtime before another placement action.`,
      () => read(true),
    );
  }
}
