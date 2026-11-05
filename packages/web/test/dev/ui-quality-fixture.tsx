import { Composer } from '../../src/features/mobile/Composer';
import { TooltipProvider } from '../../src/components/ui/tooltip';
/** Browser-only harness for shared controls; never imported by production. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ControlTray } from '../../src/components/ui/control-tray';
import { TrayMotionProvider } from '../../src/components/ui/tray-motion';
import { PhoneSessionRail } from '../../src/features/mobile/PhoneSessionRail';
import { project, sessions } from '../../src/dev/preview/data';
import '../../src/features/remote/remote.css';

export function mountTrays() {
  const container = document.createElement('div');
  container.id = 'tray-check';
  container.style.cssText =
    'position:fixed;left:400px;top:400px;z-index:100;background:var(--bg-base)';
  document.body.append(container);
  let update: (state: { slot: number; generation: number }) => void;
  function Harness() {
    const [state, setState] = useState({ slot: 0, generation: 0 });
    update = setState;
    const tray = (id: string, selected: number, generation: number) => (
      <ControlTray
        key={`${id}-${generation}`}
        motionId={id}
        label="Repeated label"
        variant="selection"
      >
        {[0, 1, 2].map((slot) => (
          <button
            key={slot}
            aria-current={slot === selected ? 'page' : undefined}
            data-tray-slot
            onClick={() => setState({ ...state, slot })}
          >
            Slot {slot}
          </button>
        ))}
      </ControlTray>
    );
    return (
      <TrayMotionProvider>
        {tray('first', state.slot, state.generation)}
        {tray('second', 2, 0)}
      </TrayMotionProvider>
    );
  }
  const root = createRoot(container);
  flushSync(() => root.render(<Harness />));
  return {
    update: (state: { slot: number; generation: number }) => flushSync(() => update(state)),
    remove: () => {
      root.unmount();
      container.remove();
    },
  };
}

export function mountPhone() {
  document.getElementById('root')!.style.display = 'none';
  const container = document.createElement('div');
  container.id = 'phone-check';
  container.style.cssText =
    'position:fixed;inset:12px;display:flex;gap:8px;background:var(--bg-base)';
  document.body.append(container);
  function PhoneHarness() {
    const [selected, setSelected] = useState(sessions[0]!.id);
    return (
      <TooltipProvider>
        <div
          className="phone-workspace-body"
          style={{ height: '100%', display: 'flex', minWidth: 0 }}
        >
          <PhoneSessionRail
            projects={[project]}
            projectId={project.id}
            sessions={[
              ...sessions,
              { ...sessions[0]!, id: '00000000-0000-4000-8000-000000000099', status: 'archived' },
            ]}
            selected={selected}
            connected
            chooseProject={() => {}}
            choose={(session) => setSelected(session.id)}
            create={() => {}}
            inspect={() => {}}
          />
          <div
            style={{
              minWidth: 0,
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
            }}
          >
            <Composer session={selected} term="agent" connected={false} />
          </div>
        </div>
      </TooltipProvider>
    );
  }
  const root = createRoot(container);
  flushSync(() => root.render(<PhoneHarness />));
  return () => {
    root.unmount();
    container.remove();
  };
}
