/** Documented systemctl show properties, without environment or diagnostic output. */
export function systemdObservation(pid: number, name = 'puddled.service'): string {
  return (
    [
      `Id=${name}`,
      'LoadState=loaded',
      'ActiveState=active',
      'SubState=running',
      `MainPID=${pid}`,
      `InvocationID=${'a'.repeat(32)}`,
      `ControlGroup=/user.slice/user-501.slice/user@501.service/app.slice/${name}`,
      'NeedDaemonReload=no',
      'CanStart=yes',
      'CanStop=yes',
    ].join('\n') + '\n'
  );
}

export function launchdObservation(pid: number, name = 'dev.puddle.puddled'): string {
  return `PID\tStatus\tLabel\n-\t0\tdev.example.unrelated\n${pid}\t0\t${name}\n`;
}
