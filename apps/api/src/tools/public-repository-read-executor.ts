import { createPublicReadWithTransport, type PublicReadOptions } from './public-repository-read-internal.js';
export type { PublicReadOptions, PublicReadCallOptions } from './public-repository-read-internal.js';

// Separate from the pure in-memory executor. No request at import/construction;
// the production API exposes neither transport nor endpoint/deadline overrides.
export function createPublicRepositoryReadExecutor(options: PublicReadOptions = {}) {
  const nativeFetch = globalThis.fetch;
  return createPublicReadWithTransport(options, (url, init) => nativeFetch(url, init));
}
