import { hostStageReceiptSchema, type HostStageReceipt } from '../../installation/stage.js';
import { digest } from '../security.js';

export function validateHostStageReceipt(value: unknown): HostStageReceipt {
  const receipt = hostStageReceiptSchema.parse(value);
  if (digest(`${JSON.stringify(receipt.record)}\n`) !== receipt.digest)
    throw new Error('The host stage receipt digest does not match its record');
  return receipt;
}

/** The canonical installer emits exactly one bounded receipt; other output is not trusted metadata. */
export function parseHostStageOutput(
  output: string,
  component: HostStageReceipt['record']['component'],
  version: string,
): HostStageReceipt {
  const prefix = 'PUDDLE_HOST_STAGE ';
  const lines = output.split('\n').filter((line) => line.startsWith(prefix));
  if (lines.length !== 1 || lines[0]!.length > 4096)
    throw new Error('The host installer did not return one bounded stage receipt');
  const receipt = validateHostStageReceipt(JSON.parse(lines[0]!.slice(prefix.length)));
  if (receipt.record.component !== component || receipt.record.version !== version)
    throw new Error('The host staged a different component or release');
  return receipt;
}
