/** Strictly newer stable x.y.z; use integer comparison without floating-point precision loss. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string) => {
    if (value.length > 129) return null;
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
    return match ? match.slice(1).map((part) => BigInt(part)) : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** Release metadata is independent of its immutable installation generation. */
export function parseHostReleaseVersion(value: string): string | undefined {
  const version = value.trim();
  return value.length <= 129 &&
    version.length <= 128 &&
    /^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$/.test(version)
    ? version
    : undefined;
}

/** Only pre-generation installs can infer a release from the selector target. */
export function parseLegacyHostVersion(target: string): string | undefined {
  const version = /(?:^|\/)versions\/([^/\s]+)$/.exec(target.trim())?.[1];
  return version === undefined ? undefined : parseHostReleaseVersion(version);
}

/** Plain release protocol metadata; never infer it from a software version. */
export function parseReleaseProtocol(value: string): { major: number; minor: number } | undefined {
  if (value.length > 33) return undefined;
  const match = /^(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) ? { major, minor } : undefined;
}
