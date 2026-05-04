'use strict';

/**
 * Source adapter contract for skills/research/.
 * Each source adapter (pubmed, clinicaltrials, medrxiv) must implement:
 *   { name, fetch, parseId, rateLimit, healthCheck }
 *
 * @typedef {Object} Article
 * @property {string} source                   — 'pubmed' | 'clinicaltrials' | 'medrxiv'
 * @property {string} source_id                — adapter-specific stable id
 * @property {string} title
 * @property {string|null} abstract
 * @property {string} url
 * @property {string[]} authors
 * @property {string|null} published_at        — ISO 8601 (YYYY-MM-DD)
 *
 * @typedef {Object} SourceAdapter
 * @property {string} name
 * @property {(query: string|null, since: Date|null) => Promise<Article[]>} fetch
 * @property {(article: Article) => string} parseId
 * @property {{ requestsPerSecond: number, burst: number }} rateLimit
 * @property {() => Promise<boolean>} healthCheck
 */

const REQUIRED_SHAPE = {
  name:        'string',
  fetch:       'function',
  parseId:     'function',
  rateLimit:   'object',
  healthCheck: 'function',
};

function assertAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('adapter must be a non-null object');
  }
  for (const [key, expected] of Object.entries(REQUIRED_SHAPE)) {
    const actual = typeof adapter[key];
    if (actual !== expected) {
      throw new TypeError(`adapter.${key} must be ${expected}, got ${actual}`);
    }
  }
  const rl = adapter.rateLimit;
  if (!rl || typeof rl.requestsPerSecond !== 'number' || typeof rl.burst !== 'number') {
    throw new TypeError('adapter.rateLimit must have numeric requestsPerSecond and burst');
  }
  if (rl.requestsPerSecond <= 0 || rl.burst <= 0) {
    throw new TypeError('adapter.rateLimit values must be positive');
  }
}

module.exports = { assertAdapter };
