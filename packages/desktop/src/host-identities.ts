import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PROFILE_ICON_COLOURS } from '@puddle/shared';

/** A bounded drawing snapshot of the frontend's chosen Lucide glyph. No SVG markup or URLs. */
export interface HostIconNode {
  tag: string;
  attrs: Record<string, string>;
}
export interface HostIdentity {
  name: string;
  colour: string | null;
  icon: HostIconNode[];
}
const tags = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const attributes = new Set([
  'd',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'width',
  'height',
  'points',
]);

export function parseHostIdentity(value: unknown): HostIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const { name, colour, icon } = value as Partial<HostIdentity>;
  if (typeof name !== 'string' || !name.trim() || name.length > 256) return null;
  if (
    colour !== null &&
    (typeof colour !== 'string' ||
      (!/^#[0-9a-f]{6}$/i.test(colour) && !PROFILE_ICON_COLOURS.some((key) => key === colour)))
  )
    return null;
  if (!Array.isArray(icon) || !icon.length || icon.length > 64) return null;
  let size = 0;
  const nodes: HostIconNode[] = [];
  for (const node of icon) {
    if (
      !node ||
      typeof node !== 'object' ||
      !tags.has(node.tag) ||
      !node.attrs ||
      typeof node.attrs !== 'object' ||
      Array.isArray(node.attrs)
    )
      return null;
    const attrs: Record<string, string> = {};
    for (const [key, value] of Object.entries(node.attrs)) {
      if (!attributes.has(key) || typeof value !== 'string' || !/^[\d\s.,+a-z-]*$/i.test(value))
        return null;
      size += value.length;
      if (size > 16_384) return null;
      attrs[key] = value;
    }
    nodes.push({ tag: node.tag, attrs });
  }
  return { name: name.trim(), colour, icon: nodes };
}

/** Last viewed profile identity per target; presentation only, never connection authority. */
export function loadHostIdentities(file: string): Map<string, HostIdentity> {
  try {
    const raw = readFileSync(file, 'utf8');
    if (raw.length > 1_048_576) return new Map();
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return new Map();
    const result = new Map<string, HostIdentity>();
    for (const entry of values.slice(-32)) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || entry[0].length > 1024) continue;
      const identity = parseHostIdentity(entry[1]);
      if (identity) result.set(entry[0], identity);
    }
    return result;
  } catch {
    return new Map();
  }
}

export function saveHostIdentity(file: string, target: string, identity: HostIdentity): void {
  const values = loadHostIdentities(file);
  values.delete(target);
  values.set(target, identity);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify([...values].slice(-32)) + '\n', { mode: 0o600 });
  } catch {
    // Cosmetic client preferences must never prevent opening a host.
  }
}
