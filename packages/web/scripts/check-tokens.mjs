/**
 * CI guard for src/styles/tokens.css (SPEC §12): every theme block must
 * assign the complete semantic token set, and text pairings must pass
 * WCAG AA (4.5:1 body text, 3:1 large text / UI elements) against every
 * background token. Exits non-zero with a per-failure report.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contrastRatio } from './contrast.mjs';

const TOKENS_FILE = fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url));

const REQUIRED_SEMANTIC_TOKENS = [
  '--bg-base',
  '--bg-surface',
  '--bg-elevated',
  '--border',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--accent',
  '--accent-hover',
  '--focus-ring',
  '--danger',
  '--status-running',
  '--status-waiting',
  '--status-interrupted',
  '--status-idle',
  '--selection',
  '--ansi-black',
  '--ansi-red',
  '--ansi-green',
  '--ansi-yellow',
  '--ansi-blue',
  '--ansi-magenta',
  '--ansi-cyan',
  '--ansi-white',
  '--ansi-bright-black',
  '--ansi-bright-red',
  '--ansi-bright-green',
  '--ansi-bright-yellow',
  '--ansi-bright-blue',
  '--ansi-bright-magenta',
  '--ansi-bright-cyan',
  '--ansi-bright-white',
];

const BACKGROUNDS = ['--bg-base', '--bg-surface', '--bg-elevated'];
// token → minimum ratio against every background (WCAG AA).
const CONTRAST_FLOORS = {
  '--text-primary': 4.5,
  '--text-secondary': 4.5,
  '--text-muted': 3,
  '--accent': 3,
  '--status-running': 3,
  '--status-waiting': 3,
  '--status-interrupted': 3,
  '--status-idle': 3,
};

/** Extracts `selector { ... }` bodies (tokens.css nests no rules). */
function blocks(css) {
  const found = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(css)) !== null) {
    found.push({ selector: match[1].trim(), body: match[2] });
  }
  return found;
}

function declarations(body) {
  const vars = new Map();
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    vars.set(match[1], match[2].trim());
  }
  return vars;
}

/** Follows var() chains down to a literal value. */
function resolve(name, theme, primitives, seen = new Set()) {
  if (seen.has(name)) throw new Error(`circular var() chain at ${name}`);
  seen.add(name);
  const value = theme.get(name) ?? primitives.get(name);
  if (value === undefined) throw new Error(`token ${name} references undefined ${name}`);
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolve(ref[1], theme, primitives, seen) : value;
}

const css = readFileSync(TOKENS_FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const parsed = blocks(css);
const root = parsed.find((b) => b.selector === ':root');
const themes = parsed.filter((b) => /^\[data-theme=/.test(b.selector));

const failures = [];
if (!root) failures.push('tokens.css has no :root primitives block');
if (themes.length === 0) failures.push('tokens.css defines no [data-theme] blocks');

const primitives = root ? declarations(root.body) : new Map();

for (const { selector, body } of themes) {
  const theme = declarations(body);
  for (const token of REQUIRED_SEMANTIC_TOKENS) {
    if (!theme.has(token)) {
      failures.push(`${selector} is missing ${token}`);
    }
  }

  const value = (token) => resolve(token, theme, primitives);
  for (const [token, floor] of Object.entries(CONTRAST_FLOORS)) {
    if (!theme.has(token)) continue; // already reported as missing
    for (const bg of BACKGROUNDS) {
      if (!theme.has(bg)) continue;
      try {
        const ratio = contrastRatio(value(token), value(bg));
        if (ratio < floor) {
          failures.push(
            `${selector}: ${token} on ${bg} is ${ratio.toFixed(2)}:1 (needs ≥ ${floor}:1)`,
          );
        }
      } catch (e) {
        failures.push(`${selector}: ${token} vs ${bg}: ${e.message}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(
    `check-tokens: ${failures.length} failure(s)\n` + failures.map((f) => `  ✗ ${f}`).join('\n'),
  );
  process.exit(1);
}
console.log(
  `check-tokens: ${themes.length} theme(s) complete, ` +
    `${Object.keys(CONTRAST_FLOORS).length * BACKGROUNDS.length} contrast pairs per theme pass AA`,
);
