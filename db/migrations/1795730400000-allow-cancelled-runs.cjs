const statuses = "'queued', 'running', 'completed', 'failed'";
const kinds = "'completed', 'unsupported_tool_request', 'invalid_decision', 'decision_source_error', 'finalize_conflict', " +
  "'continued', 'decision_limit_exceeded', 'tool_succeeded', 'tool_failed', 'tool_request_rejected', 'tool_execution_limit_exceeded'";
const lock = 'LOCK TABLE runs IN ACCESS EXCLUSIVE MODE; LOCK TABLE run_steps IN ACCESS EXCLUSIVE MODE;';

function checks(extra) {
  return `ALTER TABLE runs DROP CONSTRAINT runs_status_allowed,
    ADD CONSTRAINT runs_status_allowed CHECK (status IN (${statuses}${extra}));
    ALTER TABLE run_steps DROP CONSTRAINT run_steps_result_kind_check,
    ADD CONSTRAINT run_steps_result_kind_check CHECK (result_kind IN (${kinds}${extra}));`;
}

exports.up = pgm => pgm.sql(`${lock} ${checks(", 'cancelled'")}`);
exports.down = pgm => pgm.sql(`${lock}
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM runs WHERE status = 'cancelled')
      OR EXISTS (SELECT 1 FROM run_steps WHERE result_kind = 'cancelled') THEN
      RAISE EXCEPTION 'Cannot remove recorded Run cancellation';
    END IF;
  END $$;
  ${checks('')}`);
