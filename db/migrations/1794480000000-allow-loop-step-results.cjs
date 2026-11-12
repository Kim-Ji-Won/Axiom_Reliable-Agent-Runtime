exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE run_steps
      DROP CONSTRAINT run_steps_result_kind_check,
      ADD CONSTRAINT run_steps_result_kind_check CHECK (result_kind IN (
        'completed', 'unsupported_tool_request', 'invalid_decision',
        'decision_source_error', 'finalize_conflict', 'continued', 'decision_limit_exceeded'
      ));
  `);
};

// Lock before checking, in the runner's single transaction. Never rewrite history.
exports.down = (pgm) => {
  pgm.sql(`
    LOCK TABLE run_steps IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM run_steps WHERE result_kind IN ('continued', 'decision_limit_exceeded')) THEN
        RAISE EXCEPTION 'Cannot remove recorded loop Step kinds';
      END IF;
    END $$;
    ALTER TABLE run_steps
      DROP CONSTRAINT run_steps_result_kind_check,
      ADD CONSTRAINT run_steps_result_kind_check CHECK (result_kind IN (
        'completed', 'unsupported_tool_request', 'invalid_decision',
        'decision_source_error', 'finalize_conflict'
      ));
  `);
};
