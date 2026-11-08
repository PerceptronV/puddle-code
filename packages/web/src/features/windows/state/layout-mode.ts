/** Native restore/apply owns its stored mode; an explicit preference change still converts it. */
export class WindowLayoutMode {
  private pending: boolean | undefined;
  constructor(private preference: boolean) {}

  request(preference: boolean): void {
    this.pending = preference;
  }

  select(
    preference: boolean,
    restored: boolean,
    mode: 'profile' | 'project' | undefined,
    staging: boolean,
  ): boolean {
    if (staging) this.pending = undefined;
    else if (preference !== this.preference) this.pending = preference;
    this.preference = preference;
    if (mode !== undefined && (mode === 'project') === this.pending) this.pending = undefined;
    return restored || staging
      ? (this.pending ?? (mode === undefined ? preference : mode === 'project'))
      : preference;
  }
}
