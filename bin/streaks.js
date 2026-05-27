#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadEnv, PKG_ROOT, WORK_DIR, PKG_NAME } from '../src/config.js';
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
    if (a === 'update' || a === 'init') continue;
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

Usage:
  streaks init              Create a repos.json in the current folder to edit
  streaks update [options]  Build the dashboard from your commits

Not installed globally? Prefix any command with:  npx ${PKG_NAME}

Options:
  --full            Ignore the cache and re-fetch all history
  --since=YYYY-MM-DD Override the history start date for this run
  --default-only    Only the main/default branch per repo (API path; faster)
  --no-local        Skip local git; use the host APIs for every repo
  --public          Share-safe build -> dist/public.html (hides emails, redacts
                    repos marked "private" in repos.json into one "Private/work" row)
  --open            Open the dashboard in your browser when done
  -h, --help        Show this help

Files (in the current directory):
  repos.json   repos + author emails + since   (run \`streaks init\` to scaffold)
  .env         optional, for Bitbucket API fallback
  dist/        generated dashboard(s)`;

const log = (m) => process.stdout.write(m + '\n');

/** Scaffold a repos.json in the current directory from the bundled example. */
function runInit() {
  const src = join(PKG_ROOT, 'repos.example.json');
  const dest = join(WORK_DIR, 'repos.json');
  if (existsSync(dest)) {
    log(`repos.json already exists — not overwriting:\n  ${dest}`);
  } else {
    copyFileSync(src, dest);
    log(`Created ${dest}`);
    log(`\nNext: edit repos.json (your repos + author emails), then run:`);
    log(`  streaks update --open            (if installed globally)`);
    log(`  npx ${PKG_NAME} update --open     (if using npx)`);
  }
  log(`\n(Optional) For Bitbucket API fallback, copy the example env:\n  cp "${join(PKG_ROOT, '.env.example')}" .env`);
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  if (opts.help) { log(HELP); return; }

  const cmd = argv.find((a) => !a.startsWith('-')) || 'update';
  if (cmd === 'init') { runInit(); return; }

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
  let skippedBitbucket = [];
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
      const res = await fetchBitbucketAll(apiConfig, cache, fetchOpts);
      bbCommits = res.commits;
      skippedBitbucket = res.skipped;
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

  // Surface skipped Bitbucket repos clearly, but keep going (graceful degradation).
  if (skippedBitbucket.length) {
    log(`\n⚠️  ${skippedBitbucket.length} Bitbucket repo(s) skipped — not cloned locally and no/invalid token.`);
    log(`    Totals may undercount these. Clone them locally, or set BITBUCKET_API_TOKEN in .env:`);
    for (const s of skippedBitbucket) log(`      • ${s}`);
  }

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
  // Show a clean message for expected errors; full stack only with STREAKS_DEBUG.
  const msg = err && err.message ? err.message : String(err);
  console.error('\n✖ ' + (process.env.STREAKS_DEBUG && err && err.stack ? err.stack : msg));
  process.exit(1);
});
