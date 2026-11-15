exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE run_execution_leases (
      run_id UUID PRIMARY KEY REFERENCES runs(id),
      owner_id UUID NOT NULL,
      lease_token UUID NOT NULL UNIQUE,
      lease_seconds INTEGER NOT NULL,
      acquired_at TIMESTAMPTZ NOT NULL,
      renewed_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT run_execution_leases_seconds CHECK (lease_seconds BETWEEN 1 AND 300),
      CONSTRAINT run_execution_leases_finite CHECK
        (isfinite(acquired_at) AND isfinite(renewed_at) AND isfinite(expires_at)),
      CONSTRAINT run_execution_leases_order CHECK (renewed_at >= acquired_at),
      CONSTRAINT run_execution_leases_expiry CHECK
        (expires_at = renewed_at + lease_seconds * INTERVAL '1 second')
    );
  `);
};
exports.down = (pgm) => {
  // Match all Lease writers: parent first, then Lease, in the runner's transaction.
  pgm.sql(`
    LOCK TABLE runs IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE run_execution_leases IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM run_execution_leases) THEN
        RAISE EXCEPTION 'Cannot drop nonempty run_execution_leases';
      END IF;
    END $$;
    DROP TABLE run_execution_leases;
  `);
};
