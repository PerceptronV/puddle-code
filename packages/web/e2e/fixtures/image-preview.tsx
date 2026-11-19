import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { MediaViewer } from '../../src/features/editor/previews/MediaViewer';
import '../../src/styles/app.css';

createRoot(document.getElementById('root')!).render(
  <div style={{ height: 200, width: 300 }}>
    <MediaViewer
      session="fixture"
      path={new URLSearchParams(location.search).get('path') ?? 'picture.png'}
      kind="image"
    />
    <Toaster />
  </div>,
);
