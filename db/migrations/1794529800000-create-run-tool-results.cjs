exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE run_steps ADD CONSTRAINT run_steps_result_binding UNIQUE (run_id, step_no, result_kind);
    CREATE TABLE run_tool_results (
      run_id UUID NOT NULL,
      step_no INTEGER NOT NULL CHECK (step_no > 0),
      result_kind TEXT NOT NULL DEFAULT 'tool_succeeded' CHECK (result_kind = 'tool_succeeded'),
      schema_version SMALLINT NOT NULL CHECK (schema_version = 1),
      status TEXT NOT NULL CHECK (status IN ('ok', 'empty')),
      item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (run_id, step_no),
      FOREIGN KEY (run_id, step_no, result_kind) REFERENCES run_steps(run_id, step_no, result_kind),
      CHECK (isfinite(created_at) AND isfinite(expires_at) AND created_at <= statement_timestamp()
        AND expires_at >= created_at + INTERVAL '1 second' AND expires_at <= created_at + INTERVAL '24 hours'),
      CHECK (octet_length(jsonb_build_object('schemaVersion', schema_version, 'status', status, 'itemCount', item_count)::text) <= 1024)
    );
  `);
};
exports.down = (pgm) => {
  // Match writer dependency order: Step table before Result table; one runner TX.
  pgm.sql(`
    LOCK TABLE run_steps IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE run_tool_results IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM run_tool_results) THEN
        RAISE EXCEPTION 'Cannot drop nonempty run_tool_results';
      END IF;
    END $$;
    DROP TABLE run_tool_results;
    ALTER TABLE run_steps DROP CONSTRAINT run_steps_result_binding;
  `);
};
