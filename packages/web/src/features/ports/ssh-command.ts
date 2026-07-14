/**
 * SSH tier-1 fallback for a session's detected port (SPEC §9): a copyable
 * local-forward command routed through the daemon's own SSH tunnel. Pure so
 * it's testable without a DOM — the caller (`PortsStrip`) supplies the host
 * info from `useHostInfo()` and writes the result to the clipboard.
 */
export function sshForwardCommand(port: number, username: string, hostname: string): string {
  return `ssh -L ${port}:127.0.0.1:${port} ${username}@${hostname}`;
}
