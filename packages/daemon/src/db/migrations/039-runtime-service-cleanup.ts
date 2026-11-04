/** Registration cleanup is distinct from retained history and executable collection. */
export const migration039 = {
  version: 39,
  name: 'runtime-service-cleanup',
  sql: `
CREATE TABLE runtime_service_cleanup (
  runtime_id TEXT PRIMARY KEY REFERENCES runtime_bindings(runtime_id) ON DELETE CASCADE,
  completed_at TEXT
);
CREATE INDEX idx_runtime_service_cleanup_pending ON runtime_service_cleanup(runtime_id)
  WHERE completed_at IS NULL;
INSERT INTO runtime_service_cleanup(runtime_id)
  SELECT runtime_id FROM runtime_bindings WHERE state IN ('exited', 'failed', 'interrupted');
CREATE TRIGGER runtime_service_cleanup_insert AFTER INSERT ON runtime_bindings
  WHEN NEW.state IN ('exited', 'failed', 'interrupted') BEGIN
  INSERT OR IGNORE INTO runtime_service_cleanup(runtime_id) VALUES (NEW.runtime_id);
END;
CREATE TRIGGER runtime_service_cleanup_end AFTER UPDATE OF state ON runtime_bindings
  WHEN NEW.state IN ('exited', 'failed', 'interrupted') BEGIN
  INSERT OR IGNORE INTO runtime_service_cleanup(runtime_id) VALUES (NEW.runtime_id);
END;
`,
};
