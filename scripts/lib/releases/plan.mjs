import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export function validateReleasePlan(plan, version) {
  if (!plan || Object.keys(plan).sort().join(',') !== 'components,format,version')
    throw new Error('Invalid release manifest fields');
  if (![1, 2].includes(plan?.format) || plan.version !== version || !versionPattern.test(version))
    throw new Error('Release plan must match the exact release version');
  if (
    !plan.components ||
    Object.keys(plan.components).sort().join(',') !==
      (plan.format === 1 ? 'cockpit,daemon,runtime' : 'daemon,frontend,runtime')
  )
    throw new Error('Release plan must name frontend, daemon and runtime');
  if (plan.format === 1) {
    // Keep published historical manifests readable without propagating their wire key.
    plan = {
      format: 2,
      version,
      components: {
        frontend: plan.components.cockpit,
        daemon: plan.components.daemon,
        runtime: plan.components.runtime,
      },
    };
  }
  const compare = (a, b) => {
    const left = a.split('.').map(BigInt),
      right = b.split('.').map(BigInt);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
    return 0;
  };
  for (const value of Object.values(plan.components))
    if (!versionPattern.test(value) || compare(value, version) > 0)
      throw new Error('Invalid component release version');
  if (plan.components.frontend !== version)
    throw new Error('The frontend is published on every release');
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
    format: 2,
    version,
    components: { frontend: version, daemon: version, runtime: version },
  };
}

/** Compatibility asset consumed by already deployed format 1 clients. Never use internally. */
export function legacyReleasePlan(plan) {
  const canonical = validateReleasePlan(plan, plan.version);
  return {
    format: 1,
    version: canonical.version,
    components: {
      cockpit: canonical.components.frontend,
      daemon: canonical.components.daemon,
      runtime: canonical.components.runtime,
    },
  };
}
