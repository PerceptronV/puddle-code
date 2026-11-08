import { useQueries } from '@tanstack/react-query';
import {
  huddleComponentSchema,
  HUDDLE_LIMITS,
  type HuddleDefinition,
  type HuddleComponent,
  type FileResponse,
  type Session,
} from '@puddle/shared';
import { api } from '../../../lib/transport/api';

/** Draft graph references resolve ordinary source files, including after a window transfer. */
export function useLocalHuddleComponents(session: Session, graph: HuddleDefinition | undefined) {
  const paths = [
    ...new Set(
      graph?.nodes.flatMap((node) =>
        node.source.kind === 'local' ? [node.source.manifest] : [],
      ) ?? [],
    ),
  ];
  return useQueries({
    queries: paths.map((manifest) => {
      const path = `.puddle/huddle/${session.huddle_id}/${manifest.replace(/^\.\//, '')}`;
      return {
        queryKey: ['wt-file', session.id, path],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          api<FileResponse>(
            'GET',
            `/api/worktrees/${session.id}/file?path=${encodeURIComponent(path)}`,
            undefined,
            signal,
          ),
        retry: false,
      };
    }),
    combine: (results) => {
      const contracts: Record<string, HuddleComponent | undefined> = {};
      for (const [index, result] of results.entries()) {
        const file = result.data;
        if (!result.isPending) contracts[paths[index]!] = undefined;
        if (file?.content && !file.binary && file.size <= HUDDLE_LIMITS.fileBytes) {
          try {
            contracts[paths[index]!] = huddleComponentSchema.parse(JSON.parse(file.content));
          } catch {
            /* Graph diagnostics expose unresolved contracts. */
          }
        }
      }
      return contracts;
    },
  });
}
