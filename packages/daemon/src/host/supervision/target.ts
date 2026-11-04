export interface ServiceTarget {
  kind: 'systemd' | 'launchd';
  name: string;
  domain: string | null;
}

export function validServiceTarget(target: ServiceTarget): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(target.name))
    throw new Error('Invalid host service name');
  if (target.kind === 'launchd') {
    if (!/^gui\/[0-9]+$/.test(target.domain ?? '')) throw new Error('Invalid host service domain');
  } else if (target.domain !== null || !target.name.endsWith('.service')) {
    throw new Error('Invalid host service target');
  }
}
