import { ensureDaemon } from '../../../../../cli/src/lib/connection/cockpit.js';
import { LocalTransport } from '../../../../../cli/src/lib/transport/local.js';
import type { DaemonUpgradeRequest } from '../../../../../cli/src/lib/connection/handshake.js';

const [decision, archive] = process.argv.slice(2);
const prompts: DaemonUpgradeRequest[] = [];
try {
  const endpoint = await ensureDaemon(new LocalTransport(), {
    version: '0.4.0',
    tarball: archive,
    startTimeoutMs: 30_000,
    confirmDaemonUpgrade: async (request) => {
      prompts.push(request);
      return decision === 'approve';
    },
  });
  const result = {
    ok: true,
    prompts,
    version: endpoint.authority.version,
    bootstrapped: endpoint.bootstrapped,
  };
  endpoint.authority.close();
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      prompts,
      error: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string }).code,
    }) + '\n',
  );
}
