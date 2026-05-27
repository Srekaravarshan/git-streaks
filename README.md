# git-streaks

A self-hosted, GitHub-style **contribution heatmap** across **Bitbucket + GitHub**, multiple
accounts and multiple author emails — because Bitbucket has no streaks graph.

Reads your commits (filtered to your emails, deduped by commit SHA, across **all branches**) and
renders a self-contained brutalist HTML dashboard: a per-year heatmap, current/longest streak,
totals, per-repo and per-day-of-week breakdowns.

**Local-first:** for any repo cloned on your machine it uses `git log` — instant, complete, no
rate limits. The host REST APIs are used only as a fallback for repos that aren't cloned locally.

## Setup

Requires **Node ≥ 18**. Optional: **`gh` CLI** and/or a **Bitbucket token** — only needed for
repos you haven't cloned locally.

```bash
nvm use                         # uses .nvmrc (Node 20)
cp repos.example.json repos.json
```

Edit **`repos.json`** to curate which repos count, your author emails, the `since` date, and
optionally `localRoots` (folders to scan for clones; defaults to `~/Documents`). `repos.json` is
gitignored — your personal config never gets committed.

`.env` (only for API fallback — see `.env.example` for the two valid Bitbucket token types):

```
BITBUCKET_EMAIL=you@example.com       # or BITBUCKET_USERNAME for an app password
BITBUCKET_API_TOKEN=...               # leave empty to skip Bitbucket API entirely
```

## Usage

```bash
streaks update            # incremental fetch -> aggregate -> dist/index.html
streaks update --open     # ...and open it in the browser
streaks update --full     # ignore the cache, re-fetch everything
streaks update --since=2024-01-01
streaks update --public         # share-safe build -> dist/public.html (see below)
streaks update --no-local       # skip local git; use the host APIs for every repo
streaks update --default-only   # API path only: main branch per repo (faster)
streaks --help
```

Or via npm: `npm run update` · `npm start` (update + open) · `npm run full` · `npm run public`.

Open **`dist/index.html`** in any browser. Re-run `streaks update` anytime — local git is fast, so
a refresh takes seconds.

## Sharing it publicly

`streaks update --public` writes **`dist/public.html`** — a share-safe build for a portfolio or
LinkedIn:

- **Emails are hidden**, replaced by `displayName` from `repos.json`.
- Every repo marked **`"private": true`** is collapsed into a single nameless `Private / work`
  row — internal repo names never appear. Public repos keep their names.
- The heatmap, streaks and totals are unchanged (activity level isn't sensitive).

Your full, unredacted dashboard stays at `dist/index.html`; only `public.html` is safe to deploy.

## How it works

- **Local git (primary)** — for each repo found under `localRoots`, runs
  `git log --all --author=<your emails>`. Instant, complete (all branches), no rate limits.
- **GitHub (fallback)** — via `gh api`, server-side `author=` filter, switching between accounts.
- **Bitbucket (fallback)** — REST v2 Basic auth. No server-side author filter, so it walks history
  bounded by `since`; large repos are rate-limited, which is exactly why local-first exists.
- **Dedup** by commit SHA across all repos/branches/sources — clones and forks collapse automatically.

State lives in `.cache/commits.json` (gitignored). Delete it (or use `--full`) to rebuild.

## License

MIT © Srekaravarshan N K
