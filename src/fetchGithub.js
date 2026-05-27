import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoKey } from './config.js';
import { getRepoCursors } from './cache.js';
import { mapLimit } from './http.js';

const exec = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024; // gh --paginate output can be large
const DAY = 86_400_000;

/** Run `gh <args...>` and return trimmed stdout. */
async function gh(args) {
  const { stdout } = await exec('gh', args, { maxBuffer: MAX_BUFFER });
  return stdout;
}

/** Run a `gh api` call with a jq filter, returning parsed NDJSON objects. */
async function ghJq(endpoint, jq) {
  const out = await gh(['api', endpoint, '--paginate', '--jq', jq]);
  const rows = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      /* skip malformed line */
    }
  }
  return rows;
}

/** The currently active `gh` login, or null if gh is unavailable / not logged in. */
async function activeAccount() {
  try {
    return (await gh(['api', 'user', '--jq', '.login'])).trim();
  } catch {
    return null;
  }
}

/**
 * Fetch this user's commits across all branches of one GitHub repo.
 * GitHub supports a server-side `author` filter, so this is cheap. Incremental:
 * only commits newer than the per-repo watermark (with a 2-day overlap) are pulled.
 */
async function fetchRepo({ slug, authorEmails, sinceTs, cursors, defaultOnly, log }) {
  const emails = new Set(authorEmails);

  // Effective lower bound: max(config.since, last seen) minus a small overlap.
  const prevNewest = cursors.__newest ? Date.parse(cursors.__newest) : -Infinity;
  let lowerTs = Math.max(sinceTs, Number.isFinite(prevNewest) ? prevNewest - 2 * DAY : -Infinity);
  const sinceParam = Number.isFinite(lowerTs) ? `&since=${new Date(lowerTs).toISOString()}` : '';

  // Branches (default branch alone if --default-only).
  let branches;
  try {
    if (defaultOnly) {
      const def = await gh(['api', `repos/${slug}`, '--jq', '.default_branch']);
      branches = [def.trim()];
    } else {
      // NB: gh --jq emits raw (unquoted) strings, which JSON.parse can't read.
      // Emit an object so each line is valid JSON.
      branches = (await ghJq(`repos/${slug}/branches?per_page=100`, '.[] | {name: .name}'))
        .map((o) => o.name)
        .filter(Boolean);
    }
  } catch (err) {
    log(`  ! ${slug}: cannot list branches (${String(err.message).split('\n')[0]}) — skipped`);
    return [];
  }

  const found = new Map(); // sha -> commit (dedups across branches/emails)
  let newestSeen = cursors.__newest || null;

  await mapLimit(
    branches.flatMap((b) => authorEmails.map((e) => ({ b, e }))),
    6,
    async ({ b, e }) => {
      const ep = `repos/${slug}/commits?sha=${encodeURIComponent(b)}&author=${encodeURIComponent(e)}&per_page=100${sinceParam}`;
      let rows;
      try {
        rows = await ghJq(ep, '.[] | {sha: .sha, date: .commit.author.date, email: (.commit.author.email // "")}');
      } catch (err) {
        if (process.env.STREAKS_DEBUG) log(`    [debug] ${slug}@${b}/${e}: ${String(err.message).split('\n')[0]}`);
        return; // empty branch / inaccessible / no commits for this author
      }
      for (const c of rows) {
        if (!c.sha || !c.date) continue;
        if (Date.parse(c.date) < sinceTs) continue;
        // Defensive: keep only our emails (server filter is authoritative, this trims edge cases).
        if (c.email && !emails.has(c.email.toLowerCase())) continue;
        found.set(c.sha, { sha: c.sha, repo: slug, host: 'github', date: c.date });
        if (!newestSeen || c.date > newestSeen) newestSeen = c.date;
      }
    },
  );

  if (newestSeen) cursors.__newest = newestSeen;
  log(`  ✓ ${slug}: +${found.size} commit(s)`);
  return [...found.values()];
}

/**
 * Fetch all configured GitHub repos. Groups repos by the `account` that can read
 * them and switches the active `gh` login per group (restoring it afterwards).
 * @returns {Promise<Array<{sha,repo,host,date}>>}
 */
export async function fetchGithubAll(config, cache, { sinceTs, defaultOnly, log }) {
  const repos = config.repos.filter((r) => r.host === 'github');
  if (repos.length === 0) return [];

  const original = await activeAccount();
  if (!original) {
    log(`\n⚠️  gh CLI not available / not logged in — skipping ${repos.length} GitHub repo(s).`);
    return [];
  }

  // Group by account; process the already-active account first to avoid a switch.
  const byAccount = new Map();
  for (const r of repos) {
    const acc = r.account || original;
    if (!byAccount.has(acc)) byAccount.set(acc, []);
    byAccount.get(acc).push(r);
  }
  const order = [...byAccount.keys()].sort((a, b) => (a === original ? -1 : b === original ? 1 : 0));

  log(`\nGitHub — ${repos.length} repo(s) across ${byAccount.size} account(s):`);
  const all = [];
  try {
    for (const acc of order) {
      if (acc !== original) {
        try {
          await gh(['auth', 'switch', '--user', acc]);
        } catch {
          log(`  ! cannot switch to gh account "${acc}" — its repos may 404 if private`);
        }
      }
      const group = byAccount.get(acc);
      const perRepo = await mapLimit(group, 4, (r) =>
        fetchRepo({
          slug: r.slug,
          authorEmails: config.authorEmails,
          sinceTs,
          cursors: getRepoCursors(cache, repoKey(r)),
          defaultOnly,
          log,
        }),
      );
      all.push(...perRepo.flat());
    }
  } finally {
    const now = await activeAccount();
    if (now && now !== original) {
      await gh(['auth', 'switch', '--user', original]).catch(() => {});
    }
  }
  return all;
}
