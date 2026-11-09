import { useMutation } from '@tanstack/react-query';
import {
  huddleInstalledTemplateSchema,
  huddleNodeTemplates,
  supportsApplicationFeature,
  type HuddleInstallTemplate,
  type Session,
} from '@puddle/shared';
import { useDaemonVersion } from '../../../lib/queries/queries';
import { api } from '../../../lib/transport/api';
import { useHuddleSupported } from './queries';

export function useHuddleTemplates(profile: string | undefined, session: Session) {
  const shell = useHuddleSupported();
  const protocol = useDaemonVersion().data?.protocol;
  const supported = shell && supportsApplicationFeature(protocol, { major: 28, minor: 3 });
  const supportsTemplate = (name: HuddleInstallTemplate['template']) =>
    shell &&
    supportsApplicationFeature(protocol, {
      major: 28,
      minor: huddleNodeTemplates.find((item) => item.template === name)!.minor,
    });
  const mutation = useMutation({
    retry: false,
    mutationFn: async (input: Pick<HuddleInstallTemplate, 'template' | 'component'>) => {
      if (!profile || !supportsTemplate(input.template))
        throw new Error('This node template requires a supporting host');
      return huddleInstalledTemplateSchema.parse(
        await api('POST', `/api/huddle/${profile}/definitions/${session.huddle_id}/components`, {
          ...input,
          project_id: session.project_id,
          worktree: session.worktree_path,
        }),
      );
    },
  });
  return { supported, supportsTemplate, ...mutation };
}
