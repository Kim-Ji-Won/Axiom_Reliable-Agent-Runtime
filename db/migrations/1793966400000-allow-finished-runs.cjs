exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE runs
      DROP CONSTRAINT runs_status_allowed,
      ADD CONSTRAINT runs_status_allowed CHECK (status IN ('queued', 'running', 'completed', 'failed'))
  `);
};

// Validate atomically: terminal rows prevent downgrade without changing data or history.
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE runs
      DROP CONSTRAINT runs_status_allowed,
      ADD CONSTRAINT runs_status_allowed CHECK (status IN ('queued', 'running'))
  `);
};
