import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MediaViewer } from '../../src/features/editor/MediaViewer';
import { TabViewStateContext } from '../../src/features/editor/view-state-context';
import '../../src/styles/app.css';

function Fixture() {
  const [project, setProject] = useState('first');
  const [revision, setRevision] = useState(0);
  return (
    <>
      <nav>
        <button onClick={() => setProject('first')}>First project</button>
        <button onClick={() => setProject('second')}>Second project</button>
        <button onClick={() => setRevision((value) => value + 1)}>Recompile</button>
      </nav>
      <div style={{ height: 600, width: 650 }}>
        <TabViewStateContext.Provider value={project}>
          <MediaViewer
            key={project}
            refreshKey={revision}
            session="session"
            path="document.pdf"
            root="/project"
            kind="pdf"
            generatedBy={new URLSearchParams(location.search).has('ordinary') ? undefined : 'latex'}
            onRevealSource={() => {}}
          />
        </TabViewStateContext.Provider>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
