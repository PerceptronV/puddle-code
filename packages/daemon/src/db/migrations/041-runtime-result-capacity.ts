/**
 * Pending turn reservations survive controller loss; counters change with their payloads.
 * 1605632 is the historical runtime-1.0 reservation; future policy changes require
 * another migration, never rewriting this backfill or its installed triggers.
 */
export const migration041 = {
  version: 41,
  name: 'runtime-result-capacity',
  sql: `
CREATE TABLE runtime_result_charges (
  runtime_id TEXT NOT NULL REFERENCES runtime_bindings(runtime_id) ON DELETE CASCADE,
  turn INTEGER NOT NULL CHECK (turn > 0),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  PRIMARY KEY (runtime_id, turn)
);
CREATE TABLE runtime_result_usage (
  runtime_id TEXT PRIMARY KEY REFERENCES runtime_bindings(runtime_id) ON DELETE CASCADE,
  turns INTEGER NOT NULL CHECK (turns >= 0),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
  pending_cleanup INTEGER NOT NULL DEFAULT 0 CHECK (pending_cleanup IN (0, 1)),
  CHECK (pending_cleanup = 0 OR retired = 1)
);
CREATE INDEX runtime_result_retired ON runtime_result_usage(runtime_id) WHERE pending_cleanup = 1;
CREATE TABLE host_result_usage (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  turns INTEGER NOT NULL CHECK (turns >= 0),
  bytes INTEGER NOT NULL CHECK (bytes >= 0)
);
INSERT INTO host_result_usage VALUES (1, 0, 0);
CREATE TRIGGER runtime_result_charge_insert AFTER INSERT ON runtime_result_charges BEGIN
  INSERT INTO runtime_result_usage(runtime_id, turns, bytes) VALUES (NEW.runtime_id, 1, NEW.bytes)
  ON CONFLICT(runtime_id) DO UPDATE SET turns = turns + 1, bytes = bytes + NEW.bytes;
  UPDATE host_result_usage SET turns = turns + 1, bytes = bytes + NEW.bytes WHERE singleton = 1;
END;
CREATE TRIGGER runtime_result_charge_update AFTER UPDATE OF bytes ON runtime_result_charges BEGIN
  UPDATE runtime_result_usage SET bytes = bytes + NEW.bytes - OLD.bytes WHERE runtime_id = NEW.runtime_id;
  UPDATE host_result_usage SET bytes = bytes + NEW.bytes - OLD.bytes WHERE singleton = 1;
END;
CREATE TRIGGER runtime_result_charge_delete AFTER DELETE ON runtime_result_charges BEGIN
  UPDATE runtime_result_usage SET turns = turns - 1, bytes = bytes - OLD.bytes WHERE runtime_id = OLD.runtime_id;
  UPDATE host_result_usage SET turns = turns - 1, bytes = bytes - OLD.bytes WHERE singleton = 1;
END;
-- SQLite's BLOB length is the UTF-8 byte length, including escaped JSON bytes.
-- Unknown historical statuses retain the same conservative reservation as running turns.
INSERT INTO runtime_result_charges
SELECT runtime_id, turn,
 CASE WHEN json_extract(result, '$.status') IN ('completed', 'failed', 'cancelled', 'interrupted')
 THEN length(CAST(result AS BLOB)) ELSE MAX(length(CAST(result AS BLOB)), 1605632) END
FROM runtime_turns;
-- Absent results at/below the watermark cannot be admitted again. This does not
-- mark them consumed or invent a disposition. Above it, acceptance remains unknown.
INSERT INTO runtime_result_charges
SELECT m.runtime_id, m.turn, 1605632 FROM puddlang_runtime_turns m
LEFT JOIN runtime_turn_watermarks w ON w.runtime_id = m.runtime_id
WHERE m.turn > COALESCE(w.turn, 0)
AND NOT EXISTS (SELECT 1 FROM runtime_turns t WHERE t.runtime_id = m.runtime_id AND t.turn = m.turn);
CREATE TRIGGER runtime_result_payload_insert AFTER INSERT ON runtime_turns BEGIN
  INSERT INTO runtime_result_charges VALUES (NEW.runtime_id, NEW.turn,
    CASE WHEN json_extract(NEW.result, '$.status') IN ('completed', 'failed', 'cancelled', 'interrupted')
    THEN length(CAST(NEW.result AS BLOB)) ELSE MAX(length(CAST(NEW.result AS BLOB)), 1605632) END)
  ON CONFLICT(runtime_id, turn) DO UPDATE SET bytes = excluded.bytes;
END;
CREATE TRIGGER runtime_result_payload_update AFTER UPDATE OF result ON runtime_turns BEGIN
  INSERT INTO runtime_result_charges VALUES (NEW.runtime_id, NEW.turn,
    CASE WHEN json_extract(NEW.result, '$.status') IN ('completed', 'failed', 'cancelled', 'interrupted')
    THEN length(CAST(NEW.result AS BLOB)) ELSE MAX(length(CAST(NEW.result AS BLOB)), 1605632) END)
  ON CONFLICT(runtime_id, turn) DO UPDATE SET bytes = excluded.bytes;
END;
CREATE TRIGGER runtime_result_payload_delete AFTER DELETE ON runtime_turns BEGIN
  DELETE FROM runtime_result_charges WHERE runtime_id = OLD.runtime_id AND turn = OLD.turn;
END;
CREATE INDEX runtime_result_reclaim_owner ON runtime_turns(runtime_id, turn)
WHERE consumed = 1 AND json_extract(result, '$.status') IN ('completed', 'failed', 'cancelled', 'interrupted');
CREATE INDEX runtime_result_reclaim_host ON runtime_turns(bytes DESC, runtime_id, turn)
WHERE consumed = 1 AND json_extract(result, '$.status') IN ('completed', 'failed', 'cancelled', 'interrupted');
`,
};
