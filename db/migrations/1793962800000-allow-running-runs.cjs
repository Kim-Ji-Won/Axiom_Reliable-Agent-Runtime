exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE runs
      DROP CONSTRAINT runs_status_queued,
      ADD CONSTRAINT runs_status_allowed CHECK (status IN ('queued', 'running'))
  `);
};

// A single ALTER validates existing rows atomically. If any Run is running,
// PostgreSQL rejects this downgrade without rewriting rows or removing the old constraint.
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE runs
      DROP CONSTRAINT runs_status_allowed,
      ADD CONSTRAINT runs_status_queued CHECK (status IN ('queued'))
  `);
};
