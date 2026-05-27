#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { loadConfig, loadEnv } from '../src/config.js';
import { loadCache, saveCache, mergeCommits } from '../src/cache.js';
import { fetchLocalGitAll } from '../src/fetchLocalGit.js';
import { fetchBitbucketAll } from '../src/fetchBitbucket.js';
import { fetchGithubAll } from '../src/fetchGithub.js';
import { aggregate, publicize } from '../src/aggregate.js';
import { render } from '../src/render.js';

/** Parse argv into flags. Supports: --full, --open, --default-only, --since=DATE, --help. */
function parseArgs(argv) {
  const opts = { full: false, open: false, defaultOnly: false, noLocal: false, public: false, since: null, help: false };
  for (const a of argv) {
    if (a === 'update') continue;
    else if (a === '--full') opts.full = true;
    else if (a === '--open') opts.open = true;
    else if (a === '--default-only') opts.defaultOnly = true;
    else if (a === '--no-local') opts.noLocal = true;
    else if (a === '--public') opts.public = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--since=')) opts.since = a.slice('--since='.length);
    else console.warn(`Unknown argument: ${a}`);
  }
  return opts;
}

const HELP = `git-streaks — GitHub-style contribution heatmap for Bitbucket + GitHub

Usage: streaks update [options]

Options:
  --full            Ignore the cache and re-fetch all history
  --since=YYYY-MM-DD Override the history start date for this run
  --default-only    Only the main/default branch per repo (API path; faster)
  --no-local        Skip local git; use the host APIs for every repo
  --public          Share-safe build -> dist/public.html (hides emails, redacts
                    repos marked "private" in repos.json into one "Private/work" row)
  --open            Open the dashboard in your browser when done
  -h, --help        Show this help

Config:  repos.json   (repos + author emails + since)
Auth:    .env         (BITBUCKET_EMAIL + BITBUCKET_API_TOKEN; GitHub via gh CLI)
Output:  dist/index.html`;

const log = (m) => process.stdout.write(m + '\n');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { log(HELP); return; }

  loadEnv();
  const config = loadConfig();
  const since = opts.since || config.since;
  const sinceTs = since ? Date.parse(since) : -Infinity;

  log(`git-streaks — author(s): ${config.authorEmails.join(', ')}`);
  log(`since ${since || 'beginning of time'}${opts.full ? ' · FULL re-fetch (cache ignored)' : ''}${opts.defaultOnly ? ' · default branch only' : ''}`);

  const cache = loadCache(opts.full);
  const before = Object.keys(cache.commits).length;
  const fetchOpts = { sinceTs, defaultOnly: opts.defaultOnly, log };

  // 1) Local git first — instant, complete, no rate limits.
  let localCommits = [];
  let missing = config.repos;
  if (!opts.noLocal) {
    try {
      const res = await fetchLocalGitAll(config, cache, fetchOpts);
      localCommits = res.commits;
      missing = res.missing;
    } catch (err) {
      log(`\n! Local git error: ${String(err.message).split('\n')[0]}`);
    }
    mergeCommits(cache, localCommits);
    saveCache(cache);
  }

  // 2) API fallback, only for repos not found locally. GitHub mutates the active
  //    gh account so run it before Bitbucket; persist each host independently.
  const apiConfig = { ...config, repos: missing };
  let ghCommits = [];
  let bbCommits = [];
  if (missing.some((r) => r.host === 'github')) {
    try {
      ghCommits = await fetchGithubAll(apiConfig, cache, fetchOpts);
    } catch (err) {
      log(`\n! GitHub fetch error: ${String(err.message).split('\n')[0]}`);
    }
    mergeCommits(cache, ghCommits);
    saveCache(cache);
  }
  if (missing.some((r) => r.host === 'bitbucket')) {
    try {
      bbCommits = await fetchBitbucketAll(apiConfig, cache, fetchOpts);
    } catch (err) {
      log(`\n! Bitbucket fetch error: ${String(err.message).split('\n')[0]}`);
    }
    mergeCommits(cache, bbCommits);
    saveCache(cache);
  }

  if (missing.length && !opts.noLocal) {
    log(`\n${missing.length} repo(s) not found locally — used API: ${missing.map((r) => r.slug).join(', ')}`);
  }
  const fetchedThisRun = localCommits.length + ghCommits.length + bbCommits.length;
  const after = Object.keys(cache.commits).length;
  log(`\nFetched ${fetchedThisRun} commit(s) this run · ${after} unique total (+${after - before} new).`);

  let data = aggregate(cache.commits, config);
  if (opts.public) data = publicize(data, config);
  const out = render(data, { outFile: opts.public ? 'public.html' : 'index.html' });

  const t = data.totals;
  log('');
  log(`  Current streak : ${t.currentStreak.length} day(s)`);
  log(`  Longest streak : ${t.longestStreak.length} day(s)`);
  log(`  Total commits  : ${t.commits}`);
  log(`  Active days    : ${t.activeDays}`);
  log(`\n→ ${out}`);

  if (opts.open) execFile('open', [out], () => {});
}

main().catch((err) => {
  console.error('\n✖ ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
