import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export function validateReleasePlan(plan, version) {
  if (!plan || Object.keys(plan).sort().join(',') !== 'components,format,version')
    throw new Error('Invalid release manifest fields');
  if (plan?.format !== 1 || plan.version !== version || !versionPattern.test(version))
    throw new Error('Release plan must match the exact release version');
  if (
    !plan.components ||
    Object.keys(plan.components).sort().join(',') !== 'cockpit,daemon,runtime'
  )
    throw new Error('Release plan must name cockpit, daemon and runtime');
  const compare = (a, b) => {
    const left = a.split('.').map(BigInt),
      right = b.split('.').map(BigInt);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
    return 0;
  };
  for (const value of Object.values(plan.components))
    if (!versionPattern.test(value) || compare(value, version) > 0)
      throw new Error('Invalid component release version');
  if (plan.components.cockpit !== version)
    throw new Error('The cockpit is published on every release');
  return plan;
}

/** Legacy/dev builds retain the all-components convention; release CI requires an exact plan. */
export function readReleasePlan(root, version, required = false) {
  const file = join(root, 'release-manifest.json');
  if (existsSync(file)) {
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    if (plan.version === version || required) return validateReleasePlan(plan, version);
  } else if (required) throw new Error('Generate and commit release-manifest.json before tagging');
  return {
    format: 1,
    version,
    components: { cockpit: version, daemon: version, runtime: version },
  };
}
