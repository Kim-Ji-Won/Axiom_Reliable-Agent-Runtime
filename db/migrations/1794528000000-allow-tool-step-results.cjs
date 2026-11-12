const oldKinds = "'completed', 'unsupported_tool_request', 'invalid_decision', 'decision_source_error', 'finalize_conflict', 'continued', 'decision_limit_exceeded'";
const toolKinds = "'tool_succeeded', 'tool_failed', 'tool_request_rejected', 'tool_execution_limit_exceeded'";
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE run_steps
    DROP CONSTRAINT run_steps_result_kind_check,
    ADD CONSTRAINT run_steps_result_kind_check CHECK (result_kind IN (${oldKinds}, ${toolKinds}));`);
};
// The runner holds a single transaction for lock, guard, constraint and history.
exports.down = (pgm) => {
  pgm.sql(`LOCK TABLE run_steps IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM run_steps WHERE result_kind IN (${toolKinds})) THEN
        RAISE EXCEPTION 'Cannot remove recorded tool Step kinds';
      END IF;
    END $$;
    ALTER TABLE run_steps
      DROP CONSTRAINT run_steps_result_kind_check,
      ADD CONSTRAINT run_steps_result_kind_check CHECK (result_kind IN (${oldKinds}));`);
};
