import { huddleSourcePaths, tabHoldsFile } from '@puddle/shared';
import { X } from 'lucide-react';
import { LazyEditorTabClose } from '../../editor/lazy-editor-parts';
import { useCurrentProfileId } from '../../profile/profile-store';
import { useRetainedBuffers } from '../../windows/recovery/use-retained-buffers';
import { useEditorCloseRequest } from '../../workspace/tabs/close/TabCloseRequests';

interface Props {
  session: string;
  huddleId?: string;
  label: string;
  closeKey: string;
  onClose(signal?: AbortSignal): void | Promise<boolean>;
}

/** A missing placement must retain the same close policy as an available graph. */
export function HuddleTabClose({ huddleId, ...props }: Props) {
  const drafts = useRetainedBuffers(useCurrentProfileId());
  const paths = huddleId
    ? huddleSourcePaths(huddleId)
    : drafts
        .filter((draft) => tabHoldsFile({ type: 'huddle', session: props.session }, draft))
        .map((draft) => draft.path);
  const path = paths[0];
  return path ? (
    <LazyEditorTabClose {...props} path={path} relatedPaths={paths.slice(1)} kind="file" />
  ) : (
    <EmptyHuddleClose {...props} />
  );
}

function EmptyHuddleClose({ closeKey, label, onClose }: Props) {
  const close = async (signal?: AbortSignal) => {
    if (signal?.aborted) return false;
    return (await onClose(signal)) !== false;
  };
  useEditorCloseRequest(closeKey, close);
  return (
    <button
      type="button"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        void close();
      }}
      className="inline-flex rounded-sm p-0.5 text-fg-muted transition-colors hover:text-fg"
      aria-label={`Close ${label}`}
    >
      <X className="size-3" />
    </button>
  );
}
