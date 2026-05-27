import { getJson, mapLimit } from './http.js';
import { repoKey } from './config.js';
import { getRepoCursors } from './cache.js';

const API = 'https://api.bitbucket.org/2.0/repositories';
const COMMIT_FIELDS = 'values.hash,values.date,values.author.raw,next';
const BRANCH_FIELDS = 'values.name,values.target.hash,values.target.date,next';

/** Extract a lowercased email from a Bitbucket `author.raw` ("Name <email>"). */
function rawEmail(raw) {
  const m = /<([^>]+)>/.exec(raw || '');
  return m ? m[1].toLowerCase() : '';
}

/** Async generator over a paginated Bitbucket collection, following `next`. */
async function* pages(url, headers) {
  let next = url;
  while (next) {
    const data = await getJson(next, { headers });
    yield data.values || [];
    next = data.next || null;
  }
}

/**
 * Fetch this user's commits across all branches of one Bitbucket repo.
 * Walks the main branch incrementally (stops at last run's tip), then collects
 * each other branch's commits that aren't already on main (`include`/`exclude`),
 * which keeps re-runs cheap.
 */
async function fetchRepo({ slug, headers, authorEmails, sinceTs, cursors, defaultOnly, log }) {
  const base = `${API}/${slug}`;
  const emails = new Set(authorEmails);
  const commits = [];

  // Resolve the main branch.
  let main = 'main';
  try {
    const repo = await getJson(`${base}?fields=mainbranch.name`, { headers });
    main = repo?.mainbranch?.name || main;
  } catch (err) {
    log(`  ! ${slug}: cannot read repo (${err.message.split('\n')[0]}) — skipped`);
    return commits;
  }

  // Walk the main branch newest -> oldest, stopping at the cached tip or `since`.
  // If the walk is interrupted (e.g. rate limit), keep the commits gathered so far
  // and DON'T advance the cursor, so the next run resumes from the tip.
  const prevTip = cursors[main];
  let newTip = null;
  let kept = 0;
  let completed = true;
  try {
    outer: for await (const vals of pages(`${base}/commits?include=${encodeURIComponent(main)}&pagelen=100&fields=${COMMIT_FIELDS}`, headers)) {
      for (const c of vals) {
        if (newTip === null) newTip = c.hash;
        if (c.hash === prevTip) break outer;
        if (Date.parse(c.date) < sinceTs) break outer;
        if (emails.has(rawEmail(c.author?.raw))) {
          commits.push({ sha: c.hash, repo: slug, host: 'bitbucket', date: c.date });
          kept++;
        }
      }
    }
  } catch (err) {
    completed = false;
    log(`  ! ${slug}: main walk interrupted (${String(err.message).split('\n')[0]}) — kept ${kept} so far`);
  }
  if (completed && newTip) cursors[main] = newTip;

  // Other branches: only their commits not reachable from main (usually a handful).
  if (!defaultOnly) {
    const branches = [];
    try {
      for await (const vals of pages(`${base}/refs/branches?pagelen=100&fields=${BRANCH_FIELDS}`, headers)) {
        for (const b of vals) {
          if (b.name === main) continue;
          if (b.target?.date && Date.parse(b.target.date) < sinceTs) continue;
          branches.push(b.name);
        }
      }
    } catch (err) {
      log(`  ! ${slug}: branch list failed (${err.message.split('\n')[0]})`);
    }
    for (const br of branches) {
      const url = `${base}/commits?include=${encodeURIComponent(br)}&exclude=${encodeURIComponent(main)}&pagelen=100&fields=${COMMIT_FIELDS}`;
      try {
        b: for await (const vals of pages(url, headers)) {
          for (const c of vals) {
            if (Date.parse(c.date) < sinceTs) break b;
            if (emails.has(rawEmail(c.author?.raw))) {
              commits.push({ sha: c.hash, repo: slug, host: 'bitbucket', date: c.date });
              kept++;
            }
          }
        }
      } catch {
        /* a deleted/inaccessible branch — ignore */
      }
    }
  }

  log(`  ✓ ${slug}: +${kept} commit(s)`);
  return commits;
}

/**
 * Fetch all configured Bitbucket repos. Reads BITBUCKET_EMAIL / BITBUCKET_API_TOKEN
 * from the environment; returns [] (with a warning) when the token is missing.
 * @returns {Promise<{ commits: Array<{sha,repo,host,date}>, skipped: string[] }>}
 *   `skipped` lists slugs that couldn't be fetched (missing/invalid token) so the
 *   caller can warn the user — the run still proceeds.
 */
export async function fetchBitbucketAll(config, cache, { sinceTs, defaultOnly, log }) {
  const repos = config.repos.filter((r) => r.host === 'bitbucket');
  if (repos.length === 0) return { commits: [], skipped: [] };

  // Basic-auth username: the Bitbucket username (app passwords) or the Atlassian
  // account email (scoped API tokens). BITBUCKET_USERNAME wins if both are set.
  const username = process.env.BITBUCKET_USERNAME || process.env.BITBUCKET_EMAIL;
  const token = process.env.BITBUCKET_API_TOKEN;
  if (!token) {
    log(`\n⚠️  BITBUCKET_API_TOKEN not set — skipping ${repos.length} Bitbucket repo(s). (GitHub still runs.)`);
    return { commits: [], skipped: repos.map((r) => r.slug) };
  }

  const headers = {
    Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`,
    Accept: 'application/json',
  };

  // Preflight one authenticated call so a bad token fails fast with guidance
  // instead of printing the same 401 for every repo.
  const probe = await getJson(`${API}/${repos[0].slug}?fields=mainbranch.name`, { headers }).then(
    () => null,
    (e) => e,
  );
  if (probe && /\b401\b|invalid|not supported|expired/i.test(String(probe.message))) {
    log(`\n⚠️  Bitbucket auth failed (401) — your token is not accepted by the Bitbucket API.`);
    log(`    A plain Jira/Atlassian API token does NOT work with Bitbucket. Use ONE of:`);
    log(`      • Atlassian API token WITH SCOPES (recommended): id.atlassian.com → Security →`);
    log(`        "Create API token with scopes" → app Bitbucket → scope read:repository:bitbucket.`);
    log(`        Keep BITBUCKET_EMAIL = your Atlassian email.`);
    log(`      • Bitbucket App Password: bitbucket.org → Personal settings → App passwords →`);
    log(`        Repositories: Read. Then set BITBUCKET_USERNAME = your Bitbucket username (not email).`);
    log(`    Skipping ${repos.length} Bitbucket repo(s).`);
    return { commits: [], skipped: repos.map((r) => r.slug) };
  }

  log(`\nBitbucket — ${repos.length} repo(s):`);
  const perRepo = await mapLimit(repos, 3, (r) =>
    fetchRepo({
      slug: r.slug,
      headers,
      authorEmails: config.authorEmails,
      sinceTs,
      cursors: getRepoCursors(cache, repoKey(r)),
      defaultOnly,
      log,
    }),
  );
  return { commits: perRepo.flat(), skipped: [] };
}
