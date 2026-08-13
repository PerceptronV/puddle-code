import type * as Monaco from 'monaco-editor';
import {
  createAnimationFramePublisher,
  normalisedScrollRatio,
  previewScrollStore,
  scrollTopForRatio,
  type PreviewScrollBinding,
  type PreviewScrollPosition,
} from './preview-scroll-store';

/**
 * Monaco counterpart of the DOM scroll binding. Although locked v1 surfaces
 * render Markdown/HTML, retaining the receive path here keeps the proportional
 * maths reusable when a stale/non-renderable locked ref falls back to source.
 */
export function bindMonacoPreviewScroll(
  editor: Monaco.editor.IStandaloneCodeEditor,
  binding: PreviewScrollBinding,
  immediateScrollType: Monaco.editor.ScrollType,
): () => void {
  if (binding.driver && binding.receiver) {
    throw new Error('a Monaco scroll surface cannot be both driver and receiver');
  }
  const store = binding.store ?? previewScrollStore;
  const disposables: Monaco.IDisposable[] = [];
  let current: PreviewScrollPosition | undefined;
  let unsubscribe: () => void = () => undefined;
  let frames: ReturnType<typeof createAnimationFramePublisher> | undefined;

  const viewportHeight = () => editor.getLayoutInfo().height;
  const apply = (position: PreviewScrollPosition) => {
    current = position;
    editor.setScrollTop(
      scrollTopForRatio(position.ratio, editor.getScrollHeight(), viewportHeight()),
      immediateScrollType,
    );
  };

  if (binding.receiver) {
    unsubscribe = store.subscribe(binding.channel, binding.target, apply);
    disposables.push(editor.onDidChangeModel(() => current && apply(current)));
    disposables.push(editor.onDidLayoutChange(() => current && apply(current)));
  } else if (binding.driver) {
    frames = createAnimationFramePublisher(() => {
      store.publish(
        binding.channel,
        binding.target,
        normalisedScrollRatio(editor.getScrollTop(), editor.getScrollHeight(), viewportHeight()),
      );
    });
    disposables.push(editor.onDidScrollChange(frames.schedule));
    disposables.push(editor.onDidChangeModel(frames.schedule));
    disposables.push(editor.onDidLayoutChange(frames.schedule));
    frames.schedule();
  }

  return () => {
    unsubscribe();
    for (const disposable of disposables) disposable.dispose();
    frames?.dispose();
  };
}
