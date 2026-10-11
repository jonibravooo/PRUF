# PRUF

**Don't trust. PRUF it.** — [pruf.fun](https://pruf.fun)

PRUF checks whether the tech a crypto project promises actually exists. Paste a Solana CA or a website and PRUF:

- reads the site and its JavaScript (embedded addresses, wallet code, fake `Math.random()` counters, leaked keys, site builder)
- probes every program and wallet it finds on-chain (exists? used? who can upgrade it? verified build?)
- reads the GitHub repo (real code or empty template? does `declare_id!` match a deployed program? is the server the site calls in the repo?)
- reads the token: launchpad, dev wallet, fee flows, X posts
- then asks Claude to match every promise to that evidence: **Real**, **Trust me bro**, **Cap** or **Vapor**

## Why this repo is public

A tool that tells you not to trust closed code can't run on closed code. Every deploy of pruf.fun is built from this repo, and the footer of the live site links to the exact commit it runs (`/version.json` has it too). PRUF uses that same check on other projects.

The one part you still have to trust is the AI model's judgment. Every claim it makes cites the evidence, so you can check it yourself.

## How it works

| File | What it does |
| --- | --- |
| `index.html` | The whole front end (no build step) |
| `netlify/functions/check.mjs` | The engine: collects evidence, streams it, asks Claude for the verdict |
| `scripts/stamp.mjs` | Writes the deployed commit into the site at build time |
| `assets/` | Prufy, the mascot |

## Run your own

Deploy to Netlify and set these environment variables:

| Variable | Required | What for |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | The verdict |
| `SOLANA_RPC_URL` | recommended | A Helius RPC URL (on-chain probes, DAS, dev wallet history) |
| `GITHUB_TOKEN` | recommended | Higher GitHub API limits |
| `X_BEARER_TOKEN` | optional | Reads a project's latest X posts |
| `X_MAX_REPLIES` | optional | Replies read under the checked post (default 15, `0` = off) |
| `JINA_API_KEY` | optional | Faster website reading |

No keys live in this repo.

## License

MIT
