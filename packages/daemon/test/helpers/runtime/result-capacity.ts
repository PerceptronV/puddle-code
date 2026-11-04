import type { Db } from '../../../src/db/db.js';

/** Isolated downgrade fixtures only; never used against installed data. */
export function dropResultCapacity(db: Db): void {
  db.exec(`
    DROP TRIGGER runtime_result_payload_insert;
    DROP TRIGGER runtime_result_payload_update;
    DROP TRIGGER runtime_result_payload_delete;
    DROP TRIGGER runtime_result_charge_insert;
    DROP TRIGGER runtime_result_charge_update;
    DROP TRIGGER runtime_result_charge_delete;
    DROP INDEX runtime_result_reclaim_owner;
    DROP INDEX runtime_result_reclaim_host;
    DROP TABLE runtime_result_charges;
    DROP TABLE runtime_result_usage;
    DROP TABLE host_result_usage;
  `);
}
