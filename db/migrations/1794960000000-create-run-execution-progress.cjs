exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE run_execution_progress (
      run_id UUID PRIMARY KEY REFERENCES runs(id),
      schema_version SMALLINT NOT NULL CHECK (schema_version = 1),
      checkpoint_version INTEGER NOT NULL CHECK (checkpoint_version >= 0),
      last_confirmed_step_no INTEGER CHECK (last_confirmed_step_no >= 1),
      max_decisions INTEGER NOT NULL CHECK (max_decisions BETWEEN 1 AND 5),
      decisions_reserved INTEGER NOT NULL CHECK (decisions_reserved BETWEEN 0 AND max_decisions),
      max_tool_attempts INTEGER NOT NULL CHECK (max_tool_attempts BETWEEN 0 AND 1),
      tool_attempts_reserved INTEGER NOT NULL CHECK
        (tool_attempts_reserved BETWEEN 0 AND max_tool_attempts AND tool_attempts_reserved <= decisions_reserved),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      CHECK (isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at),
      FOREIGN KEY (run_id, last_confirmed_step_no) REFERENCES run_steps(run_id, step_no)
    );
  `);
};
exports.down = (pgm) => {
  // Parent first: supported writers acquire runs before Lease/Step/Progress.
  // Holding this table lock also prevents new FK references during the emptiness check.
  pgm.sql(`
    LOCK TABLE runs IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE run_execution_leases IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE run_steps IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE run_execution_progress IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM run_execution_progress) THEN
        RAISE EXCEPTION 'Cannot drop nonempty run_execution_progress';
      END IF;
    END $$;
    DROP TABLE run_execution_progress;
  `);
};
