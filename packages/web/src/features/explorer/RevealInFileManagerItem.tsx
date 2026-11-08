import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { frontendFileManagerSchema, type FrontendRevealRequest } from '@puddle/shared';
import { ContextMenuItem } from '../../components/ui/context-menu';
import { api } from '../../lib/transport/api';
import { browserTransport } from '../../lib/transport/browser-transport';

/** Mounted only in an open menu; capability discovery is shared across menus. */
export function RevealInFileManagerItem({ path }: { path: string }) {
  const remote = browserTransport();
  const manager = useQuery({
    queryKey: ['frontend-file-manager'],
    queryFn: async () =>
      frontendFileManagerSchema.parse(await api('GET', '/frontend/file-manager')),
    enabled: !remote,
    staleTime: Infinity,
    retry: false,
  });
  if (remote || !manager.data?.name || !path) return null;
  return (
    <ContextMenuItem
      onSelect={() => {
        if (browserTransport()) return;
        void api('POST', '/frontend/file-manager', { path } satisfies FrontendRevealRequest).catch(
          (error: unknown) =>
            toast.error(error instanceof Error ? error.message : 'Could not reveal this path.'),
        );
      }}
    >
      Reveal in {manager.data.name}
    </ContextMenuItem>
  );
}
