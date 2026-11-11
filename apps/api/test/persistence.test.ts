import { describe, expect, it, vi } from 'vitest';
import { validateTask, InvalidRunInputError, createRunRepository } from '../src/persistence/run-repository.js';
import { readDatabaseUrl } from '../../../db/connection.js';

describe('persistence input boundaries', () => {
  it.each(['', ' \t\n', '\u00a0\ufeff', 'a'.repeat(4001), null, 1, 'a\0b', '\ud800'])('rejects invalid task %j', (task) => {
    expect(() => validateTask(task)).toThrow(InvalidRunInputError);
  });
  it.each([' x ', '한글', '😀'.repeat(4000)])('accepts bounded Unicode text', (task) => {
    expect(() => validateTask(task)).not.toThrow();
  });
  it.each([
    'postgresql://axiom@127.0.0.1:56432/axiom',
    'postgresql://axiom_test@remote.example/axiom_test',
    'postgresql://axiom_test@localhost/axiom_test?dbname=axiom',
    'postgresql://axiom_test@localhost/axiom_test?options=-csearch_path=public',
    'postgresql://axiom_test@localhost/axiom_test#ignored',
  ])('rejects unsafe test target', (url) => {
    expect(() => readDatabaseUrl('test', { TEST_DATABASE_URL: url })).toThrow();
  });
  it('does not fall back to the development URL', () => {
    expect(() => readDatabaseUrl('test', { DATABASE_URL: 'postgresql://axiom@localhost/axiom' })).toThrow('TEST_DATABASE_URL');
  });
});

it('rejects malformed start IDs before querying PostgreSQL', async () => {
  const query = vi.fn();
  await expect(createRunRepository({ query }).tryStartRun('bad-id')).rejects.toThrow(InvalidRunInputError);
  expect(query).not.toHaveBeenCalled();
});

// Deliberately bypass TypeScript to verify the runtime boundary before any SQL.
it.each([
  ['bad-id', 'completed'], [null, 'failed'], [123, 'completed'],
  ['12345678-1234-4234-8234-123456789abc', 'queued'],
  ['12345678-1234-4234-8234-123456789abc', 'running'],
  ['12345678-1234-4234-8234-123456789abc', null],
  ['12345678-1234-4234-8234-123456789abc', 1],
  ['12345678-1234-4234-8234-123456789abc', 'COMPLETED'],
])('rejects invalid finish input %# without querying', async (id, outcome) => {
  const query = vi.fn();
  const repo = createRunRepository({ query });
  await expect(repo.tryFinishRun(id as string, outcome as Parameters<typeof repo.tryFinishRun>[1]))
    .rejects.toThrow(InvalidRunInputError);
  expect(query).not.toHaveBeenCalled();
});
