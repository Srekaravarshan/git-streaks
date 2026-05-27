import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const MAX_BUFFER = 128 * 1024 * 1024;

/** Default place to look for clones. Override via `localRoots` in repos.json. */
const DEFAULT_ROOTS = [join(homedir(), 'Documents')];

/** Normalise a git host to the short form used in repos.json. */
function hostShort(h) {
  if (h.includes('bitbucket')) return 'bitbucket';
  if (h.includes('github')) return 'github';
  return h;
}

/** Parse an origin URL (ssh/https/scp-style) into { host, slug }. */
function parseRemote(url) {
  let m = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url); // git@host:owner/repo.git
  if (m) return { host: hostShort(m[1]), slug: m[2] };
  m = /^ssh:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(url); // ssh://git@host/owner/repo.git
  if (m) return { host: hostShort(m[1]), slug: m[2] };
  m = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(url); // https://host/owner/repo.git
  if (m) return { host: hostShort(m[1]), slug: m[2] };
  return null;
}

/**
 * Scan the given roots for git clones and map `${host}:${slugLower}` -> repo path.
 * First clone found for a slug wins (duplicate clones collapse later via SHA dedup).
 */
async function buildLocalIndex(roots, log) {
  const index = new Map();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let stdout = '';
    try {
      ({ stdout } = await exec(
        'find',
        [root, '-maxdepth', '6', '-type', 'd', '-name', 'node_modules', '-prune', '-o', '-name', '.git', '-type', 'd', '-print'],
        { maxBuffer: MAX_BUFFER },
      ));
    } catch (err) {
      stdout = err.stdout || '';
    }
    for (const line of stdout.split('\n')) {
      const gitDir = line.trim();
      if (!gitDir) continue;
      const repoPath = gitDir.replace(/\/\.git$/, '');
      let url;
      try {
        ({ stdout: url } = await exec('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], { maxBuffer: MAX_BUFFER }));
      } catch {
        continue; // no origin
      }
      const parsed = parseRemote(url.trim());
      if (!parsed) continue;
      const key = `${parsed.host}:${parsed.slug.toLowerCase()}`;
      if (!index.has(key)) index.set(key, repoPath);
    }
  }
  return index;
}

/**
 * Read this user's commits from local clones using `git log --all`.
 * Returns the commits found and the list of configured repos NOT found locally
 * (so the caller can fall back to the API for those).
 * @returns {Promise<{ commits: Array<{sha,repo,host,date}>, missing: Array }>}
 */
export async function fetchLocalGitAll(config, cache, { sinceTs, log }) {
  const roots = Array.isArray(config.localRoots) && config.localRoots.length ? config.localRoots : DEFAULT_ROOTS;
  log(`\nLocal git — indexing clones under ${roots.join(', ')} …`);
  const index = await buildLocalIndex(roots, log);
  log(`  indexed ${index.size} local repo(s)`);

  // `--author` is OR'd across multiple flags; matches against "Name <email>".
  const authorArgs = config.authorEmails.flatMap((e) => ['--author', e]);
  const commits = [];
  const missing = [];

  for (const r of config.repos) {
    const key = `${r.host}:${r.slug.toLowerCase()}`;
    const repoPath = index.get(key) || (r.path && existsSync(r.path) ? r.path : null);
    if (!repoPath) {
      missing.push(r);
      continue;
    }
    let kept = 0;
    try {
      const { stdout } = await exec(
        'git',
        ['-C', repoPath, 'log', '--all', '--regexp-ignore-case', ...authorArgs, '--pretty=format:%H%x09%aI'],
        { maxBuffer: MAX_BUFFER },
      );
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        const tab = line.indexOf('\t');
        if (tab === -1) continue;
        const date = line.slice(tab + 1);
        if (Date.parse(date) < sinceTs) continue;
        commits.push({ sha: line.slice(0, tab), repo: r.slug, host: r.host, date });
        kept++;
      }
      log(`  ✓ ${r.host}:${r.slug}: ${kept} commit(s)  [local]`);
    } catch (err) {
      log(`  ! ${r.slug}: git log failed (${String(err.message).split('\n')[0]}) — will try API`);
      missing.push(r);
    }
  }
  return { commits, missing };
}
