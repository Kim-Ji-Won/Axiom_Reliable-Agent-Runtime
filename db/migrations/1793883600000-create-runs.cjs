exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE runs (
      id UUID PRIMARY KEY,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT runs_task_length CHECK (char_length(task) BETWEEN 1 AND 4000),
      CONSTRAINT runs_task_nonblank CHECK (
        char_length(btrim(task, U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF')) > 0
      ),
      CONSTRAINT runs_status_queued CHECK (status IN ('queued'))
    )
  `);
};

// Destructive: used only in disposable test schemas by the supplied runner.
exports.down = (pgm) => { pgm.sql('DROP TABLE runs'); };
