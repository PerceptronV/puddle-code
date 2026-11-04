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
