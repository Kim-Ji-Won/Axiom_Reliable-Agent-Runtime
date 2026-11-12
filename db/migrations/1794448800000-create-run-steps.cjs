exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE run_steps (
      run_id UUID NOT NULL REFERENCES runs(id),
      step_no INTEGER NOT NULL CHECK (step_no > 0),
      result_kind TEXT NOT NULL CHECK (result_kind IN (
        'completed', 'unsupported_tool_request', 'invalid_decision',
        'decision_source_error', 'finalize_conflict'
      )),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (run_id, step_no)
    )
  `);
};

// The runner holds one transaction for lock, existence check, DROP and history.
// Block concurrent INSERTs before checking; never delete recorded steps to downgrade.
exports.down = (pgm) => {
  pgm.sql(`
    LOCK TABLE run_steps IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM run_steps) THEN
        RAISE EXCEPTION 'Cannot drop nonempty run_steps';
      END IF;
    END $$;
    DROP TABLE run_steps;
  `);
};
