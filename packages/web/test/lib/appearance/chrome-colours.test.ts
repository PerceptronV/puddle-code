import { describe, expect, it } from 'vitest';
// @ts-expect-error build-time JavaScript guard
import { chromeColourViolations } from '../../../scripts/check-chrome-colours.mjs';

describe('application chrome colour guard', () => {
  it.each([
    ['x.tsx', 'const style = { color: "#abc" };'],
    ['x.tsx', '<button className="bg-[#112233]" />'],
    ['x.tsx', '<button className="text-blue-500" />'],
    ['x.tsx', 'const shadow = "0 8px 30px rgb(0 0 0 / 0.25)";'],
    ['x.css', 'button { background: #123456; }'],
    ['x.html', '<style>button { color: rgb(0, 0, 0); }</style>'],
  ])('rejects a local colour in %s', (name, source) => {
    expect(chromeColourViolations(source, name)).not.toHaveLength(0);
  });
  it.each([
    ['x.tsx', 'const style = { color: "var(--text-primary)" };'],
    ['x.tsx', '<button className="bg-action text-action-ink" />'],
    ['x.ts', '// colour used to be #123456\nconst issue = "Fix #123456";'],
    ['x.css', '/* background: #fff */ button { background: var(--bg-base); }'],
  ])('permits semantic colours and commentary in %s', (name, source) => {
    expect(chromeColourViolations(source, name)).toHaveLength(0);
  });
});
