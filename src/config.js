import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Project root (one level above src/). */
export const ROOT = join(__dirname, '..');

/**
 * Minimal .env parser — avoids a dotenv dependency. Reads KEY=VALUE lines,
 * ignores blanks and `#` comments, strips surrounding quotes. Does not override
 * variables already present in process.env.
 * @returns {Record<string,string>} the parsed values
 */
export function loadEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return out;
}

/**
 * Load and validate repos.json.
 * @returns {{ authorEmails: string[], since: string|null, repos: Array<{host:string,slug:string,account?:string}> }}
 */
export function loadConfig() {
  const path = join(ROOT, 'repos.json');
  if (!existsSync(path)) throw new Error(`Missing config: ${path}`);
  const cfg = JSON.parse(readFileSync(path, 'utf8'));

  if (!Array.isArray(cfg.authorEmails) || cfg.authorEmails.length === 0) {
    throw new Error('repos.json: "authorEmails" must be a non-empty array');
  }
  if (!Array.isArray(cfg.repos) || cfg.repos.length === 0) {
    throw new Error('repos.json: "repos" must be a non-empty array');
  }
  // Normalise emails to lowercase for case-insensitive matching.
  cfg.authorEmails = cfg.authorEmails.map((e) => String(e).toLowerCase());
  cfg.since = cfg.since || null;
  for (const r of cfg.repos) {
    if (!r.host || !r.slug) throw new Error(`repos.json: each repo needs host + slug (got ${JSON.stringify(r)})`);
    if (r.host !== 'bitbucket' && r.host !== 'github') {
      throw new Error(`repos.json: host must be 'bitbucket' or 'github' (got ${r.host} for ${r.slug})`);
    }
  }
  return cfg;
}

/** A stable cache/dedup key for a repo. */
export function repoKey(repo) {
  return `${repo.host}:${repo.slug}`;
}
