const DAY_MS = 86_400_000;

/** ISO timestamp -> 'YYYY-MM-DD' in the machine's local timezone. */
function localDay(iso) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** A calendar-day-string -> integer day number (TZ-independent, for adjacency). */
function dayNum(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** Today's local day string. */
function today() {
  return localDay(new Date().toISOString());
}

/**
 * Compute the longest run of consecutive calendar days present in `set`.
 * @param {string[]} sortedDays ascending day strings
 */
function longestStreak(sortedDays) {
  let best = { length: 0, start: null, end: null };
  let runStart = null;
  let prev = null;
  let len = 0;
  for (const day of sortedDays) {
    const n = dayNum(day);
    if (prev !== null && n === prev + 1) {
      len += 1;
    } else {
      len = 1;
      runStart = day;
    }
    if (len > best.length) best = { length: len, start: runStart, end: day };
    prev = n;
  }
  return best;
}

/**
 * Current streak: consecutive active days ending at the most recent active day,
 * but only counts as "current" if that day is today or yesterday (grace period).
 * @param {Set<string>} daySet
 * @param {string[]} sortedDays ascending
 */
function currentStreak(daySet, sortedDays) {
  if (sortedDays.length === 0) return { length: 0, start: null, end: null };
  const latest = sortedDays[sortedDays.length - 1];
  const todayN = dayNum(today());
  const latestN = dayNum(latest);
  if (todayN - latestN > 1) return { length: 0, start: null, end: null }; // streak broken

  let len = 0;
  let n = latestN;
  let start = latest;
  while (daySet.has(dayFromNum(n))) {
    len += 1;
    start = dayFromNum(n);
    n -= 1;
  }
  return { length: len, start, end: latest };
}

/** Inverse of dayNum: integer day number -> 'YYYY-MM-DD'. */
function dayFromNum(n) {
  const d = new Date(n * DAY_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Adaptive intensity thresholds (lower bounds for levels 1..4), from the quantiles
 * of non-zero daily counts — so the heatmap gradient adapts to each person's volume
 * instead of using fixed cutoffs. Strictly increasing; t1 = 1.
 */
function computeLevels(days) {
  const counts = Object.values(days)
    .filter((c) => c > 0)
    .sort((a, b) => a - b);
  if (counts.length === 0) return [1, 2, 3, 4];
  const q = (p) => counts[Math.min(counts.length - 1, Math.floor(p * counts.length))];
  const t = [1, q(0.25), q(0.5), q(0.75)];
  for (let i = 1; i < 4; i += 1) if (t[i] <= t[i - 1]) t[i] = t[i - 1] + 1;
  return t;
}

/**
 * Build the dashboard data model from the cached commits.
 * @param {Record<string,{repo,host,date}>} commits sha -> commit
 * @param {{authorEmails:string[]}} config
 */
export function aggregate(commits, config) {
  // Repos marked `hidden: true` are dropped from the per-repo breakdown, but their
  // commits still count toward the heatmap, totals and streaks.
  const hiddenSet = new Set((config.repos || []).filter((r) => r.hidden).map((r) => `${r.host}:${r.slug}`));

  const days = {}; // 'YYYY-MM-DD' -> count
  const byRepo = {}; // 'host:slug' -> count
  const byHost = { bitbucket: 0, github: 0 };
  const byDow = [0, 0, 0, 0, 0, 0, 0]; // Sun..Sat
  let first = null;
  let last = null;
  let total = 0;

  for (const sha of Object.keys(commits)) {
    const c = commits[sha];
    const day = localDay(c.date);
    days[day] = (days[day] || 0) + 1;
    const rk = `${c.host}:${c.repo}`;
    if (!hiddenSet.has(rk)) byRepo[rk] = (byRepo[rk] || 0) + 1;
    if (byHost[c.host] === undefined) byHost[c.host] = 0;
    byHost[c.host] += 1;
    const [y, m, d] = day.split('-').map(Number);
    byDow[new Date(y, m - 1, d).getDay()] += 1;
    if (!first || day < first) first = day;
    if (!last || day > last) last = day;
    total += 1;
  }

  const sortedDays = Object.keys(days).sort();
  const daySet = new Set(sortedDays);

  let maxDay = { date: null, count: 0 };
  for (const [date, count] of Object.entries(days)) {
    if (count > maxDay.count) maxDay = { date, count };
  }

  const repoList = Object.entries(byRepo)
    .map(([key, count]) => {
      const [host, ...rest] = key.split(':');
      return { repo: rest.join(':'), host, count };
    })
    .sort((a, b) => b.count - a.count);

  return {
    generatedAt: new Date().toISOString(),
    authorEmails: config.authorEmails,
    range: { first, last },
    totals: {
      commits: total,
      activeDays: sortedDays.length,
      repos: repoList.length,
      maxDay,
      currentStreak: currentStreak(daySet, sortedDays),
      longestStreak: longestStreak(sortedDays),
    },
    days,
    byRepo: repoList,
    byHost,
    byDow,
    levels: computeLevels(days),
  };
}

/**
 * Produce a share-safe copy of the aggregated data: hides author emails (uses
 * `config.displayName` instead) and collapses every repo marked `private: true`
 * in repos.json into a single nameless "Private / work" row. The heatmap, streaks
 * and totals are unchanged — none of those leak identifying detail.
 * @param {object} data result of aggregate()
 * @param {{ displayName?: string, repos: Array }} config
 */
export function publicize(data, config) {
  const privateSet = new Set(
    config.repos.filter((r) => r.private).map((r) => `${r.host}:${r.slug}`),
  );

  const publicRows = [];
  let privCommits = 0;
  let privRepos = 0;
  for (const r of data.byRepo) {
    if (privateSet.has(`${r.host}:${r.repo}`)) {
      privCommits += r.count;
      privRepos += 1;
    } else {
      publicRows.push(r);
    }
  }
  if (privRepos > 0) {
    publicRows.push({ repo: `Private / work (${privRepos} repos)`, host: 'private', count: privCommits });
  }
  publicRows.sort((a, b) => b.count - a.count);

  return {
    ...data,
    displayName: config.displayName || 'Developer',
    authorEmails: null, // never expose emails in a public build
    byRepo: publicRows,
  };
}
