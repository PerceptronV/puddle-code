import { createRoot } from 'react-dom/client';
import { CursorHost } from '../../src/features/cursor/CursorHost';
import { initClientSettings, updateClientSettings } from '../../src/lib/settings/client-settings';
import type { CursorPackageId } from '../../src/lib/appearance/cursor-packages';

initClientSettings();
createRoot(document.getElementById('root')!).render(<CursorHost />);
let styleReads = 0;
let roleQueries = 0;
let writes = 0;
const computedStyle = window.getComputedStyle;
window.getComputedStyle = (...args) => {
  styleReads++;
  return computedStyle(...args);
};
const closest = Element.prototype.closest;
Element.prototype.closest = function (selector) {
  roleQueries++;
  return closest.call(this, selector);
};
const changes = new MutationObserver((records) => {
  writes += records.filter((record) =>
    (record.target as Element).classList?.contains('custom-cursor'),
  ).length;
});
changes.observe(document.body, { attributes: true, subtree: true });
const tick = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
Object.assign(window, {
  choose(cursorPackage: CursorPackageId, reduceMotion = false) {
    updateClientSettings({ cursorPackage, reduceMotion });
  },
  async frame() {
    await tick();
    await tick();
  },
  move(id: string, count = 1, pointerType = 'mouse') {
    const target = document.getElementById(id)!;
    const rect = target.getBoundingClientRect();
    for (let i = 0; i < count; i++)
      target.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerType,
          clientX: rect.x + 5 + (i % 20),
          clientY: rect.y + 5,
        }),
      );
  },
  resetCounts() {
    changes.takeRecords();
    styleReads = roleQueries = writes = 0;
  },
  counts() {
    return { styleReads, roleQueries, writes };
  },
  async workload() {
    const start = performance.now();
    for (let frame = 0; frame < 120; frame++) {
      const target = document.getElementById(frame % 30 < 15 ? 'text' : 'button')!;
      const rect = target.getBoundingClientRect();
      for (let i = 0; i < 20; i++)
        target.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerType: 'mouse',
            clientX: rect.x + 5 + i,
            clientY: rect.y + 5,
          }),
        );
      await tick();
    }
    await tick();
    return { elapsedMs: performance.now() - start, styleReads, roleQueries, writes };
  },
});
