import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WORK_DIR } from './config.js';

const CACHE_DIR = join(WORK_DIR, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'commits.json');

/** A fresh empty cache (avoids structuredClone, which needs Node 17+). */
const emptyCache = () => ({ version: 1, commits: {}, repos: {} });

/**
 * The on-disk cache shape:
 * {
 *   version: 1,
 *   commits: { [sha]: { repo, host, date } },   // only author-matching commits we keep
 *   repos:   { [repoKey]: { cursors: { [branch]: tipSha } } }  // incremental walk markers
 * }
 */
/**
 * Load the cache from disk. Returns a fresh empty cache when `fresh` is true
 * (used by --full) or when no cache exists / is unreadable.
 * @param {boolean} [fresh=false]
 */
export function loadCache(fresh = false) {
  if (fresh || !existsSync(CACHE_FILE)) return emptyCache();
  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    return { version: 1, commits: data.commits || {}, repos: data.repos || {} };
  } catch {
    return emptyCache();
  }
}

/** Persist the cache to disk (creates .cache/ on demand). */
export function saveCache(cache) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

/** Read the stored cursors object for a repo (branch -> tip sha), never null. */
export function getRepoCursors(cache, key) {
  cache.repos[key] = cache.repos[key] || { cursors: {} };
  cache.repos[key].cursors = cache.repos[key].cursors || {};
  return cache.repos[key].cursors;
}

/**
 * Merge fetched commits into the cache (dedup by sha — last write wins, which is
 * fine since the same sha carries identical date/repo).
 * @param {object} cache
 * @param {Array<{sha:string,repo:string,host:string,date:string}>} commits
 */
export function mergeCommits(cache, commits) {
  for (const c of commits) {
    cache.commits[c.sha] = { repo: c.repo, host: c.host, date: c.date };
  }
}
