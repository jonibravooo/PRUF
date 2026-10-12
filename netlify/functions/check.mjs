// PRUF — checks whether the tech a crypto project promises actually exists.
// It inspects the project's own website code, probes every program/contract/wallet it finds on-chain,
// reads the GitHub repo, then asks Claude to match each promised feature against that evidence.
// Streams newline-delimited JSON events: {t:"step"}, {t:"facts"}, {t:"report"}, {t:"error"}.

import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

// Saved reports: share links, "recently checked", and a 6h cache so the same check isn't paid twice.
function reportStore(){ try { return getStore("reports"); } catch { return null; } }
const reportId = key => createHash("sha1").update(String(key).toLowerCase()).digest("hex").slice(0, 10);
// Same store, but reads always see the latest write — needed for "is someone already checking this?" locks.
function liveStore(){ try { return getStore({ name: "reports", consistency: "strong" }); } catch { return reportStore(); } }
const sleep = ms => new Promise(ok => setTimeout(ok, ms));

// Fresh checks per IP per 2 hours (saved checks don't count). PRUF_RATE_LIMIT in Netlify changes it; 0 = off.
// The IP is never stored, only a salted hash of it.
const RATE_WINDOW = 2 * 3600e3;
async function rateCheck(store, ip){
  const limit = Number(process.env.PRUF_RATE_LIMIT ?? 20);
  if (!store || !ip || !(limit > 0)) return null;
  const key = "rl/" + createHash("sha256").update(ip + "|" + (process.env.PRUF_SALT || "prufy")).digest("hex").slice(0, 20);
  const now = Date.now();
  const recent = ((await store.get(key, { type: "json" }).catch(() => null)) || []).filter(t => now - t < RATE_WINDOW);
  if (recent.length >= limit){
    const mins = Math.max(1, Math.ceil((recent[0] + RATE_WINDOW - now) / 60000));
    return `That's ${limit} fresh checks from you in 2 hours. Saved checks still open instantly — new ones again in ${mins} min.`;
  }
  await store.setJSON(key, [...recent, now]).catch(() => {});
  return null;
}

const SOL_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const FAST_MODEL = process.env.ANTHROPIC_FAST_MODEL || "claude-haiku-4-5-20251001";
const UA = "Mozilla/5.0 (compatible; PRUF/0.2)";

// ---------- known Solana addresses (infrastructure, not the project's own tech) ----------
const KNOWN = {
  "11111111111111111111111111111111": "System Program",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token Program",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022 Program",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Program",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo Program",
  ComputeBudget111111111111111111111111111111: "Compute Budget Program",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex Token Metadata",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun program",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap program",
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "Meteora Dynamic Bonding Curve",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter Aggregator v6",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpools",
  So11111111111111111111111111111111111111112: "Wrapped SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  SysvarRent111111111111111111111111111111111: "Rent Sysvar",
  SysvarC1ock11111111111111111111111111111111: "Clock Sysvar",
};
const TOKEN_PROGRAMS = { TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token", TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022" };
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const RISKY_EXTENSIONS = ["transferFeeConfig", "permanentDelegate", "transferHook", "nonTransferable", "defaultAccountState", "pausableConfig"];
const VENUES = {
  pumpfun: "pump.fun bonding curve", pumpswap: "PumpSwap (graduated pump.fun)", meteora: "Meteora", "meteora-dbc": "Meteora bonding curve",
  meteoradbc: "Meteora bonding curve", raydium: "Raydium", orca: "Orca", launchlab: "Raydium LaunchLab", bonk: "LetsBonk",
  uniswap: "Uniswap", pancakeswap: "PancakeSwap", aerodrome: "Aerodrome",
};

// ---------- helpers ----------
const isSol = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const isEvm = s => /^0x[a-fA-F0-9]{40}$/.test(s);
const looksLikeKey = s => isSol(s) && /[0-9]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);
const short = a => a.length > 12 ? a.slice(0, 4) + "…" + a.slice(-4) : a;

function safeUrl(u){
  if (!u) return null;
  u = String(u).trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return null;
    const h = x.hostname.toLowerCase();
    if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) return null;
    return x.href;
  } catch { return null; }
}

// A link to a single post (x.com/someone/status/123) is a narrative SOURCE, not the project's account.
const isPostLink = u => /(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+/i.test(String(u || ""));
function xHandle(s){
  if (!s) return null;
  s = String(s).trim();
  const m = s.match(/(?:x\.com|twitter\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i);
  if (m && !["home", "intent", "share", "i", "search"].includes(m[1].toLowerCase())) return m[1];
  const h = s.replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(h) ? h : null;
}

// Give up on an optional step after ms, so the verdict always keeps its time.
const within = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timed out")), ms))]);

async function req(url, { json = true, ms = 8000, maxBytes = 0, ...opts } = {}){
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms), headers: { "user-agent": UA, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
  if (json) return r.json();
  const t = await r.text();
  return maxBytes ? t.slice(0, maxBytes) : t;
}

async function rpc(method, params, ms = 8000){
  const j = await req(SOL_RPC, { ms, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (j.error) throw new Error(j.error.message || "RPC error");
  return j.result;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes){
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ""; while (n > 0n){ s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes){ if (b === 0) s = "1" + s; else break; }
  return s;
}
const b64 = s => Uint8Array.from(Buffer.from(s, "base64"));

function htmlToText(html){
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

async function readPage(url){
  try {
    const headers = { "x-return-format": "markdown" };
    if (process.env.JINA_API_KEY) headers.authorization = "Bearer " + process.env.JINA_API_KEY;
    const t = await req("https://r.jina.ai/" + url, { json: false, ms: 10000, headers });
    if (t && t.length > 200) return t;
  } catch {}
  return htmlToText(await req(url, { json: false, ms: 8000 }));
}

const findLinks = text => [...new Set([...text.matchAll(/https?:\/\/[^\s)\]"'<>`]+/g)].map(m => m[0].replace(/[.,;]+$/, "")))];
const pct = n => (Math.round(n * 10) / 10).toFixed(1) + "%";
const usd = n => n == null ? "—" : n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? "$" + (n / 1e3).toFixed(1) + "K" : "$" + Math.round(n);
function ago(ms){
  const d = (Date.now() - ms) / 864e5;
  if (d < 1) return Math.max(1, Math.round(d * 24)) + " hours";
  if (d < 60) return Math.round(d) + " days";
  if (d < 730) return Math.round(d / 30) + " months";
  return (d / 365).toFixed(1) + " years";
}

// ---------- 1. Website code forensics ----------
const LIBS = [
  ["Solana wallet connect", /wallet-adapter|WalletNotConnectedError|phantom|solflare|backpack/i],
  ["Solana web3", /getLatestBlockhash|sendRawTransaction|LAMPORTS_PER_SOL|SystemProgram/],
  ["Anchor (Solana programs)", /IdlCoder|BorshCoder|AnchorProvider|anchor\.Program/],
  ["EVM wallet (ethers/viem/wagmi)", /wagmi|viem|ethers\.|JsonRpcProvider|walletconnect/i],
  ["pump.fun integration", /pumpportal|frontend-api[^"'`]*pump\.fun|pump\.fun\/api/i],
  ["Jupiter swaps", /jup\.ag|quote-api\.jup/i],
  ["Meteora SDK", /meteora-ag|dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN/],
  ["Game engine", /phaser|pixi\.js|PIXI\.|three\.module|THREE\.WebGLRenderer|unity(?:loader|instance)/i],
];
// GitHub orgs of common libraries: a link to these is a dependency, not the project's own code.
const LIB_ORGS = /^(zloirock|babel|webpack|rollup|evanw|feross|indutny|paulmillr|dcodeio|mozilla|whatwg|w3c|sindresorhus|isaacs|floating-ui|popperjs|juliangarnier|motiondivision|remix-run|vercel-labs|nuxt|angular|preactjs|solidjs|lit|immerjs|reduxjs|date-fns|moment|iamkun|chenglou|framer-motion|kentcdodds|testing-library|jestjs|vitest-dev|prettier|eslint|typescript-eslint|microsoft|DefinitelyTyped|ai|ethereum|bitcoinjs|dfinity|near|aptos-labs|MystenLabs|wagmi-dev|rainbow-me|privy-io|dynamic-labs|phantom|solflare-wallet|backpack-app|coinbase|trustwallet|ledgerhq|supabase|vercel|facebook|reactjs|solana-labs|solana-foundation|anza-xyz|coral-xyz|solana-developers|metaplex-foundation|walletconnect|reown-com|wevm|ethers-io|web3|tailwindlabs|vitejs|nextjs|sveltejs|vuejs|google|microsoft|openai|anthropics|jup-ag|raydium-io|orca-so|meteoraag|pump-fun|helius-labs|firebase|stripe|getsentry|lovable-dev|gpt-engineer-app|framer|mui|radix-ui|shadcn-ui|shadcn|lucide-icons|tanstack|axios|lodash|twbs|jquery|socketio|apollographql|prisma|trpc|vuetifyjs|chakra-ui|emotion-js|styled-components|zustand|pmndrs|d3|chartjs|mrdoob|greensock|tweenjs|necolas|npm|nodejs|denoland|github|actions|features|sponsors|about|pricing|login|topics|orgs|marketplace)$/i;

// Repos that are libraries, whoever hosts them: never the project's own code.
const LIB_REPOS = /^(core-js|babel|regenerator|webpack|rollup|esbuild|vite|polyfill|.*polyfills?|react|react-dom|vue|svelte|next\.js|tailwindcss|three\.js|lodash|axios|moment|dayjs|buffer|bn\.js|bs58|base-x|tweetnacl(-js)?|elliptic|noble-.*|ethers\.js|web3\.js|solana-web3\.js|wallet-adapter|anchor|spl-token|jquery|bootstrap|font-awesome|fontawesome|swiper|gsap|animejs|lottie-web|howler\.js|socket\.io(-client)?|pako|zod|immer|redux|zustand|uuid|qs|crypto-js|js-sha3|eventemitter3|tslib|whatwg-fetch|normalize\.css|modernizr|highlight\.js|marked|dompurify|chart\.js|d3|pixi\.js|phaser|matter-js)$/i;
const isLibRepo = (owner, repo) => LIB_ORGS.test(owner || "") || LIB_REPOS.test(String(repo || "").replace(/\.git$/, ""));
const BUILDERS = [["Lovable", /lovable|gpt-engineer/i], ["v0", /v0\.dev|vercel-v0/i], ["Bolt", /bolt\.new|stackblitz/i], ["Framer", /framerusercontent|framer\.com\/m\//i], ["Webflow", /webflow/i], ["Wix", /wixstatic|wix\.com/i], ["Carrd", /carrd\.co/i]];
const SERVICES = [
  ["Solana RPC", /helius-rpc|helius\.xyz|quiknode|alchemy\.com|rpcpool|triton|mainnet-beta\.solana|ankr\.com/i],
  ["Supabase backend", /supabase\.co/i], ["Firebase backend", /firebaseio|firebaseapp|firestore\.googleapis/i],
  ["Own API server", /onrender\.com|railway\.app|herokuapp|workers\.dev|fly\.dev|vercel\.app\/api|\/api\//i],
  ["OpenAI", /api\.openai\.com/i], ["Anthropic", /api\.anthropic\.com/i], ["Other AI API", /groq\.com|together\.xyz|replicate\.com|openrouter\.ai|elevenlabs\.io/i],
  ["Market data API", /dexscreener|birdeye|coingecko|moralis|bitquery|geckoterminal/i],
];
const FAKE_WORDS = /(price|volume|holders?|users?|online|trades?|\btxs?\b|transactions|profit|pnl|apy|apr|balance|market ?cap|mcap|buys?|sells?|winners?|players?|burn(?:ed)?|rewards?|earn(?:ed|ings)?|signals?|accuracy)/i;

async function siteForensics(url){
  const html = await req(url, { json: false, ms: 8000, maxBytes: 2e6 });
  const base = new URL(url);
  const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi), ...html.matchAll(/<link[^>]+rel=["']modulepreload["'][^>]+href=["']([^"']+)["']/gi)]
    .map(m => { try { return new URL(m[1], base).href; } catch { return null; } })
    .filter(u => u && (new URL(u).hostname === base.hostname || new URL(u).hostname.endsWith("." + base.hostname.replace(/^www\./, ""))));
  const scripts = [...new Set(srcs)].slice(0, 8);
  const inline = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join("\n");
  const bundles = await Promise.allSettled(scripts.map(s => req(s, { json: false, ms: 8000, maxBytes: 4e6 })));
  let code = html.slice(0, 400000);
  void inline;
  let bytes = 0;
  bundles.forEach(b => { if (b.status === "fulfilled"){ code += "\n" + b.value; bytes += b.value.length; } });

  const out = { scriptsRead: bundles.filter(b => b.status === "fulfilled").length, codeKB: Math.round(bytes / 1024) };
  // Fingerprint of the app's main bundle: identical hash = the exact same site code (reused / cloned site).
  const big = bundles.filter(b => b.status === "fulfilled" && b.value.length > 20000).map(b => b.value).sort((a, b) => b.length - a.length)[0];
  if (big) out.codeHash = createHash("sha1").update(big).digest("hex").slice(0, 16);
  out.builder = (BUILDERS.find(([, re]) => re.test(code)) || [null])[0];
  out.libraries = LIBS.filter(([, re]) => re.test(code)).map(([n]) => n);
  out.services = SERVICES.filter(([, re]) => re.test(code)).map(([n]) => n);
  out.signsTransactions = /signTransaction|signAllTransactions|sendTransaction|signAndSendTransaction|sendRawTransaction/.test(code);
  out.connectsWallet = out.libraries.includes("Solana wallet connect") || out.libraries.includes("EVM wallet (ethers/viem/wagmi)");

  out.solAddresses = [...new Set([...code.matchAll(/["'`]([1-9A-HJ-NP-Za-km-z]{32,44})["'`]/g)].map(m => m[1]).filter(looksLikeKey))].slice(0, 25);
  out.evmAddresses = [...new Set([...code.matchAll(/["'`](0x[a-fA-F0-9]{40})["'`]/g)].map(m => m[1]))].filter(a => !/^0x0{40}$/.test(a)).slice(0, 10);

  const noise = /w3\.org|reactjs|react\.dev|mozilla|schema\.org|googleapis\.com\/css|gstatic|unpkg|jsdelivr|cdnjs|github\.com\/(facebook|vercel|solana-labs)|fb\.me|tailwindcss|npmjs|nodejs\.org|sentry|polyfill|example\.com|localhost/i;
  out.hosts = [...new Set([...code.matchAll(/https?:\/\/([a-zA-Z0-9.-]+\.[a-z]{2,})/g)].map(m => m[1].toLowerCase()))].filter(h => !noise.test(h) && h !== base.hostname).slice(0, 30);

  const secrets = [];
  if (/sk-ant-[A-Za-z0-9_-]{20,}/.test(code)) secrets.push("Anthropic API key");
  if (/["'`]sk-(?:proj-)?[A-Za-z0-9_-]{24,}["'`]/.test(code)) secrets.push("OpenAI API key");
  if (/\[(?:\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]/.test(code)) secrets.push("64-byte wallet secret key array");
  if (/["'`][1-9A-HJ-NP-Za-km-z]{86,88}["'`]/.test(code)) secrets.push("Base58 wallet private key");
  if (/service_role/.test(code)) secrets.push("Supabase service_role key");
  out.leakedSecrets = secrets;

  const inString = i => {
    const line = code.slice(code.lastIndexOf("\n", i) + 1, i);
    return ['"', "'", "`"].some(q => (line.split(q).length - 1) % 2 === 1);
  };
  const rand = [...code.matchAll(/Math\.random\(\)/g)].filter(m => !inString(m.index));
  out.mathRandomTotal = rand.length;
  const snippets = [];
  for (const m of rand.slice(0, 80)){
    const w = code.slice(Math.max(0, m.index - 160), m.index + 160);
    if (FAKE_WORDS.test(w)) snippets.push(w.replace(/\s+/g, " "));
    if (snippets.length >= 8) break;
  }
  out.randomNearMetrics = snippets.length;
  out.randomSnippets = snippets;
  out.setIntervalCount = (code.match(/setInterval\(/g) || []).length;

  // Off-chain backend: which of its own server endpoints the site calls, and which public commit it says it runs.
  out.apiPaths = [...new Set([...code.matchAll(/["'`](?:https?:\/\/[^"'`\/]+)?(\/(?:api|\.netlify\/functions|functions|v1)\/[A-Za-z0-9_\-\/.]{1,60})["'`?]/g)]
    .map(m => m[1].replace(/\/$/, "")))].filter(p => !/\.(js|css|png|svg|webp|jpg|json)$/i.test(p)).slice(0, 10);
  // Only links a visitor can see (no <script>/<style>/comments: libraries like core-js stamp their own GitHub link there).
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  out.githubLinks = [...new Set([...visible.matchAll(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+[^"'`\s<)]*/g)].map(m => m[0]))]
    .filter(u => !isLibRepo(u.split("/")[3], u.split("/")[4])).slice(0, 10);
  const cm = code.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:commit|tree)\/([0-9a-f]{7,40})/i);
  if (cm && !isLibRepo(cm[1], cm[2])) out.deployedCommit = { repo: `${cm[1]}/${cm[2]}`, sha: cm[3].toLowerCase(), source: "commit link on the site" };
  if (!out.deployedCommit){
    try {
      const v = await req(new URL("/version.json", base).href, { ms: 4000 });
      const sha = String(v.commit || v.sha || "").toLowerCase();
      const rm = String(v.repo || v.repository || "").match(/github\.com[\/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
      if (/^[0-9a-f]{7,40}$/.test(sha)) out.deployedCommit = { repo: rm ? `${rm[1]}/${rm[2]}` : null, sha, source: "/version.json" };
      if (rm) out.githubLinks.push(`https://github.com/${rm[1]}/${rm[2]}`);
    } catch {}
  }
  return out;
}

// Does the public repo contain the server the site actually calls, and is the live site running a public commit?
async function verifyBackend(site, gh){
  const calls = site?.apiPaths || [];
  if (!calls.length) return null;
  const out = { siteCallsOwnServer: calls };
  if (!gh?.serverPaths){ out.level = "closed"; out.note = "The site calls its own server, and no public source code for it was found."; return out; }
  out.repo = gh.repo;
  out.serverFilesInRepo = gh.serverPaths.slice(0, 12);
  out.routesFoundInRepo = calls.filter(c => {
    const last = c.split("/").filter(Boolean).pop()?.toLowerCase().replace(/\.[a-z]+$/, "");
    return last && (gh.serverPaths.some(p => p.toLowerCase().includes(last)) || (gh.routeHints || []).some(r => r.toLowerCase() === c.toLowerCase()));
  });
  const dc = site.deployedCommit;
  if (dc){
    out.deployedCommit = dc.sha.slice(0, 12);
    out.deployedCommitSource = dc.source;
    const sameRepo = !dc.repo || dc.repo.toLowerCase() === String(gh.repo).toLowerCase();
    let found = (gh.recentShas || []).some(x => x.startsWith(dc.sha));
    if (!found && sameRepo){
      try { const c = await req(`https://api.github.com/repos/${gh.repo}/commits/${dc.sha}`, { headers: gh._headers, ms: 5000 }); found = !!c?.sha; if (found) out.deployedCommitDate = c.commit?.author?.date; } catch {}
    }
    out.deployedCommitInRepo = sameRepo && found;
  }
  out.level = out.routesFoundInRepo.length && out.deployedCommitInRepo ? "open_and_deployed" : out.serverFilesInRepo.length ? "open_source_unproven" : "closed";
  return out;
}

// ---------- 2. On-chain probes ----------
async function probeSolana(addrs){
  if (!addrs.length) return [];
  const res = await rpc("getMultipleAccounts", [addrs, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
  const out = addrs.map((a, i) => {
    const v = res?.value?.[i];
    if (!v) return { address: a, kind: "missing", note: "Doesn't exist on Solana mainnet" };
    const owner = v.owner;
    if (v.executable) return { address: a, kind: "program", owner, upgradeable: owner === UPGRADEABLE_LOADER };
    if (TOKEN_PROGRAMS[owner]) return { address: a, kind: "token-account-or-mint", owner };
    if (owner === "11111111111111111111111111111111") return { address: a, kind: "wallet", sol: v.lamports / 1e9 };
    return { address: a, kind: "account", owner, ownerLabel: KNOWN[owner] || null };
  });

  const tasks = [];
  for (const p of out){
    if (p.kind === "program" && p.upgradeable && tasks.length < 12){
      tasks.push((async () => {
        const pa = await rpc("getAccountInfo", [p.address, { encoding: "base64", dataSlice: { offset: 0, length: 36 } }]);
        const raw = b64(pa.value.data[0]);
        const pd = b58(raw.slice(4, 36));
        const pdi = await rpc("getAccountInfo", [pd, { encoding: "base64", dataSlice: { offset: 0, length: 45 } }]);
        const d = b64(pdi.value.data[0]);
        const slot = Number(new DataView(d.buffer, d.byteOffset).getBigUint64(4, true));
        p.upgradeAuthority = d[12] === 1 ? b58(d.slice(13, 45)) : null;
        p.frozen = !p.upgradeAuthority;
        try { const bt = await rpc("getBlockTime", [slot]); if (bt) p.lastDeployed = new Date(bt * 1000).toISOString(); } catch {}
      })().catch(() => {}));
      tasks.push(req(`https://verify.osec.io/status/${p.address}`, { ms: 6000 }).then(v => { p.verifiedBuild = !!v.is_verified; if (v.repo_url) p.verifiedRepo = v.repo_url; }).catch(() => {}));
    }
    if (p.kind === "token-account-or-mint"){
      tasks.push(rpc("getAccountInfo", [p.address, { encoding: "jsonParsed" }]).then(r => {
        const t = r?.value?.data?.parsed?.type;
        if (t === "mint"){ p.kind = "token-mint"; const i = r.value.data.parsed.info; p.mintAuthority = i.mintAuthority ?? null; }
        else if (t === "account"){ p.kind = "token-account"; const i = r.value.data.parsed.info; p.tokenMint = i.mint; p.holder = i.owner; p.amount = i.tokenAmount?.uiAmountString; }
      }).catch(() => {}));
    }
    if (["program", "wallet"].includes(p.kind)){
      tasks.push(rpc("getSignaturesForAddress", [p.address, { limit: 200 }]).then(s => {
        p.txCount = s.length >= 200 ? "200+" : s.length;
        if (s.length){ p.lastTx = s[0].blockTime ? new Date(s[0].blockTime * 1000).toISOString() : null; p.oldestTxInSample = s.at(-1).blockTime ? new Date(s.at(-1).blockTime * 1000).toISOString() : null; }
      }).catch(() => {}));
    }
  }
  await Promise.allSettled(tasks);
  return out;
}

// ---------- CA on GitHub: "listed in the Solana Foundation repo" style claims ----------
// Searches all public code + all issues/PRs for the exact CA. Code search needs GITHUB_TOKEN; issues work without.
const OFFICIAL_ORGS = /^(solana-foundation|solana-labs|anza-xyz|solana-developers|solana-program|jito-foundation|metaplex-foundation)$/i;
// Where in a file the CA sits matters more than which org owns the repo: sample API responses, test fixtures and
// scraped token lists are not endorsements.
const SAMPLE_PATH = /(openapi|swagger|spec|schema|example|sample|fixture|mock|test|__tests__|seed|snapshot|cache|dump|scrape)/i;
const SAMPLE_TEXT = /"(example|examples|sample|mock|fixture)"\s*:|components\/schemas|"included"\s*:|"relationships"\s*:|"top_pools"|"price_usd"|"fdv_usd"|"volume_usd"|"launchpad_details"/i;
async function githubMentions(ca){
  const H = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) H.authorization = "Bearer " + process.env.GITHUB_TOKEN;
  const q = encodeURIComponent(`"${ca}"`);
  const [code, iss] = await Promise.allSettled([
    H.authorization ? req(`https://api.github.com/search/code?q=${q}&per_page=10`, { headers: { ...H, accept: "application/vnd.github.text-match+json" }, ms: 7000 }) : Promise.reject(new Error("no token")),
    req(`https://api.github.com/search/issues?q=${q}&per_page=10`, { headers: H, ms: 7000 }),
  ]);
  const out = { searched: [], code: [], prs: [] };
  if (code.status === "fulfilled"){
    out.searched.push("all public code");
    out.codeTotal = code.value.total_count || 0;
    out.code = (code.value.items || []).map(i => {
      const context = (i.text_matches || []).map(m => m.fragment).join(" … ").slice(0, 400);
      const sample = SAMPLE_PATH.test(i.path || "") || SAMPLE_TEXT.test(context);
      return { repo: i.repository?.full_name, path: i.path, url: i.html_url, official: OFFICIAL_ORGS.test(i.repository?.owner?.login || ""), looksLikeSampleData: sample, context };
    });
  }
  if (iss.status === "fulfilled"){
    out.searched.push("all issues & pull requests");
    out.prTotal = iss.value.total_count || 0;
    out.prs = (iss.value.items || []).map(i => {
      const repo = (i.repository_url || "").split("/repos/")[1] || "";
      return { repo, title: String(i.title || "").slice(0, 120), url: i.html_url, isPR: !!i.pull_request, state: i.state, merged: !!i.pull_request?.merged_at, by: i.user?.login, official: OFFICIAL_ORGS.test(repo.split("/")[0]) };
    });
  }
  return out.searched.length ? out : null;
}

// ---------- 3. GitHub deep read ----------
async function githubDeep(links){
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = "Bearer " + process.env.GITHUB_TOKEN;
  const gh = links.map(l => l.match(/github\.com\/([\w.-]+)(?:\/([\w.-]+))?/i)).find(m => m && !isLibRepo(m[1], m[2]));
  if (!gh) return null;
  let [, owner, repo] = gh;
  if (!repo){
    const list = await req(`https://api.github.com/users/${owner}/repos?sort=pushed&per_page=10`, { headers });
    const pick = list.find(r => !r.fork) || list[0];
    if (!pick) return { url: `https://github.com/${owner}`, owner, repos: 0 };
    repo = pick.name;
  }
  repo = repo.replace(/\.git$/, "");
  const meta = await req(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  const branch = meta.default_branch || "main";
  const [commits, tree, readme] = await Promise.allSettled([
    req(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=100`, { headers }),
    req(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, { headers }),
    req(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`, { json: false, maxBytes: 6000 }),
  ]);
  const out = { url: meta.html_url, repo: meta.full_name, stars: meta.stargazers_count, forks: meta.forks_count, isFork: meta.fork, created: meta.created_at, lastPush: meta.pushed_at, description: meta.description };
  if (commits.status === "fulfilled"){
    const c = commits.value;
    out.commits = c.length >= 100 ? "100+" : c.length;
    out.authors = [...new Set(c.map(x => x.author?.login || x.commit?.author?.name).filter(Boolean))].slice(0, 10);
    out.recentShas = c.map(x => String(x.sha || "").toLowerCase()).filter(Boolean);
    out.firstCommitInSample = c.at(-1)?.commit?.author?.date;
    out.lastCommit = c[0]?.commit?.author?.date;
  }
  if (tree.status === "fulfilled"){
    const paths = (tree.value.tree || []).filter(t => t.type === "blob").map(t => t.path);
    out.files = paths.length;
    const ext = {}; paths.forEach(p => { const e = (p.match(/\.([a-z0-9]+)$/i) || [])[1]; if (e) ext[e] = (ext[e] || 0) + 1; });
    out.fileTypes = Object.entries(ext).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([e, n]) => `${e}:${n}`);
    out.hasSolanaPrograms = paths.some(p => /(^|\/)programs\/[^/]+\/src\/lib\.rs$|Anchor\.toml$/.test(p));
    out.solidityFiles = paths.filter(p => p.endsWith(".sol")).length;
    out.serverPaths = paths.filter(p => /(^|\/)(netlify\/functions|netlify\/edge-functions|supabase\/functions|api|functions|server|backend|app\/api|pages\/api|src\/server|src\/api|worker|workers)\//i.test(p) && /\.(m?[jt]sx?|py|go|rs|rb)$/i.test(p) && !/node_modules|test|spec/i.test(p));
    if (paths.includes("netlify.toml")){
      try {
        const toml = await req(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/netlify.toml`, { json: false, maxBytes: 8000 });
        out.routeHints = [...toml.matchAll(/from\s*=\s*"([^"]+)"/g)].map(m => m[1].replace(/\/\*$/, ""));
      } catch {}
    }
    if (out.serverPaths.length){
      const conf = await Promise.allSettled(out.serverPaths.slice(0, 4).map(p => req(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${p}`, { json: false, maxBytes: 200000 })));
      conf.forEach(r => { if (r.status === "fulfilled") (r.value.match(/path:\s*["'`](\/[^"'`]+)["'`]/g) || []).forEach(m => (out.routeHints ||= []).push(m.replace(/^path:\s*["'`]|["'`]$/g, ""))); });
      // What the server code actually does: its function names and the outside services it calls.
      out.serverCode = conf.map((r, i) => r.status !== "fulfilled" ? null : {
        file: out.serverPaths[i], kb: Math.round(r.value.length / 1024),
        functions: [...new Set([...r.value.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_]+)|(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/g)].map(m => m[1] || m[2]))].slice(0, 40),
        callsHosts: [...new Set([...r.value.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map(m => m[1].toLowerCase()))].slice(0, 20),
      }).filter(Boolean);
    }
    out.samplePaths = paths.filter(p => !/node_modules|\.lock$|^\.|assets\/|public\//.test(p)).slice(0, 80);
    const libs = paths.filter(p => /programs\/[^/]+\/src\/lib\.rs$/.test(p)).slice(0, 3);
    const ids = await Promise.allSettled(libs.map(p => req(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${p}`, { json: false, maxBytes: 20000 })));
    out.declaredProgramIds = [...new Set(ids.flatMap(r => r.status === "fulfilled" ? [...r.value.matchAll(/declare_id!\(\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"\s*\)/g)].map(m => m[1]) : []))];
  }
  if (readme.status === "fulfilled") out.readme = readme.value;
  Object.defineProperty(out, "_headers", { value: headers, enumerable: false });
  return out;
}

// ---------- market + token basics (secondary) ----------
async function dexscreener(ca){
  const j = await req(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
  const pairs = (j.pairs || []).filter(p => p.baseToken?.address?.toLowerCase() === ca.toLowerCase());
  if (!pairs.length) return null;
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const top = pairs[0];
  const withInfo = pairs.find(p => p.info) || top;
  return {
    chainId: top.chainId, name: top.baseToken.name, symbol: top.baseToken.symbol, image: withInfo.info?.imageUrl || null,
    venues: [...new Set(pairs.map(p => p.dexId))], pairCount: pairs.length, pairUrl: top.url,
    pumpswapPair: pairs.find(p => p.dexId === "pumpswap")?.pairAddress || null,
    createdAt: Math.min(...pairs.map(p => p.pairCreatedAt || Infinity)),
    liquidityUsd: pairs.reduce((s, p) => s + (p.liquidity?.usd || 0), 0), marketCap: top.marketCap ?? top.fdv ?? null,
    volume24h: pairs.reduce((s, p) => s + (p.volume?.h24 || 0), 0),
    websites: (withInfo.info?.websites || []).map(w => w.url), socials: (withInfo.info?.socials || []).map(s => ({ type: s.type, url: s.url })),
    // What it trades against. SOL/USDC/USDT = normal; anything else (a tokenized stock, PUMP, ANTHROPIC…) is a narrative play.
    pairedWith: [...new Map(pairs.filter(p => p.quoteToken?.address && !STD_QUOTES.has(p.quoteToken.address) && !/^(w?SOL|USDC|USDT|USD1)$/i.test(p.quoteToken.symbol || ""))
      .map(p => [p.quoteToken.address, { symbol: p.quoteToken.symbol, name: p.quoteToken.name, ca: p.quoteToken.address, dex: p.dexId, liquidityUsd: Math.round(p.liquidity?.usd || 0) }])).values()].slice(0, 5),
  };
}
const STD_QUOTES = new Set(["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
// Names for token addresses the project shows (so a pair token's CA is never mistaken for "a second CA").
async function nameTokens(addrs){
  const list = [...new Set(addrs)].filter(isSol).slice(0, 15);
  if (!list.length) return [];
  const j = await req(`https://api.dexscreener.com/tokens/v1/solana/${list.join(",")}`, { ms: 5000 }).catch(() => null);
  const seen = {};
  for (const p of Array.isArray(j) ? j : []){
    for (const t of [p.baseToken, p.quoteToken]) if (t?.address && list.includes(t.address) && !seen[t.address]) seen[t.address] = { ca: t.address, name: t.name, symbol: t.symbol };
  }
  return Object.values(seen);
}

async function solanaMint(ca){
  const info = await rpc("getAccountInfo", [ca, { encoding: "jsonParsed" }]);
  const v = info?.value;
  if (!v) return null;
  const p = v.data?.parsed?.info || {};
  const out = { program: TOKEN_PROGRAMS[v.owner] || v.owner, mintAuthority: p.mintAuthority ?? null, freezeAuthority: p.freezeAuthority ?? null,
    supply: p.supply ? Number(p.supply) / 10 ** (p.decimals || 0) : null, extensions: (p.extensions || []).map(e => e.extension) };
  try {
    const big = await rpc("getTokenLargestAccounts", [ca]);
    const amts = (big?.value || []).map(a => Number(a.uiAmount || 0));
    if (out.supply && amts.length) out.top10Pct = (amts.slice(0, 10).reduce((s, a) => s + a, 0) / out.supply) * 100;
  } catch {}
  return out;
}

// The token's own metadata, written by the creator at launch: description, website, X, Telegram.
// Free and present for almost every pump.fun-style token, unlike DexScreener's paid profile.
const SOCIAL_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.me|discord\.gg|discord\.com|pump\.fun|dexscreener\.com|youtube\.com|tiktok\.com|instagram\.com)$/i;
const ipfs = u => String(u).replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/");
// Any social account a token links to (X, TikTok, Instagram, YouTube, Kick, Twitch, GitHub…): {platform, handle, url, post}.
// A coin linking to someone's account only proves the account exists — not that its owner is involved.
const SOCIAL_PLATFORMS = [[/(^|\.)(x|twitter)\.com$/, "X"], [/(^|\.)tiktok\.com$/, "TikTok"], [/(^|\.)instagram\.com$/, "Instagram"], [/(^|\.)(youtube\.com|youtu\.be)$/, "YouTube"],
  [/(^|\.)kick\.com$/, "Kick"], [/(^|\.)twitch\.tv$/, "Twitch"], [/(^|\.)github\.com$/, "GitHub"], [/(^|\.)(t\.me|telegram\.me)$/, "Telegram"], [/(^|\.)threads\.net$/, "Threads"], [/(^|\.)reddit\.com$/, "Reddit"]];
function socialAccount(u){
  const su = safeUrl(u); if (!su) return null;
  const url = new URL(su); const h = url.hostname.toLowerCase();
  const hit = SOCIAL_PLATFORMS.find(([re]) => re.test(h)); if (!hit) return null;
  const seg = url.pathname.split("/").filter(Boolean);
  let handle = seg[0] || null;
  if (hit[1] === "YouTube" && /^(c|channel|user)$/.test(handle || "")) handle = seg[1] || null;
  if (hit[1] === "Reddit" && /^(r|u|user)$/.test(handle || "")) handle = seg[1] ? `${seg[0]}/${seg[1]}` : null;
  if (handle && /^(i|intent|home|share|search|watch|hashtag)$/i.test(handle)) handle = null;
  return { platform: hit[1], handle: handle ? handle.replace(/^@/, "") : null, url: su, post: /\/(status|video|p|reel|shorts)\/|watch\?v=/.test(su) };
}
async function tokenMeta(ca){
  const out = { website: null, twitter: null, telegram: null, description: null, creator: null, createdOn: null, updateAuthority: null, raw: null, from: [], links: [] };
  const take = j => {
    if (!j || typeof j !== "object") return;
    out.createdOn ||= j.createdOn || j.created_on || j.platform || j.launchpad || j.launchedOn || null;
    const ext = j.extensions || j.properties?.links || {};
    out.website ||= j.website || ext.website || j.external_url || null;
    out.twitter ||= j.twitter || ext.twitter || null;
    out.telegram ||= j.telegram || ext.telegram || null;
    out.description ||= j.description || null;
    out.name ||= typeof j.name === "string" ? j.name : null;
    out.symbol ||= typeof j.symbol === "string" ? j.symbol : null;
    out.image ||= typeof j.image === "string" ? j.image : typeof j.image_uri === "string" ? j.image_uri : null;
    // Every launchpad names these fields differently (socials[], links{}, extensions{}…),
    // so also scan the whole JSON for links and sort them by domain.
    const urls = [];
    const walk = (v, d = 0) => {
      if (d > 4 || v == null) return;
      if (typeof v === "string"){ if (/^https?:\/\/|^(www\.)?[a-z0-9-]+\.[a-z]{2,}(\/|$)/i.test(v.trim()) && v.length < 300) urls.push(v.trim()); }
      else if (Array.isArray(v)) v.forEach(x => walk(x, d + 1));
      else if (typeof v === "object") Object.entries(v).forEach(([k, x]) => { if (!/image|logo|icon|banner|animation|uri|file/i.test(k)) walk(x, d + 1); });
    };
    walk(j);
    for (const u of urls){
      const su = safeUrl(u); if (!su) continue;
      const h = new URL(su).hostname.toLowerCase();
      const acct = socialAccount(su); if (acct && !out.links.some(l => l.url === acct.url) && out.links.length < 8) out.links.push(acct);
      if (/(^|\.)(x|twitter)\.com$/.test(h)) out.twitter ||= su;
      else if (/(^|\.)(t\.me|telegram\.me)$/.test(h)) out.telegram ||= su;
      else if (!SOCIAL_HOSTS.test(h) && !/ipfs|arweave|irys|cloudflare-ipfs|nftstorage|pinata|cdn\.|\.(png|jpe?g|gif|webp|svg|json)$/i.test(su)) out.website ||= su;
    }
  };
  let uri = null;
  try {
    const a = await rpc("getAsset", { id: ca }, 6000); // Helius DAS (needs a Helius SOLANA_RPC_URL)
    uri = a?.content?.json_uri || null;
    take({ description: a?.content?.metadata?.description, external_url: a?.content?.links?.external_url });
    out.updateAuthority = a?.authorities?.[0]?.address || null;
    out.creator ||= (a?.creators || []).find(c => c.verified)?.address || null;
    if (a) out.from.push("token metadata");
  } catch {}
  if (uri){
    // Metadata JSON: race the original link and several IPFS gateways, first good answer wins.
    const cid = (ipfs(uri).match(/\/ipfs\/([^?#]+)/) || [])[1];
    const urls = [ipfs(uri), ...(cid ? ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://pump.mypinata.cloud/ipfs/", "https://w3s.link/ipfs/", "https://nftstorage.link/ipfs/"].map(g => g + cid) : [])];
    const tries = [...new Set(urls)].map(u => req(u, { ms: 7000 }).then(j => (j && typeof j === "object" ? j : Promise.reject())));
    try {
      const j = await Promise.any(tries);
      take(j); const { image, ...rest } = j || {}; out.raw = JSON.stringify(rest).slice(0, 1500);
    } catch { out.metaFailed = true; }
  }
  if (!out.website || !out.twitter || !out.creator){
    // pump.fun's own API, with browser-like headers (it often rejects plain server requests).
    const H = { accept: "application/json", origin: "https://pump.fun", referer: "https://pump.fun/" };
    try {
      const p = await Promise.any([`https://frontend-api-v3.pump.fun/coins/${ca}`, `https://frontend-api-v2.pump.fun/coins/${ca}`]
        .map(u => req(u, { ms: 6000, headers: H }).then(x => (x && x.mint ? x : Promise.reject()))));
      take(p); out.creator ||= p.creator || null; out.from.push("pump.fun");
    } catch {}
  }
  const site = safeUrl(out.website);
  out.website = site && !SOCIAL_HOSTS.test(new URL(site).hostname) ? site : null;
  return out;
}

// ---------- launch venue + dev wallet ----------
const LAUNCHPAD_HOSTS = [
  [/(^|\.)pump\.fun$/, "pump.fun"], [/(^|\.)(letsbonk|bonk)\.fun$/, "LetsBonk"], [/(^|\.)bags\.fm$/, "Bags"],
  [/(^|\.)believe\.app$/, "Believe"], [/moonshot/, "Moonshot"], [/(^|\.)heaven\.xyz$/, "Heaven"], [/(^|\.)raydium\.io$/, "Raydium LaunchLab"],
  [/(^|\.)meteora\.ag$/, "Meteora"], [/(^|\.)jup\.ag$/, "Jupiter"], [/(^|\.)boop\.fun$/, "boop.fun"], [/paid/, "Paid"], [/(^|\.)agencypad\.fun$|tryagency/, "Agency"], [/stonkfun/, "StonkFun"],
];
function launchpadName(createdOn){
  if (!createdOn) return null;
  const su = safeUrl(createdOn); const h = su ? new URL(su).hostname.toLowerCase().replace(/^www\./, "") : String(createdOn).toLowerCase();
  const hit = LAUNCHPAD_HOSTS.find(([re]) => re.test(h));
  return { name: hit ? hit[1] : h, host: h };
}

// ---------- market context: what each platform/service IS, so PRUF can explain it like a degen would ----------
// Detection is by text (metadata, site, X bio/posts), createdOn host, or addresses seen in the launch tx.
// "ctx" is what Claude is told about it. Keep these short, factual and dated. Update when the meta changes.
const ECOSYSTEM = [
  { name: "Paid (UsePaid)", re: /\busepaid\b|\bpaid\.(?:fun|xyz|app)\b|\bvia\s+@?paid\b|@usepaid/i,
    ctx: "Not a launchpad program: a fee-routing service on top of normal pump.fun tokens. The token's creator fees are pointed to the UsePaid treasury; UsePaid claims them on a schedule and pays the X account named in the token's metadata. Split since 29 Sep 2026: 65% to the named X account, 10% UsePaid treasury, 25% buys back and burns $PAID (before: 80/20). Payouts were via X Money (paused 27 Sep 2026); since 28 Sep the named account claims by logging in with X on the UsePaid portal and giving a wallet. So: the named @account does NOT need to be involved or even know about the token — it's often someone famous who never agreed to anything. Fees reaching UsePaid is on-chain; the payout to the @account is off-chain (trust UsePaid). Own token: $PAID 98kfF7rmsg1QDUEoCqNE7g7M1FdrTt92TEp2CLzypump." },
  { name: "Agency (AgencyPad)", re: /\bagencypad\.fun\b|@tryagency\b|\btryagency\b|\bagency\s?pad\b/i, addr: ["7VertkgF9KLhxxJXHX6uaWuoYZTP9LdGj2bWmVXVpump"],
    ctx: "AI-run launchpad (Oct 2026, pump.fun-style curve). Whoever launches a coin picks an AI model (Claude, GPT, Grok…) and that AI then RUNS the coin: it writes the coin's X account (often @<Name>_agency), decides buybacks/burns, holder payouts, games or buying stuff. The launcher gets 0 creator fees — 100% go to the AI: first $20 pays its compute, $20–100 split 50/50 compute/treasury, above $100 15% of every claim buys and burns $AGENCY. The AI goes to sleep if fees are under ~0.1 SOL/hour, and early on only ~1–2% of Agency coins had an active AI. So: (1) the coin's X posts are written by an AI, not by a team and not by the real person/character it's named after; (2) anyone can launch a coin named after anyone — the name or a linked TikTok/X of a real person does NOT mean that person is involved; (3) an agencypad.fun/coin/<CA> 'website' is the launchpad's page, not a project site; (4) treasury and buybacks are run by the platform (anonymous team, single-signer custody, no audit) — trust Agency. Platform token: $AGENCY 7VertkgF9KLhxxJXHX6uaWuoYZTP9LdGj2bWmVXVpump." },
  { name: "StonkFun", re: /\bstonkfun\b|stonkfun\.xyz|@LaunchOnSF\b|\bstonk\s?fun\b/i,
    ctx: "Solana launchpad (since Jul 2026) where the creator picks what the coin trades AGAINST instead of SOL: tokenized stocks (xStocks by Backed: NVDAx, SPYx, QQQx…), pre-IPO tokens (PreStocks: OPENAI, ANTHROPIC…) or crypto (ZEC, WBTC, HYPE…). The pair can't change after launch. Bonding curves run on Raydium LaunchLab (since 6 Sep 2026), then a Raydium pool. Creator fees are paid in the quote asset; ~60% of platform revenue buys and burns $STONK. Pseudonymous team (@LaunchOnSF). So: the pair IS part of the narrative (\"the NVDA coin\", \"the Anthropic coin\"), the paired token's CA is not a second CA of the coin, and none of these coins is affiliated with the company behind the stock." },
  { name: "Bags", re: /\bbags\.fm\b|\bon\s+bags\b|@bagsapp/i, addr: ["FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK", "FEEhPbKVKnco9EXnaY3i4R5rQVUx91wgVfu8qokixywi"],
    ctx: "Launchpad on Meteora's bonding curve. Creator gets 1% of volume forever, and fees can be shared to social handles (X, TikTok, GitHub, Kick…) that Bags holds a wallet for — the person behind the handle can claim later. Fee split is on-chain (Bags Fee Share program). A handle getting fees does NOT mean that person is part of the team." },
  { name: "Believe", re: /\bbelieve\.app\b|\blaunchcoin\b|@believeapp/i, addr: ["5qWya6UjwWnGVhdSBL3hyZ7B45jbk6Byt1hwd7ohEGXE"],
    ctx: "Launchpad on Meteora's bonding curve; tokens are created by replying to a post on X. Trading fees split 50/50 with the creator, claimed via Believe (custodial on the creator's behalf)." },
  { name: "bonk.fun (ex-LetsBonk)", re: /\b(?:letsbonk|bonk)\.fun\b/i, addr: ["FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1"],
    ctx: "Launchpad on Raydium LaunchLab. Creator gets ~0.1% per swap; part of platform fees buy back and burn BONK. Using it is real but it's Raydium/Bonk tech, not the project's." },
  { name: "Raydium LaunchLab", re: /\blaunchlab\b/i, addr: ["LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"],
    ctx: "Raydium's bonding-curve launch program; many white-label launchpads (\"platforms\") run on it, each with its own fee config." },
  { name: "Meteora DBC", re: /\bdynamic bonding curve\b|\bmeteora dbc\b/i, addr: ["dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"],
    ctx: "Meteora's bonding-curve program. Meteora ships an open-source launchpad template, so many 'our own launchpad' projects are just a front-end on Meteora DBC — that is real tech, but Meteora's, not theirs." },
  { name: "pump.fun", re: /\bpump\.fun\b/i, addr: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"],
    ctx: "The default Solana launchpad. Creator fees go to the token's creator address; since Jan 2026 they can be shared on-chain with up to 10 wallets, and since Mar 2026 the fee recipient can be changed only once, then it's locked. Since Feb 2026 fees can also be routed to a GitHub account via the pump.fun app. After graduation the token trades on PumpSwap. 'Launched on pump.fun' is not the project's own tech." },
  { name: "boop.fun", re: /\bboop\.fun\b/i, addr: ["boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4"],
    ctx: "Launchpad that graduates to Raydium; BOOP stakers earn platform fees." },
  { name: "Moonit (ex-Moonshot)", re: /\bmoonshot\b|\bmoonit\b/i, addr: ["MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG"],
    ctx: "Launchpad; showing a maintenance page with no active pools since ~Aug 2026." },
  { name: "Heaven", re: /\bheaven\.xyz\b/i,
    ctx: "Launchpad with its own AMM (2025) and a 'flywheel' that uses fees to buy back LIGHT. 2026 status not confirmed." },
  { name: "ElizaOS", re: /\beliza ?os\b|\bai16z\b|\beliza framework\b/i,
    ctx: "Open-source AI-agent framework (ex-ai16z). Anyone can run an agent with it in minutes, so 'built on Eliza' proves nothing about custom tech. Its TEE plugin has a simulated mode, so 'runs in a TEE' needs a public attestation to count." },
  { name: "Virtuals", re: /\bvirtuals?\s+protocol\b|\bapp\.virtuals\.io\b/i,
    ctx: "AI-agent launchpad; an agent token there is a template agent unless they show custom code or on-chain actions by the agent's own wallet." },
  { name: "HashEx auto-audit", re: /\bhashex\b/i,
    ctx: "HashEx publishes automated 'audits' for pump.fun tokens without being hired. 'Audited by HashEx' on a memecoin usually means an automatic token scan, not a code audit." },
  { name: "Streamflow", re: /\bstreamflow\b/i,
    ctx: "Token lock/vesting service. A lock is only real if the contract is visible on Streamflow and can't be cancelled by the sender." },
  { name: "Collector Crypt", re: /\bcollector ?crypt\b/i,
    ctx: "Tokenized trading-card platform (graded cards as NFTs, gacha packs). Projects that 'buy packs with fees' should show buys from a public wallet." },
];

function detectEcosystem(texts, addresses){
  const blob = texts.filter(Boolean).join("\n");
  const addrs = new Set(addresses.filter(Boolean));
  return ECOSYSTEM.filter(e => e.re.test(blob) || (e.addr || []).some(a => addrs.has(a)))
    .map(e => ({ name: e.name, context: e.ctx }));
}

function heliusKey(){
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY;
  try { return new URL(SOL_RPC).searchParams.get("api-key"); } catch { return null; }
}

// Every coin this wallet created before, and how many are still trading.
async function devCoins(dev, ca){
  let mints = [], pumpInfo = {};
  try {
    const H = { accept: "application/json", origin: "https://pump.fun", referer: "https://pump.fun/" };
    const r = await req(`https://frontend-api-v3.pump.fun/coins/user-created-coins/${dev}?offset=0&limit=50&includeNsfw=true`, { ms: 5000, headers: H });
    for (const c of (Array.isArray(r) ? r : r?.coins || [])){
      if (!c?.mint) continue;
      mints.push(c.mint);
      // pump.fun knows if a coin graduated and (in newer API versions) its all-time-high market cap.
      pumpInfo[c.mint] = { graduated: !!(c.complete || c.raydium_pool || c.pump_swap_pool), ath: Number(c.ath_market_cap || c.usd_market_cap || 0), symbol: c.symbol };
    }
  } catch {}
  const key = heliusKey();
  if (!mints.length && key){
    try {
      const txs = await req(`https://api.helius.xyz/v0/addresses/${dev}/transactions?api-key=${encodeURIComponent(key)}&type=CREATE&limit=50`, { ms: 7000 });
      mints = (txs || []).flatMap(t => (t.tokenTransfers || []).map(x => x.mint)).filter(Boolean);
    } catch {}
  }
  mints = [...new Set(mints)].filter(m => m !== ca && m !== "So11111111111111111111111111111111111111112");
  if (!mints.length) return { count: 0 };
  const sample = mints.slice(0, 30);
  const out = { count: mints.length, checked: sample.length, stillTrading: 0, graduated: 0, best: null };
  for (const m of mints){ const p = pumpInfo[m]; if (!p) continue; if (p.graduated) out.graduated++; if (p.ath && (!out.best || p.ath > out.best.mc)) out.best = { mc: p.ath, symbol: p.symbol, mint: m, ath: true }; }
  try {
    const j = await req(`https://api.dexscreener.com/latest/dex/tokens/${sample.join(",")}`, { ms: 6000 });
    const by = {};
    for (const p of j.pairs || []){
      const m = p.baseToken?.address; const mc = p.marketCap ?? p.fdv ?? 0; const liq = p.liquidity?.usd || 0;
      if (!by[m] || mc > by[m].mc) by[m] = { mc, liq, symbol: p.baseToken?.symbol };
    }
    for (const m of sample){
      const x = by[m]; if (!x) continue;
      if (x.liq > 5000) out.stillTrading++;
      if (!pumpInfo[m] && x.liq > 0) out.graduated++; // on a DEX pool already = left the bonding curve
      if (!out.best || x.mc > out.best.mc) out.best = { ...x, mint: m };
    }
  } catch {}
  return out;
}

// ---------- dev deep-dive: what the dev did with this coin, who funded the wallet, who bought in the launch block ----------
// Exchange hot wallets: funding from these is normal (fresh wallet bought SOL on a CEX), and says nothing bad.
const CEX = {
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM": "Binance", "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhLHvKa": "Binance",
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS": "Coinbase", "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm": "Coinbase", "GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE": "Coinbase",
  "5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD": "OKX", "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2": "Bybit", "FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5": "Kraken",
};
async function heliusParse(sigs){
  const key = heliusKey();
  if (!key || !sigs?.length) return [];
  const r = await req(`https://api.helius.xyz/v0/transactions?api-key=${encodeURIComponent(key)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transactions: sigs.slice(0, 100) }), ms: 8000 });
  return Array.isArray(r) ? r : [];
}
// Bought / sold / moved, from the dev's parsed history. "moved" = plain transfers to other wallets (supply parked elsewhere).
function devTrades(txs, dev, ca){
  let bought = 0, sold = 0, moved = 0; const to = new Set(); let seen = false;
  for (const t of txs || []) for (const x of t.tokenTransfers || []){
    if (x.mint !== ca) continue;
    const a = Number(x.tokenAmount) || 0; seen = true;
    if (x.toUserAccount === dev && x.fromUserAccount !== dev) bought += a;
    else if (x.fromUserAccount === dev && x.toUserAccount && x.toUserAccount !== dev){
      if (t.type === "TRANSFER"){ moved += a; to.add(x.toUserAccount); } else sold += a;
    }
  }
  return seen ? { bought, sold, moved, movedTo: to.size, sample: (txs || []).length } : null;
}
// The wallet's first incoming SOL: an exchange, a fresh hop, or another dev's wallet?
async function devFunding(dev, oldestSigs){
  const txs = (await heliusParse(oldestSigs)).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  let f = null;
  for (const t of txs){
    const n = (t.nativeTransfers || []).find(n => n.toUserAccount === dev && n.fromUserAccount && n.fromUserAccount !== dev && n.amount >= 1e7);
    if (n){ f = { from: n.fromUserAccount, sol: Math.round(n.amount / 1e7) / 100, at: t.timestamp ? new Date(t.timestamp * 1000).toISOString() : null }; break; }
  }
  if (!f) return null;
  f.label = CEX[f.from] || KNOWN[f.from] || null;
  if (f.label) return f;
  const H = { accept: "application/json", origin: "https://pump.fun", referer: "https://pump.fun/" };
  const [sg, coins] = await Promise.allSettled([
    rpc("getSignaturesForAddress", [f.from, { limit: 1000 }]),
    req(`https://frontend-api-v3.pump.fun/coins/user-created-coins/${f.from}?offset=0&limit=50&includeNsfw=true`, { ms: 5000, headers: H }),
  ]);
  if (sg.status === "fulfilled") f.funderTxs = sg.value.length >= 1000 ? "1000+" : sg.value.length;
  if (coins.status === "fulfilled"){ const c = Array.isArray(coins.value) ? coins.value : coins.value?.coins || []; f.funderLaunched = c.filter(x => x?.mint).length; }
  return f;
}
// Everyone who got the token in the creation block: the dev's buy plus any bundled wallets.
async function launchBlock(ca, sigs, dev, supply){
  const txs = await heliusParse(sigs);
  const curve = (() => { try { return pda([Buffer.from("bonding-curve"), b58dec(ca)], PUMP); } catch { return null; } })();
  // The pool = whoever SENDS the most tokens in this block (pump.fun curve, LaunchLab / Meteora vault…).
  // Mints into the vault have no sender and are skipped, so the vault is never counted as a "buyer".
  const outflow = {};
  for (const t of txs) for (const x of t.tokenTransfers || []){
    if (x.mint === ca && x.fromUserAccount) outflow[x.fromUserAccount] = (outflow[x.fromUserAccount] || 0) + (Number(x.tokenAmount) || 0);
  }
  const pool = curve && outflow[curve] ? curve : Object.entries(outflow).sort((a, b) => b[1] - a[1])[0]?.[0];
  const got = {};
  for (const t of txs) for (const x of t.tokenTransfers || []){
    if (x.mint !== ca || !x.toUserAccount || x.fromUserAccount !== pool || x.toUserAccount === pool) continue;
    got[x.toUserAccount] = (got[x.toUserAccount] || 0) + (Number(x.tokenAmount) || 0);
  }
  const others = Object.entries(got).filter(([w]) => w !== dev).sort((a, b) => b[1] - a[1]);
  const out = { txs: txs.length, wallets: others.length, devPct: supply && got[dev] ? (got[dev] / supply) * 100 : 0, otherPct: supply ? (others.reduce((t, [, a]) => t + a, 0) / supply) * 100 : null };
  if (others.length && supply){
    const top = others.slice(0, 8);
    const held = await Promise.allSettled(top.map(([w]) => rpc("getTokenAccountsByOwner", [w, { mint: ca }, { encoding: "jsonParsed" }])));
    let still = 0, n = 0;
    held.forEach(h => { if (h.status !== "fulfilled") return; n++; still += (h.value?.value || []).reduce((t, a) => t + Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0); });
    if (n) out.stillHoldPct = (still / supply) * 100;
    out.checkedHolders = n;
  }
  return out;
}

async function launchAndDev(ca, meta, supply){
  // some launchpads (Agency) don't set createdOn but point "website" at their own /coin/<CA> page
  const padSite = !meta?.createdOn && /\/(?:coin|token)\/[1-9A-HJ-NP-Za-km-z]{32,44}/.test(meta?.website || "") ? meta.website : null;
  const out = { launchpad: launchpadName(meta?.createdOn || padSite), createdAt: null, launchProgram: null, programsInLaunchTx: [], dev: null };
  let launchSigs = [];
  let devAddr = meta?.creator || null;
  // The token's first transaction: who paid for it and which programs created it (young tokens only: < 1000 txs).
  try {
    const sigs = await rpc("getSignaturesForAddress", [ca, { limit: 1000 }]);
    if (sigs.length && sigs.length < 1000){
      const first = sigs[sigs.length - 1];
      out.createdAt = first.blockTime ? new Date(first.blockTime * 1000).toISOString() : null;
      launchSigs = sigs.filter(s => s.slot === first.slot && !s.err).map(s => s.signature).slice(-40);
      const tx = await rpc("getTransaction", [first.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
      const keys = tx?.transaction?.message?.accountKeys || [];
      devAddr ||= keys[0]?.pubkey || null;
      const progs = new Set();
      (tx?.transaction?.message?.instructions || []).forEach(i => i.programId && progs.add(i.programId));
      (tx?.meta?.innerInstructions || []).forEach(g => g.instructions.forEach(i => i.programId && progs.add(i.programId)));
      out.programsInLaunchTx = [...progs].map(id => ({ id, label: KNOWN[id] || null }));
      const own = out.programsInLaunchTx.find(p => !p.label);
      const named = out.programsInLaunchTx.find(p => /pump|Meteora|Raydium|Jupiter|Orca/.test(p.label || ""));
      out.launchProgram = named ? named.label : own ? own.id : null;
    }
  } catch {}
  if (!devAddr) return out;

  const dev = { address: devAddr };
  const tasks = [
    rpc("getBalance", [devAddr]).then(b => { dev.sol = (b?.value ?? 0) / 1e9; }),
    rpc("getTokenAccountsByOwner", [devAddr, { mint: ca }, { encoding: "jsonParsed" }]).then(r => {
      const amt = (r?.value || []).reduce((s, a) => s + Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
      dev.holdsPct = supply ? (amt / supply) * 100 : null;
    }),
    rpc("getSignaturesForAddress", [devAddr, { limit: 1000 }]).then(async sg => {
      dev.txCount = sg.length >= 1000 ? "1000+" : sg.length;
      if (sg.length) dev.oldestTxInSample = sg.at(-1).blockTime ? new Date(sg.at(-1).blockTime * 1000).toISOString() : null;
      // Wallet's whole history fits in the sample → its first txs show who funded it.
      if (sg.length && sg.length < 1000) try { dev.funding = await devFunding(devAddr, sg.slice(-4).map(s => s.signature)); } catch {}
    }),
  ];
  const key = heliusKey();
  if (key){
    // Follow the money: the dev wallet's recent activity, parsed by Helius.
    tasks.push(req(`https://api.helius.xyz/v0/addresses/${devAddr}/transactions?api-key=${encodeURIComponent(key)}&limit=100`, { ms: 8000 }).then(txs => {
      dev.trades = devTrades(txs, devAddr, ca);
      const types = {}; const outSol = {}; const claims = [];
      for (const t of txs || []){
        types[t.type || "UNKNOWN"] = (types[t.type || "UNKNOWN"] || 0) + 1;
        for (const n of t.nativeTransfers || []){
          if (n.fromUserAccount === devAddr && n.toUserAccount && n.toUserAccount !== devAddr) outSol[n.toUserAccount] = (outSol[n.toUserAccount] || 0) + n.amount / 1e9;
        }
        if (/claim|collect|fee/i.test((t.type || "") + " " + (t.description || ""))) claims.push({ type: t.type, desc: (t.description || "").slice(0, 160), at: t.timestamp ? new Date(t.timestamp * 1000).toISOString() : null });
      }
      dev.recentTxTypes = types;
      dev.topSolRecipients = Object.entries(outSol).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([to, sol]) => ({ to, sol: Math.round(sol * 1000) / 1000, label: KNOWN[to] || null }));
      dev.feeOrClaimTxs = claims.slice(0, 8);
      dev.sampleSize = (txs || []).length;
    }));
  }
  tasks.push(devCoins(devAddr, ca).then(c => { dev.otherCoins = c; }));
  if (key && launchSigs.length) tasks.push(launchBlock(ca, launchSigs, devAddr, supply).then(b => { out.launchBlock = b; }).catch(() => {}));
  await Promise.allSettled(tasks);
  out.dev = dev;
  return out;
}

// ---------- creator fees: where pump.fun / PumpSwap creator fees really go, read straight from the accounts ----------
// Layouts from pump.fun's public IDLs (github.com/pump-fun/pump-public-docs). Every read checks owner + discriminator,
// so an unexpected account gives "unknown", never a wrong answer.
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", PUMP_FEES = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const SYSTEM = "11111111111111111111111111111111";
function b58dec(s){
  let n = 0n; for (const ch of s){ const i = B58.indexOf(ch); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const out = []; while (n > 0n){ out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const ch of s){ if (ch === "1") out.unshift(0); else break; }
  return Uint8Array.from(out);
}
const FP = 2n ** 255n - 19n;
const fmod = a => ((a % FP) + FP) % FP;
function fpow(b, e){ let r = 1n; b = fmod(b); while (e > 0n){ if (e & 1n) r = r * b % FP; b = b * b % FP; e >>= 1n; } return r; }
const ED_D = fmod(-121665n * fpow(121666n, FP - 2n));
// Is this 32-byte string a valid ed25519 point? PDAs are the ones that are NOT.
function onCurve(k){
  let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? k[i] & 0x7f : k[i]);
  if (y >= FP) return false;
  const y2 = y * y % FP, x2 = fmod(y2 - 1n) * fpow(fmod(ED_D * y2 + 1n), FP - 2n) % FP;
  if (x2 === 0n) return (k[31] & 0x80) === 0;
  return fpow(x2, (FP - 1n) / 2n) === 1n;
}
function pda(seeds, programId){
  const prog = b58dec(programId);
  for (let bump = 255; bump >= 0; bump--){
    const h = createHash("sha256"); seeds.forEach(s => h.update(s)); h.update(Uint8Array.of(bump)); h.update(prog); h.update("ProgramDerivedAddress");
    const k = h.digest(); if (!onCurve(k)) return b58(k);
  }
  return null;
}
const hasDisc = (d, disc) => d.length >= 8 && disc.every((x, i) => d[i] === x);
async function creatorFees(ca, market){
  const curve = pda([Buffer.from("bonding-curve"), b58dec(ca)], PUMP);
  // Holder-rewards coins point their creator at this PDA (pump.fun pays the fees out to holders).
  const holderPda = pda([Buffer.from("holder-rewards"), b58dec(ca)], PUMP);
  const pool = market?.pumpswapPair || null;
  const res = await rpc("getMultipleAccounts", [[curve, pool].filter(Boolean), { encoding: "base64" }]);
  const cv = res?.value?.[0], pv = pool ? res?.value?.[1] : null;
  const out = { venue: null, recipient: null, graduated: null, holderRewards: false, cashback: false, curve, holderPda };
  let rcpt = null;
  if (cv?.owner === PUMP){
    const d = b64(cv.data[0]);
    if (d.length >= 81 && hasDisc(d, [23, 183, 248, 55, 96, 216, 172, 96])){
      out.venue = "pump.fun"; out.graduated = d[48] === 1; rcpt = b58(d.slice(49, 81));
      if (d.length > 82) out.cashback = d[82] === 1;
      if (d.length > 124) out.holderRewards = d[124] === 1;
    }
  }
  if (pv?.owner === PUMP_AMM){
    const d = b64(pv.data[0]);
    if (d.length >= 243 && hasDisc(d, [241, 154, 109, 4, 17, 177, 109, 188]) && b58(d.slice(43, 75)) === ca){
      const cc = b58(d.slice(211, 243));
      if (cc !== SYSTEM){ rcpt = cc; out.venue = "PumpSwap"; out.graduated = true; }
      if (d.length > 244) out.cashback ||= d[244] === 1;
      if (d.length > 270) out.holderRewards ||= d[270] === 1;
    }
  }
  if (!rcpt || rcpt === SYSTEM) return out.venue ? { ...out, kind: "none" } : null;
  out.recipient = rcpt;
  if (rcpt === holderPda) out.holderRewards = true;
  if (out.holderRewards){
    out.kind = "holders";
    // SOL sitting on the PDA = fees collected but not paid out to holders yet.
    try { const a = (await rpc("getMultipleAccounts", [[holderPda], { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]))?.value?.[0]; if (a) out.pendingSol = Math.round(a.lamports / 1e7) / 100; } catch {}
    return out;
  }
  const acc = (await rpc("getMultipleAccounts", [[rcpt], { encoding: "base64" }]))?.value?.[0];
  if (acc?.owner === PUMP_FEES){
    const d = b64(acc.data[0]);
    if (d.length >= 80 && hasDisc(d, [216, 74, 9, 0, 56, 140, 93, 75])){
      const dv = new DataView(d.buffer, d.byteOffset, d.length);
      out.kind = "split"; out.active = d[10] === 1; out.locked = d[75] === 1; out.shares = [];
      const n = Math.min(dv.getUint32(76, true), 10);
      for (let i = 0; i < n; i++){ const o = 80 + i * 34; if (o + 34 > d.length) break; out.shares.push({ address: b58(d.slice(o, o + 32)), pct: dv.getUint16(o + 32, true) / 100 }); }
      out.shares.sort((a, b) => b.pct - a.pct);
    } else out.kind = "program";
  } else if (!acc || acc.owner === SYSTEM){ out.kind = "wallet"; out.sol = acc ? acc.lamports / 1e9 : 0; }
  else { out.kind = "program"; out.owner = acc.owner; }
  return out;
}
// Name the addresses once we know who the dev is.
function labelFees(fees, dev){
  if (!fees) return fees;
  fees.devKnown = !!dev;
  const label = a => a === fees.holderPda ? "holders (pump.fun holder rewards)" : a === dev ? "dev wallet" : ECOSYSTEM.find(e => (e.addr || []).includes(a))?.name || KNOWN[a] || null;
  if (fees.recipient) fees.label = label(fees.recipient);
  if (fees.owner) fees.ownerLabel = label(fees.owner);
  (fees.shares || []).forEach(s => { s.label = label(s.address); });
  if (fees.shares) fees.devPct = fees.shares.filter(s => s.address === dev).reduce((t, s) => t + s.pct, 0);
  return fees;
}

// X: the official API (paid per read) when X_BEARER_TOKEN is set — profile + pinned post + latest posts.
// Cost per check ≈ $0.01 (profile) + $0.005 per post read. Results are cached in memory for 6h per handle.
const X_CACHE = new Map();
function xToken(){ return String(process.env.X_BEARER_TOKEN || "").replace(/[​-‍﻿]/g, "").trim().replace(/^["']+|["']+$/g, "").replace(/^Bearer\s+/i, "").trim(); }

async function xOfficial(handle){
  const tok = xToken();
  const H = { authorization: `Bearer ${tok}` };
  const n = Math.min(20, Math.max(5, Number(process.env.X_MAX_POSTS) || 10));
  const u = await req(`https://api.x.com/2/users/by/username/${handle}?user.fields=created_at,description,public_metrics,url,entities,verified_type&expansions=pinned_tweet_id&tweet.fields=created_at,public_metrics`, { headers: H, ms: 7000 });
  const d = u?.data; if (!d) return null;
  const pinned = u.includes?.tweets?.[0];
  const out = {
    handle: d.username, followers: d.public_metrics?.followers_count, posts: d.public_metrics?.tweet_count, joined: d.created_at, bio: d.description,
    website: d.entities?.url?.urls?.[0]?.expanded_url || null, verified: d.verified_type || null,
    pinned: pinned ? { id: pinned.id, text: pinned.text, at: pinned.created_at, replies: pinned.public_metrics?.reply_count } : null, recentPosts: [], source: "X API",
  };
  try {
    const t = await req(`https://api.x.com/2/users/${d.id}/tweets?max_results=${n}&exclude=retweets,replies&tweet.fields=created_at,public_metrics`, { headers: H, ms: 7000 });
    out.recentPosts = (t?.data || []).map(p => ({ id: p.id, replies: p.public_metrics?.reply_count, at: p.created_at, text: p.text.slice(0, 400), likes: p.public_metrics?.like_count, reposts: p.public_metrics?.retweet_count, views: p.public_metrics?.impression_count }));
  } catch {}
  return out;
}

async function xProfile(handle){
  const k = handle.toLowerCase(); const hit = X_CACHE.get(k);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.v;
  let v = null;
  if (xToken()) try { v = await xOfficial(handle); } catch (e) { console.log("[pruf] X API failed:", e?.message || e); }
  if (!v){
    const u = (await req(`https://api.fxtwitter.com/${handle}`)).user;
    v = u ? { handle: u.screen_name, followers: u.followers, posts: u.tweets, joined: u.joined, bio: u.description, website: u.website?.url || null, source: "fxtwitter (no posts)" } : null;
  }
  if (v) X_CACHE.set(k, { at: Date.now(), v });
  return v;
}

// An X post the user wants checked: its text, author and links.
async function readTweet(id){
  const tok = xToken();
  if (tok){
    try {
      const j = await req(`https://api.x.com/2/tweets/${id}?expansions=author_id&user.fields=username&tweet.fields=created_at,entities,note_tweet,conversation_id`, { headers: { authorization: `Bearer ${tok}` }, ms: 7000 });
      const d = j?.data;
      if (d) return { text: d.note_tweet?.text || d.text, handle: j.includes?.users?.[0]?.username, at: d.created_at, conversationId: d.conversation_id || null,
        links: (d.entities?.urls || []).map(u => u.expanded_url).filter(u => u && !/(^https?:\/\/)?(www\.)?(x|twitter)\.com\//i.test(u)) };
    } catch (e) { console.log("[pruf] X post via API failed:", e?.message || e); }
  }
  const j = await req(`https://api.fxtwitter.com/status/${id}`, { ms: 7000 });
  const t = j?.tweet;
  if (!t) return {};
  return { text: t.text, handle: t.author?.screen_name, at: t.created_at,
    links: [...String(t.text || "").matchAll(/https?:\/\/[^\s]+/g)].map(m => m[0]).filter(u => !/(x|twitter)\.com\/|t\.co\//i.test(u)) };
}

// What the trench answers under a post. X recent search (last 7 days), paid per post read: X_MAX_REPLIES (default 15, 0 = off).
async function xReplies(conversationId, teamHandle){
  const tok = xToken(); const n = Number(process.env.X_MAX_REPLIES ?? 15);
  if (!tok || !conversationId || !(n > 0)) return null;
  const q = encodeURIComponent(`conversation_id:${conversationId} -is:retweet`);
  const j = await req(`https://api.x.com/2/tweets/search/recent?query=${q}&max_results=${Math.min(100, Math.max(10, n))}&tweet.fields=author_id,created_at,public_metrics&expansions=author_id&user.fields=username,public_metrics`, { headers: { authorization: `Bearer ${tok}` }, ms: 7000 });
  const users = Object.fromEntries((j?.includes?.users || []).map(u => [u.id, u]));
  const all = (j?.data || []).filter(t => t.id !== conversationId).map(t => {
    const u = users[t.author_id] || {};
    return { by: u.username || "?", followers: u.public_metrics?.followers_count ?? null, likes: t.public_metrics?.like_count || 0,
      team: !!teamHandle && u.username?.toLowerCase() === teamHandle.toLowerCase(), text: String(t.text).replace(/^(@\w+\s+)+/, "").slice(0, 280) };
  });
  // Drop "gm", emoji-only and link-only replies: they say nothing.
  const said = all.filter(r => r.text.replace(/https?:\/\/\S+/g, " ").replace(/[^\p{L}\p{N}$]+/gu, " ").trim().split(" ").filter(Boolean).length >= 3);
  said.sort((a, b) => b.likes - a.likes || (b.followers || 0) - (a.followers || 0));
  return { conversationId, read: all.length, replies: said.slice(0, n) };
}
// No post given? Take the project's most-discussed post from the last 6 days (older ones are outside X's search window).
function busiestPost(x){
  const fresh = [x?.pinned, ...(x?.recentPosts || [])].filter(p => p?.id && p.at && Date.now() - Date.parse(p.at) < 6 * 864e5);
  fresh.sort((a, b) => (b.replies || 0) - (a.replies || 0));
  return fresh[0]?.replies >= 3 ? fresh[0] : null;
}

// ---------- narrative investigation: OG or copycat, does the source exist, did the named account ever mention it ----------
const normName = x => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// IPFS content id of an image URL: the same file always has the same CID, so a copied image is caught exactly.
const imageCid = u => (String(u || "").match(/(?:ipfs\/|ipfs:\/\/)((?:Qm[1-9A-HJ-NP-Za-km-z]{44})|(?:bafy[a-z2-7]{50,}))/) || [])[1] || null;
async function ogCheck(ca, name, symbol, myCreated, myImage){
  const S = normName(symbol), N = normName(name);
  if (!S && !N) return null;
  const toks = {};
  const myCid = imageCid(myImage);
  const sameImg = {};
  const add = (mint, sym, nm, created, mc, img) => {
    if (mint && mint !== ca && myCid && imageCid(img) === myCid) sameImg[mint] = { mint, symbol: sym, name: nm, createdAt: created || null, mc: Number(mc) || 0 };
    if (!mint || !((S && normName(sym) === S) || (N.length >= 3 && normName(nm) === N))) return;
    const t = toks[mint] ||= { mint, symbol: sym, name: nm, createdAt: Infinity, mc: 0 };
    if (created) t.createdAt = Math.min(t.createdAt, created);
    t.mc = Math.max(t.mc, Number(mc) || 0);
  };
  const H = { accept: "application/json", origin: "https://pump.fun", referer: "https://pump.fun/" };
  const term = symbol || name;
  const [d1, d2, pf] = await Promise.allSettled([
    req(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol || name)}`, { ms: 6000 }),
    name && symbol && N !== S ? req(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(name)}`, { ms: 6000 }) : Promise.resolve(null),
    req(`https://frontend-api-v3.pump.fun/coins?searchTerm=${encodeURIComponent(term)}&offset=0&limit=50&sort=created_timestamp&order=ASC&includeNsfw=true`, { ms: 5000, headers: H }),
  ]);
  for (const d of [d1, d2]) if (d.status === "fulfilled" && d.value) for (const p of d.value.pairs || []){
    if (p.chainId !== "solana") continue;
    add(p.baseToken?.address, p.baseToken?.symbol, p.baseToken?.name, p.pairCreatedAt, p.marketCap ?? p.fdv);
  }
  if (pf.status === "fulfilled") for (const c of (Array.isArray(pf.value) ? pf.value : pf.value?.coins || [])) add(c.mint, c.symbol, c.name, c.created_timestamp, c.usd_market_cap, c.image_uri);
  const list = Object.values(toks);
  const me = toks[ca];
  const mine = me && isFinite(me.createdAt) ? me.createdAt : myCreated || null;
  const others = list.filter(t => t.mint !== ca);
  const older = mine ? others.filter(t => isFinite(t.createdAt) && t.createdAt < mine).sort((a, b) => a.createdAt - b.createdAt) : [];
  const biggest = [...others].sort((a, b) => b.mc - a.mc)[0] || null;
  if (biggest && mine && isFinite(biggest.createdAt)) biggest.launched = biggest.createdAt < mine ? "before this one" : "after this one (a later copy)";
  const imgCopies = Object.values(sameImg).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return { imageCid: myCid, sameImage: imgCopies.slice(0, 5), sameImageOlder: mine ? imgCopies.filter(t => t.createdAt && t.createdAt < mine).length : null, sameNameOrTicker: others.length, og: !others.length ? true : mine ? !older.length : null, olderCount: older.length, oldest: older[0] || null, biggest, myMc: me?.mc || null, searched: "DexScreener + pump.fun search (Solana)" };
}
// Posts the coin points to (metadata X field, description, site, the project's own posts): who wrote them and when.
async function narrativeSources(texts, skipId){
  const ids = new Map();
  for (const t of texts) for (const m of String(t || "").matchAll(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{6,25})/gi)){
    if (m[2] !== skipId && !ids.has(m[2]) && ids.size < 3) ids.set(m[2], m[1]);
  }
  const res = await Promise.allSettled([...ids.keys()].map(async id => ({ id, ...(await readTweet(id)) })));
  return res.filter(r => r.status === "fulfilled" && r.value.text).map(r => ({ url: `x.com/${r.value.handle}/status/${r.value.id}`, by: r.value.handle, at: r.value.at, text: String(r.value.text).slice(0, 300) }));
}
// Did this account ever post the CA or the ticker? (X recent search = last 7 days.)
async function xMentions(handle, ca, symbol){
  const tok = xToken();
  if (!tok || !handle) return null;
  if (!ca && !symbol) return null;
  const terms = [ca ? `"${ca}"` : null, symbol && /^[A-Za-z0-9]{2,12}$/.test(symbol) ? `"$${symbol}"` : null].filter(Boolean).join(" OR ");
  const q = encodeURIComponent(`from:${handle} (${terms})`);
  const j = await req(`https://api.x.com/2/tweets/search/recent?query=${q}&max_results=10&tweet.fields=created_at`, { headers: { authorization: `Bearer ${tok}` }, ms: 7000 });
  return { handle, posts: (j?.data || []).length, examples: (j?.data || []).slice(0, 2).map(t => ({ at: t.created_at, text: String(t.text).slice(0, 200) })), window: "last 7 days" };
}

// Who's been posting the CA on X (last 7 days). Simple on purpose: accounts + reach. X_MAX_SHILLS (default 10, 0 = off).
async function xCaPosts(ca){
  const tok = xToken(); const n = Number(process.env.X_MAX_SHILLS ?? 10);
  if (!tok || !(n > 0)) return null;
  const q = encodeURIComponent(`"${ca}" -is:retweet`);
  const j = await req(`https://api.x.com/2/tweets/search/recent?query=${q}&max_results=${Math.min(100, Math.max(10, n))}&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username,public_metrics`, { headers: { authorization: `Bearer ${tok}` }, ms: 7000 });
  const users = Object.fromEntries((j?.includes?.users || []).map(u => [u.id, u]));
  const posts = (j?.data || []).map(t => ({ by: users[t.author_id]?.username || "?", followers: users[t.author_id]?.public_metrics?.followers_count ?? 0, at: t.created_at }));
  const acc = {};
  posts.forEach(p => { acc[p.by] = acc[p.by] || { handle: p.by, followers: p.followers, posts: 0 }; acc[p.by].posts++; });
  const accounts = Object.values(acc).sort((a, b) => b.followers - a.followers);
  const first = posts.map(p => p.at).filter(Boolean).sort()[0] || null;
  return { sampled: posts.length, more: !!j?.meta?.next_token, accounts: accounts.slice(0, 6), accountCount: accounts.length, firstSeen: first, window: "last 7 days" };
}

async function domainAge(url){
  const domain = new URL(url).hostname.replace(/^www\./, "").split(".").slice(-2).join(".");
  const j = await req(`https://rdap.org/domain/${domain}`, { headers: { accept: "application/rdap+json" } });
  return { domain, registered: (j.events || []).find(e => e.eventAction === "registration")?.eventDate || null };
}

function tokenBasics(f){
  const c = [];
  const d = f.market;
  if (d){
    c.push({ label: "Trading on", value: d.venues.map(x => VENUES[x] || x).join(", "), tone: "info" });
    if (isFinite(d.createdAt)) c.push({ label: "Token age", value: ago(d.createdAt), tone: "info" });
    c.push({ label: "Liquidity", value: usd(d.liquidityUsd), tone: d.liquidityUsd < 10000 ? "warn" : "good" });
    if (d.marketCap) c.push({ label: "Market cap", value: usd(d.marketCap), tone: "info" });
  }
  const m = f.mint;
  if (m){
    c.push({ label: "Mint authority", value: m.mintAuthority ? "Active" : "Revoked", tone: m.mintAuthority ? "bad" : "good" });
    c.push({ label: "Freeze authority", value: m.freezeAuthority ? "Active" : "Revoked", tone: m.freezeAuthority ? "bad" : "good" });
    const risky = m.extensions.filter(e => RISKY_EXTENSIONS.includes(e));
    if (risky.length) c.push({ label: "Token-2022 extensions", value: risky.join(", "), tone: "bad" });
    if (m.top10Pct != null) c.push({ label: "Top 10 holders", value: pct(m.top10Pct) + " (incl. pools)", tone: m.top10Pct > 50 ? "bad" : m.top10Pct > 30 ? "warn" : "good" });
  }
  if (f.domain?.registered) c.push({ label: "Domain registered", value: ago(Date.parse(f.domain.registered)) + " ago", tone: (Date.now() - Date.parse(f.domain.registered)) / 864e5 < 30 ? "warn" : "info" });
  if (f.x) c.push({ label: "X account", value: `@${f.x.handle} · ${Number(f.x.followers || 0).toLocaleString("en")} followers` + (f.x.joined ? ` · ${ago(Date.parse(f.x.joined))} old` : ""), tone: "info" });
  return c;
}

// Where the creator fees go, as a card.
function feesCard(fe){
  if (!fe || !fe.venue) return null;
  const who = (a, l) => l || short(a);
  const src = `Read on-chain from the ${fe.venue} ${fe.venue === "PumpSwap" ? "pool" : "bonding curve"}`;
  let title, tone = "info"; const lines = [];
  if (fe.kind === "holders"){ title = "Creator fees → holders"; tone = "good"; lines.push("Holder-rewards coin: pump.fun pays the fees to holders, no creator wallet"); if (fe.pendingSol > 0) lines.push(`${fe.pendingSol} SOL collected, waiting for the next payout`); }
  else if (fe.kind === "none"){ title = "No creator-fee recipient set"; }
  else if (fe.kind === "wallet"){
    title = fe.label === "dev wallet" ? "Creator fees → the dev wallet" : `Creator fees → ${fe.label || (fe.devKnown ? "another wallet, not the dev" : "this wallet")}`;
    if (!fe.label) tone = "warn";
    lines.push(`${(fe.sol ?? 0).toFixed(2)} SOL in it`);
  }
  else if (fe.kind === "split"){
    title = `Creator fees split ${fe.shares.length} way${fe.shares.length > 1 ? "s" : ""}`;
    fe.shares.slice(0, 5).forEach(x => lines.push(`${x.pct}% → ${who(x.address, x.label)}`));
    if (fe.shares.length > 5) lines.push(`+${fe.shares.length - 5} more`);
    lines.push(fe.locked ? "Split is locked forever" : "Admin can still change the split once");
    if (fe.active === false) lines.push("Sharing is paused");
    tone = fe.devPct >= 50 ? "warn" : "good";
  }
  else { title = "Creator fees → a program-controlled account"; if (fe.owner) lines.push(`Owned by ${who(fe.owner, fe.ownerLabel)}`); tone = "warn"; }
  if (fe.cashback) lines.push("Cashback coin: part of the fees goes back to traders");
  lines.push(src);
  return { address: fe.recipient, title, lines, tone };
}

// What PRUF found, in a shape the page can render without Claude.
function techSummary(f){
  const s = f.site || {};
  const programs = (f.probes || []).filter(p => p.kind === "program" && !KNOWN[p.address]).map(p => ({
    address: p.address,
    lines: [
      p.lastDeployed ? `Deployed ${ago(Date.parse(p.lastDeployed))} ago` : null,
      p.txCount != null ? `${p.txCount} recent txs` + (p.lastTx ? `, last ${ago(Date.parse(p.lastTx))} ago` : "") : null,
      p.upgradeable ? (p.frozen ? "Code frozen (can't be changed)" : `Team can change the code (authority ${short(p.upgradeAuthority || "")})`) : "Not upgradeable",
      p.verifiedBuild === true ? "Verified build matches source" : p.verifiedBuild === false ? "No verified build" : null,
    ].filter(Boolean),
    tone: p.txCount === 0 ? "bad" : p.verifiedBuild ? "good" : "warn",
  }));
  const missing = (f.probes || []).filter(p => p.kind === "missing").map(p => p.address);
  const wallets = (f.probes || []).filter(p => p.kind === "wallet").map(p => ({ address: p.address, sol: p.sol, txCount: p.txCount, lastTx: p.lastTx }));
  const usesKnown = [...new Set([...(s.solAddresses || []), ...(f.docAddresses || [])].filter(a => KNOWN[a]).map(a => KNOWN[a]))];
  const flags = [];
  if (s.leakedSecrets?.length) flags.push({ tone: "bad", text: "Secrets exposed in the website code: " + s.leakedSecrets.join(", ") });
  if (s.randomNearMetrics) flags.push({ tone: "bad", text: `${s.randomNearMetrics} place${s.randomNearMetrics > 1 ? "s" : ""} where on-screen numbers may be generated with Math.random()` });
  if (missing.length) flags.push({ tone: "bad", text: missing.length > 1 ? `${missing.length} addresses in their code or docs don't exist on-chain` : "1 address in their code or docs doesn't exist on-chain" });
  const L = f.launch || {};
  const d = L.dev;
  const progLabel = L.launchProgram && !isSol(L.launchProgram) ? L.launchProgram.replace(/ program$/, "") : null;
  const via = L.launchpad?.name ? L.launchpad.name + (progLabel && !progLabel.toLowerCase().includes(L.launchpad.name.toLowerCase()) ? ` (on ${progLabel})` : "") : (progLabel || L.launchProgram);
  // The launch model matters as much as the venue: who gets the trading fees.
  const fe = f.fees;
  const model = fe?.kind === "holders" ? "holder rewards" : fe?.cashback ? "cashback" : fe?.kind === "split" ? "fee sharing" : null;
  const launch = via ? { via, created: L.createdAt, model } : null;
  const supply = f.mint?.supply || null;
  const tr = d?.trades, fu = d?.funding, lb = L.launchBlock;
  const soldShare = tr?.bought > 0 ? Math.min(1, tr.sold / tr.bought) : null;
  const devCard = d ? {
    address: d.address,
    lines: [
      tr && tr.bought > 0 ? (soldShare >= 0.97 ? "Sold their whole bag" : soldShare > 0.02 ? `Sold ${Math.round(soldShare * 100)}% of their bag` : "Hasn't sold") + (supply ? ` · bought ${pct((tr.bought / supply) * 100)} of supply` : "") : null,
      tr?.moved > 0 && supply ? `Moved ${pct((tr.moved / supply) * 100)} of supply to ${tr.movedTo} other wallet${tr.movedTo === 1 ? "" : "s"}` : null,
      fu ? (fu.label ? `Funded from ${fu.label} (${fu.sol} SOL)` : fu.funderLaunched ? `Funded by ${short(fu.from)}, a wallet that launched ${fu.funderLaunched} coin${fu.funderLaunched === 1 ? "" : "s"}` : fu.funderTxs === "1000+" ? `Funded by a high-volume wallet ${short(fu.from)} (exchange or bot)` : `Funded by ${short(fu.from)} (${fu.sol} SOL)`) : null,
      d.holdsPct != null ? `Holds ${pct(d.holdsPct)} of supply` : null,
      d.sol != null ? `${d.sol.toFixed(2)} SOL in wallet` : null,
      d.txCount != null ? `${d.txCount} tx${d.txCount === 1 ? "" : "s"}` + (d.oldestTxInSample ? `, active since ${ago(Date.parse(d.oldestTxInSample))} ago` : "") : null,
      d.topSolRecipients?.length ? `Sends most SOL to ${short(d.topSolRecipients[0].label || d.topSolRecipients[0].to)}` : null,
      d.feeOrClaimTxs?.length ? `${d.feeOrClaimTxs.length} fee/claim txs recently` : null,
      d.otherCoins ? (d.otherCoins.count ? `Launched ${d.otherCoins.count} other coin${d.otherCoins.count > 1 ? "s" : ""} before · ${d.otherCoins.graduated} graduated · ${d.otherCoins.stillTrading} still trading` + (d.otherCoins.best?.mc > 50000 ? ` · best: $${d.otherCoins.best.symbol} ${d.otherCoins.best.ath ? "peaked at" : "at"} ${usd(d.otherCoins.best.mc)}` : "") : "First coin from this wallet") : null,
    ].filter(Boolean),
    tone: d.holdsPct > 10 ? "bad" : d.holdsPct > 3 ? "warn" : "good",
  } : null;
  if (d?.holdsPct > 10) flags.push({ tone: "bad", text: `Dev wallet holds ${pct(d.holdsPct)} of supply` });
  if (tr?.moved > 0 && supply && tr.moved / supply > 0.01) flags.push({ tone: "bad", text: `Dev moved ${pct((tr.moved / supply) * 100)} of supply to ${tr.movedTo} other wallet${tr.movedTo === 1 ? "" : "s"} — supply hidden from the dev wallet` });
  if (soldShare >= 0.97) flags.push({ tone: "warn", text: "Dev already sold their whole bag" });
  if (fu?.funderLaunched >= 3) flags.push({ tone: "warn", text: `Dev wallet was funded by a wallet that launched ${fu.funderLaunched} coins — likely the same dev` });
  if (lb?.otherPct >= 10) flags.push({ tone: lb.stillHoldPct >= 5 ? "bad" : "warn", text: `${lb.wallets} wallet${lb.wallets === 1 ? "" : "s"} bought ${pct(lb.otherPct)} in the launch block (bundle)` + (lb.stillHoldPct != null ? `, still holding ${pct(lb.stillHoldPct)}` : "") });
  // Narrative: OG or copycat, the posts it points to, and whether the named accounts ever mentioned it.
  const og = f.og, nv = f.narrative || {};
  const created = isFinite(f.market?.createdAt) ? f.market.createdAt : (L.createdAt ? Date.parse(L.createdAt) : null);
  const nLines = [];
  if (og){
    if (!og.sameNameOrTicker) nLines.push("Only token with this name/ticker on Solana");
    else if (og.og === null) nLines.push(`${og.sameNameOrTicker} other token${og.sameNameOrTicker === 1 ? "" : "s"} share this name/ticker (couldn't date this one)`);
    else if (og.og) nLines.push(`OG: the first of ${og.sameNameOrTicker + 1} tokens with this name/ticker`);
    else nLines.push(`Not the OG: ${og.olderCount} older token${og.olderCount === 1 ? "" : "s"} with this name/ticker, first one ${ago(og.oldest.createdAt)} ago` + (og.oldest.mc ? ` (now ${usd(og.oldest.mc)})` : ""));
    if (og.biggest && og.biggest.mc > Math.max(2 * (og.myMc || f.market?.marketCap || 0), 50000)) nLines.push((og.og && og.biggest.launched?.startsWith("after") ? `A later copy grew bigger: ${usd(og.biggest.mc)}` : `Biggest one with this name: ${usd(og.biggest.mc)}`) + ` (${short(og.biggest.mint)})`);
  }
  (nv.sources || []).forEach(src => {
    const t = Date.parse(src.at);
    nLines.push(`Points to a post by @${src.by}` + (isFinite(t) && created ? (t < created ? `, posted ${ago(Date.now() - (created - t))} before the coin` : ", posted after the coin launched") : ""));
  });
  (nv.mentions || []).forEach(m => nLines.push(m.posts ? `@${m.handle} posted the CA/ticker ${m.posts} time${m.posts === 1 ? "" : "s"} (last 7 days)` : `@${m.handle} never posted the CA or ticker (last 7 days)`));
  if (og?.sameImage?.length) nLines.push(`Same image file as ${og.sameImage.length} other token${og.sameImage.length === 1 ? "" : "s"}` + (og.sameImageOlder ? ` (${og.sameImageOlder} older)` : "") + `: ${og.sameImage.slice(0, 2).map(t => "$" + (t.symbol || short(t.mint))).join(", ")}`);
  const cp = f.caPosts;
  if (cp) nLines.push(cp.accountCount ? `${cp.accountCount}${cp.more ? "+" : ""} account${cp.accountCount === 1 ? "" : "s"} posted the CA (last 7 days)` + (cp.accounts[0]?.followers ? ` · biggest @${cp.accounts[0].handle} (${Number(cp.accounts[0].followers).toLocaleString("en")})` : "") : "Nobody posted the CA on X (last 7 days)");
  const narrativeCard = nLines.length ? { title: "Narrative", lines: nLines, tone: "info" } : null;
  if (og?.sameImageOlder) flags.push({ tone: "warn", text: `Token image is the exact same file as ${og.sameImageOlder} older token${og.sameImageOlder === 1 ? "" : "s"} — copied art` });
  // Prufy's memory
  const VN = { proven: "Real", trust: "Trust me bro", busted: "Cap", no_evidence: "Vapor" };
  const mem = f.memory || {};
  const fmt = list => list.slice(0, 3).map(e => `${e.title} (${VN[e.verdict] || e.verdict}${e.score != null ? " " + e.score + "%" : ""})`).join(", ");
  const bad = list => (list || []).filter(e => e.verdict === "busted" || e.verdict === "no_evidence");
  const mLines = [];
  if (mem.dev) mLines.push(`Dev seen in ${mem.dev.length} earlier check${mem.dev.length === 1 ? "" : "s"}: ${fmt(mem.dev)}`);
  if (mem.funderAsDev) mLines.push(`The dev's funder was itself a dev PRUF checked: ${fmt(mem.funderAsDev)}`);
  if (mem.funder) mLines.push(`Same funder as: ${fmt(mem.funder)}`);
  if (mem.site) mLines.push(`Exact same site code as: ${fmt(mem.site)}`);
  if (mem.img) mLines.push(`Exact same image as: ${fmt(mem.img)}`);
  if (mem.fee) mLines.push(`Same fee wallet as: ${fmt(mem.fee)}`);
  const memBad = [...bad(mem.dev), ...bad(mem.funderAsDev), ...bad(mem.funder)];
  const memoryCard = mLines.length ? { title: "Prufy's memory", lines: mLines, tone: memBad.length ? "bad" : (mem.site || mem.img) ? "warn" : "good" } : null;
  if (memBad.length) flags.push({ tone: "bad", text: `PRUF has seen this dev before: ${fmt(memBad)}` });
  if (mem.site) flags.push({ tone: "warn", text: `Cloned site: exact same code as ${fmt(mem.site)}` });
  // No automatic "Not the OG" flag: whether OG matters depends on the narrative's core, which only the model judges.
  const blockCard = lb ? {
    title: "Launch block",
    lines: [
      lb.devPct ? `Dev bought ${pct(lb.devPct)} at creation` : "Dev didn't buy at creation",
      lb.wallets ? `${lb.wallets} other wallet${lb.wallets === 1 ? "" : "s"} bought ${pct(lb.otherPct || 0)} in the same block` : "No other wallet bought in the launch block",
      lb.stillHoldPct != null ? `Those wallets still hold ${pct(lb.stillHoldPct)}` : null,
    ].filter(Boolean),
    tone: lb.otherPct >= 10 ? (lb.stillHoldPct >= 5 ? "bad" : "warn") : "good",
  } : null;
  // Launching many coins isn't bad by itself — what matters is whether any of them ever ran.
  const oc = d?.otherCoins;
  if (oc?.count >= 5 && !oc.graduated && !(oc.best?.mc > 100000)) flags.push({ tone: "warn", text: `Dev launched ${oc.count} coins before and none took off` });
  return {
    launch, dev: devCard, fees: feesCard(f.fees), block: blockCard, narrative: narrativeCard, memory: memoryCard,
    builder: s.builder || null,
    stack: [...(s.libraries || []), ...(s.services || [])],
    signsTransactions: !!s.signsTransactions,
    codeKB: s.codeKB ?? null,
    programs, wallets, usesKnown, flags,
    backend: f.backend ? { level: f.backend.level, repo: f.backend.repo || null, commit: f.backend.deployedCommit || null, routes: f.backend.routesFoundInRepo || [] } : null,
    github: f.github ? { url: f.github.url, repo: f.github.repo, commits: f.github.commits, authors: f.github.authors?.length || 0, lastCommit: f.github.lastCommit, files: f.github.files, hasPrograms: f.github.hasSolanaPrograms, isFork: f.github.isFork } : null,
  };
}

// ---------- Claude ----------
function buildPrompt(f, limit = 45000){
  const evidence = {
    website_code: f.site ? { ...f.site, randomSnippets: f.site.randomSnippets } : "could not read website code",
    onchain_probes_of_addresses_found: f.probes,
    known_infrastructure_referenced: f.tech.usesKnown,
    github: f.github ? { ...f.github, readme: f.github.readme?.slice(0, 4000) } : "no GitHub found",
    token_market: f.market, token_mint: f.mint,
    token_metadata: f.meta ? { website: f.meta.website, twitter: f.meta.twitter, telegram: f.meta.telegram, created_on: f.meta.createdOn, update_authority: f.meta.updateAuthority, raw_metadata_json: f.meta.raw } : null,
    linked_accounts: f.meta?.links?.length ? f.meta.links : "none besides the ones above",
    launch_and_dev_wallet: f.launch || null, x_profile: f.x ? { ...f.x, pinned: undefined, recentPosts: f.x.recentPosts ? `${f.x.recentPosts.length} posts, text below` : undefined } : null, domain: f.domain,
    token_site_linkage: f.linkage || "only one of CA / website was given or found",
    offchain_backend_verification: f.backend || "site doesn't call a server of its own",
    market_context_platforms_detected: f.ecosystem?.length ? f.ecosystem : "none detected",
    creator_fees_onchain: f.fees || "not a pump.fun / PumpSwap token, or couldn't read it",
    narrative_checks: { og_or_copycat: f.og || "not checked", posts_the_coin_points_to: f.narrative?.sources?.length ? f.narrative.sources : "none found", did_named_accounts_mention_it: f.narrative?.mentions?.length ? f.narrative.mentions : "not checked", token_created: f.market?.createdAt && isFinite(f.market.createdAt) ? new Date(f.market.createdAt).toISOString() : f.launch?.createdAt || null },
    x_posts_with_this_ca: f.caPosts || "not searched",
    prufy_memory: f.memory || "nothing seen before (this dev, funder, site code, image and fee wallet are new to PRUF)",
    leads_followed: f.leads?.length ? f.leads.map(l => ({ why: l.why, tool: l.tool, arg: l.arg, result: l.ok ? l.data : l.short })) : "none",
    ca_on_github: f.ghMentions || "GitHub search for the CA unavailable",
    x_replies: f.replies ? { under_post: f.replies.on, read: f.replies.read, replies: f.replies.replies } : "not read",
    paired_with: f.market?.pairedWith?.length ? f.market.pairedWith : "SOL/USDC (a normal pair)",
    other_token_addresses_in_project_text: f.otherTokens?.length ? f.otherTokens : "none",
    pruf_triage: f.triage || "not run",
  };
  const pages = f.pages.map(p => `--- ${p.url} ---\n${p.text}`).join("\n\n");
  const system = `You are PRUF. Your one job: decide whether what a crypto project CLAIMS is real — its TECH (apps, agents, programs, buybacks, launchpads) AND its NARRATIVE (who/what it's about, "official", "the OG", "X tweeted it", "real-world thing behind it"). Not whether the token is a good investment or will pump. Whether the story checks out.

Mindset — you are an INVESTIGATOR, not a guesser. Degens trust PRUF because it digs and double-checks:
- Absence of a link is NOT absence of evidence. Before you mark anything "no_evidence" or "busted", go through EVERY piece of evidence below that could bear on it (code, on-chain data, GitHub search, fees, dev wallet, X posts and replies) and use it.
- Doubt your first impression. If the evidence points both ways, say so.
- If PRUF did not collect what's needed to really test a claim, say exactly what wasn't checked ("not checked: their API") instead of guessing, and don't call it busted.
- For every claim, fill "checked" with what PRUF actually looked at for it — concrete, so the reader sees the work.

Method:
1. From the project's own text (site, docs, metadata, its X posts), list ONLY the concrete tech it explicitly promises — never invent a promise it didn't make (e.g. don't judge "open source" unless they claim it) (a launchpad, a game, a bot, an AI agent, buybacks/burns, staking, a bridge, privacy, its own smart contract/program, an app, revenue sharing…). Ignore pure vibes and memes.
2. For each promise, look for EVIDENCE in what PRUF collected:
   - website_code: libraries, services, whether the site can sign transactions, addresses embedded in the code, Math.random() snippets near metrics (fake live numbers), leaked secrets, site builder.
   - onchain_probes: for each address found in the code/docs/GitHub — does it exist, is it a program, when deployed, is it actually used (recent tx count), can the team change it (upgrade authority), does a verified build match public source.
   - github: does the repo contain real code for the promised thing (programs/, contracts, bot code), how many commits/authors, is it a fork or template, does declare_id match a deployed program.
3. Classify each promise:
   "proven" = PRUF found direct evidence it exists and works (deployed program with real usage, code in the repo that does it, site code that actually calls it).
   "trust" = the feature's claimed inner workings can't be confirmed from outside (NOT just "it has a server" — see 5e) (AI agent logic, a backend that pays out).
   "busted" = evidence contradicts it (numbers generated by Math.random, program doesn't exist or has zero usage, repo is an empty template, claims 'audited/open source' but nothing public, claims automation but the wallet shows manual or no activity).
   "no_evidence" = promised but PRUF found nothing either way (no program address anywhere, no code, no integration in the site).
4. Be concrete: every "evidence" field must cite what PRUF found (e.g. "Program 7xK…aB deployed 3 days ago, 200+ txs, upgradeable by team", "Site code has no wallet transaction code", "Math.random() drives the 'live trades' counter").
5b. LAUNCHPADS: launch_and_dev_wallet tells you where the token was created (launchpad from the metadata's createdOn, programs in the creation tx) and who created it (dev wallet: SOL balance, % of supply held, recent tx types, where its SOL goes, fee/claim txs). Promises like "fees go to @someone", "creator rewards", "auto buybacks" are often a LAUNCHPAD feature, not the project's own tech: name the launchpad, and judge the promise by the evidence (fee/claim txs, SOL sent to the claimed recipient) — "proven" only if the money trail shows it, "trust" if it depends on the launchpad's backend, "busted" if the dev wallet shows the opposite (e.g. dev sells or sends fees elsewhere). Always mention a dev holding a big share of supply.
5c. MARKET CONTEXT — think like someone who lives in the trenches, not only like an auditor. market_context_platforms_detected lists known platforms/services this project touches, with what each one IS right now. Use it (and your own knowledge of the Solana meta) to tell the degen what is really going on, in plain words: whose tech it is, where the fees actually go, who controls the money, and what the named people really have to do with it. Example: a token "via Paid" with fees to a famous @account means a stranger launched it and that account just receives fees through UsePaid — not a team, not an endorsement. If the token's metadata X account is a fee beneficiary rather than the project's own account, say so and don't treat its profile as the team's. If the project names a platform you don't know and it's not in the list, say "unknown platform" instead of guessing.
5e. OFF-CHAIN BACKENDS: many products run on a server, not on-chain. offchain_backend_verification says how verifiable that server is:
   - level "open_and_deployed": the server code the site calls is in the public repo AND the live site points to a commit that exists in that repo. Promises implemented in that code are "proven" when the repo shows the code doing it (cite the file). Treat this as strong evidence, like a verified on-chain program.
   - level "open_source_unproven": code is public but nothing ties the live site to it → "trust", and say the source is public (a green flag).
   - level "closed" or no repo: server logic → "trust".
   Calls to an outside AI model or third-party API are still "trust" for what that model/API does; say so plainly.
   Do NOT flag "nothing on-chain" when the project never claims on-chain parts. Judge only what it promises.
   A SERVER IS NOT A RED FLAG. Almost every app runs on a server nobody can see (Telegram, Axiom, pump.fun itself). Never use "closed server", "private backend" or "runs on their servers" as a headline, a red flag or the main point of the summary by itself.
   - The app part: if the site code really calls their API, signs real txs, or the product visibly works, that feature EXISTS → "proven" ("app is live: site calls its own API"). Only the hidden part they brag about (e.g. "fully autonomous AI", "proprietary model", "99% win rate") is "trust".
   - It only MATTERS when money goes through the server: it holds user funds or keys, signs txs on users' behalf, decides payouts/rewards/fee distribution, or "the AI trades your money". Then say plainly that you're trusting the team with your money — that's a custody point (custody.keys / custody.funds) and can be a red flag.
   - Pure off-chain features (chat rooms, AI replies, dashboards, games without a prize pool) on a closed server = normal; don't penalize them.
5f. TOKEN ↔ PROJECT: if token_site_linkage.verified is false, say clearly (headline or first red flag) that nothing proves this token is the project's official token — copycat tickers are common. Judge the site's tech on its own, but never credit it to the token.
5g. If the project text includes "THE X POST BEING CHECKED", the user pasted that post: judge ITS claims first (first claims in the list) and say in the headline whether the post holds up.
5h. CREATOR FEES: creator_fees_onchain is read straight from the pump.fun bonding curve / PumpSwap pool account — it is the ground truth for where creator fees go RIGHT NOW. kind: "wallet" (one wallet; label "dev wallet" = the wallet that launched it), "split" (pump.fun fee sharing: shares[] with % each, devPct = dev's cut, locked = can never change again, not locked = admin can still change it once), "holders" (holder-rewards coin: pump.fun itself pays holders), "program" (a program-controlled account, e.g. another platform's vault). Compare it with every fee promise (fees to holders, buybacks, burns, a charity, an @account, a treasury, a game prize pool, "dev takes 0"): recipient matches the promise → proven up to that wallet (what the wallet does next is trust unless its activity shows it); fees land in the dev wallet while they promise something else → busted, unless they explain the dev manually forwards them (then trust); split with a big dev cut while they say "all fees to X" → busted. Use it for custody.fees ("Dev wallet", "Split: dev 40%", "Holders via pump.fun"…).
5i. X REPLIES: x_replies are what other people answered under the post. They are NOT evidence — they are leads. Look for concrete, repeated accusations (dev sold/rugged before, copied repo/site, fake partnership, product doesn't work, stolen art, bundled supply) and check each one against PRUF's evidence; if PRUF's data backs it, use it. If it's unverified but repeated by several accounts, mention it as "Replies say …, unverified". Ignore shills, bots, "gm", "LFG", price talk. team=true marks the project's own replies — note if the team dodges a direct question. Fill "crowd" with what the replies actually say.
5j. DEV BEHAVIOUR (launch_and_dev_wallet.dev and .launchBlock) — read it like a trencher:
   - dev.trades: bought / sold / moved (token amounts, from the dev's last ~100 txs). Dev taking some profit is normal; dev sold the whole bag = they're out, say it. "moved" = tokens sent to other wallets with plain transfers = supply parked in fresh wallets, a classic way to hide a big bag — red flag.
   - dev.funding: who sent the dev wallet its first SOL. From an exchange (label) = neutral, very common. From a wallet that launched coins itself (funderLaunched) = most likely the same person behind a new wallet; judge it with that wallet's track record. Never call an unlabeled funder bad by itself.
   - launchBlock: wallets that got the token in the creation block besides the dev = a bundle (the dev or friends sniping their own launch). >10% bundled and still held = dump risk, red flag. Bundle already sold = past, mention lightly. No other buyers = clean launch, green flag.
   These are about the coin, not the tech: put them in red/green flags and "plain", never as claims, unless the project promised something they contradict (e.g. "fair launch, no bundles", "dev won't sell", "team tokens locked").
5k. GITHUB / "OFFICIAL" LISTING CLAIMS: ca_on_github is PRUF's exact search for this CA across GitHub ("searched" says where: all public code, all issues & pull requests). For any claim like "in the Solana Foundation GitHub", "listed on <org>'s repo", "official token list", "backed by <org>": ALWAYS say in that claim's evidence what PRUF searched and what it found — never just "no link given". Then ask WHY the CA is in that file — read "path" and "context": a real fact can carry a fake meaning. Sample/example API responses (openapi/swagger specs, "example" blocks, price/pool data with "price_usd", "relationships", "launchpad_details"), test fixtures and scraped token dumps (looksLikeSampleData=true) mean the token just happened to be in some data — NOT a listing, NOT an endorsement. Then the claim is "busted" as stated, and say why (e.g. "True file, but it's sample data in CoinGecko's API spec inside a community API registry"). Only a deliberate entry (a curated list, a config, an announcement, a partner registry entry about this token) in an official org's repo (official=true) supports an "official" claim. A PR or issue opened by anyone (even in an official repo) is NOT an endorsement — anyone can open one; say who opened it and whether it was merged. Found nowhere → "busted" when they show it as proof.
5l. NARRATIVE CLAIMS — most coins have no tech, only a story. Verify the story with narrative_checks, like an investigator:
   - Implied claims count: a coin named after a person/brand/event implies "this is THE coin for it"; a metadata X link to someone's post implies "this post is the source". List those as claims (e.g. "The OG $X", "Based on @elonmusk's post", "Official coin of <brand>") and verify each.
   - FIND THE CORE FIRST: what is the one thing this narrative stands on? The NAME/meme itself (a person, brand, event, character, "the X coin") — or something else: this exact CA (e.g. "this CA is in the Solana GitHub"), a tech, a post, a real-world thing, a dev/team. Judge every check by whether it touches the core.
   - OG/copycat matters ONLY when the core is the name/meme. Then it can be the headline and a red flag. When the core is anything else, OG never matters: don't put it in the headline, summary, plain or red flags (at most one neutral mention). Never judge an OG's importance by its market cap — small old OGs can matter, the trenches decide that, not the number.
   - og_or_copycat: older tokens with the same name/ticker = this isn't the OG (when the name is the core); biggest.launched says if the biggest same-name coin came before or AFTER this one.
   - OG status is ONE point, never split into a red and a green flag that read like a contradiction. "OG, but a later copy grew bigger" is a single fact — say it in one place, in those words. A bigger LATER copy is not a red flag for the OG (at most neutral context: the market also picked another one). say how many, when the first one launched and how big it is. Being first = green flag. Never claim "OG" without this data.
   - posts_the_coin_points_to: does the source post exist, who wrote it, before or after the coin? A real post by the real account, before launch = the narrative's source is "proven" (it doesn't mean that person is involved).
   - did_named_accounts_mention_it: the named person/brand posting the CA/ticker themselves = real link ("proven"); never posting it = no link, any "official"/"backed by" claim is "busted" (window is the last 7 days — say so).
   - Pure meme with no claims at all: see 5r — verdict "meme".
5m. PRUF'S MEMORY (prufy_memory): earlier PRUF checks that share this dev wallet, the dev's funder, the exact site code, the exact token image or the fee wallet. funderAsDev = the wallet that funded this dev was itself a dev PRUF checked. Same dev/funder with earlier Cap/Vapor verdicts = strong red flag; with earlier Real verdicts = green flag. Same site code or same image as another project = cloned project — name it. Cite the earlier project's title and verdict.
5n. LEADS (leads_followed): PRUF just followed these leads to double-check unverified points. Use their results as evidence, and mention them in the "checked" field of the claims they settle. A lead that couldn't be checked stays unverified — don't guess its result.
5o. x_posts_with_this_ca: who posted the CA on X in the last 7 days (accounts, followers). Context only (KOL interest, coordinated shilling by many tiny accounts) — never proof of the tech or story.
5p. BORROWED IDENTITY — WHO IS THIS COIN ACTUALLY ABOUT, AND ARE THEY IN ON IT? Many coins are named after, or link to, a real person, AI character, creator, pet, brand, tweet or news story (see linked_accounts, token_metadata, posts_the_coin_points_to). Work it out like this:
   - Name the SUBJECT (who/what the coin is about) and, when relevant, who CREATED/OWNS the subject (e.g. "Janie B — AI influencer made by a16z partner Olivia Moore"). Use the coin's text, linked accounts and leads.
   - A real subject is NOT involvement. Linking someone's TikTok/X/YouTube only proves the account exists. Involvement needs: the subject or its owner posting the CA/ticker, claiming the fees, or the coin's metadata/X being theirs.
   - Watch for lookalike names: a16z (the VC firm) ≠ ai16z (the ElizaOS token); a brand ≠ a fan account; "@Name_agency"/"@NameCoin" ≠ "@Name".
   - Launchpad wrappers decide who is talking and who gets paid — check market_context_platforms_detected: on Agency the coin's X is written by an AI and fees go to that AI, not to the subject; on Paid/Bags fees go to a named handle that may never have agreed; on Believe the coin was spawned by a reply on X. Say it in plain words.
   - After-the-fact acknowledgement (subject later posts about it, like Truth Terminal with GOAT) = "acknowledged", not "official"/"launched by".
   - Pick ONE relation: "official" (subject/owner launched it or proves control), "acknowledged" (subject posted about it after launch, doesn't run it), "tribute" (fan/meme coin about a real subject, doesn't pretend to be official), "impersonation" (implies it's official/endorsed, or uses the subject's identity as if it were theirs, with no proof), "unverified" (can't tell yet). No subject at all → link.relation "none".
   - Verdict follows the relation: a tribute that doesn't claim to be official is NOT Cap — its claims are just "the subject is real" (proven) and "subject involved" (no_evidence/busted). Claiming or implying "official", "backed by", "made by <subject>" without proof = busted.
   - "story" must make a newcomer understand what's going on in one read: who launched what, on which platform, about whom, who runs it, and whether the subject is involved. Example: "Someone launched a coin on Agency named after Janie, the AI influencer made by a16z's Olivia Moore. An AI runs the coin and its X; no sign Olivia or a16z are involved."
5d. X POSTS: the project's latest posts and pinned post are included in the project's text (when available). Promises made there count. Note if the account is silent, only shills, or its posts contradict the site.
5. Common things that look like tech but aren't the project's own: using pump.fun / Meteora / Jupiter is real but it's someone else's tech; say so.
6. Do NOT pad the report with token-safety items (mint authority, holders, liquidity). Mention them only if a promise depends on them.
7. Never call a project a "scam". Report evidence.
8. Write about the PROJECT, never about PRUF's own plumbing. Never mention libraries, polyfills or third-party repos (react, core-js, wallet-adapter…) as if they mattered, never say "PRUF couldn't read X" in the headline/summary/plain, and never list a missing GitHub as a finding unless they claim to be open source. When something isn't published, say it as the project's gap ("No program address published"), not as a search failure. If the app clearly works (real wallet signing, real API calls, real on-chain txs), say so first and give it credit as a claim.

TRENCH CONTEXT — think like someone who lives in the Solana trenches:
- Day-1 projects are normal. NEVER red-flag age by itself — that includes "X account created hours before the token", "domain registered yesterday", "dev wallet 6 days old": that's how every launch looks (new domain, new X account, new repo, new token), low follower counts, few commits, a site built with Lovable/v0/Bolt, or building on pump.fun/Meteora/Raydium/Bags. Mention these only as neutral context.
- Red flags that actually cost people money: the site asks wallets to sign transactions for a program nobody can verify; the team can change a program that holds or moves user funds; the dev holds a big share of supply; the dev is a serial launcher whose coins all died; the token isn't provably the project's own (copycat); fake on-screen numbers; promised fees/buybacks/rewards with no wallet or program behind them; leaked keys.
- A dev who launched many coins is NOT bad by itself — judge the track record: earlier coins that graduated or ran hard (high peak market cap) are a strong green flag; many coins that never left the bonding curve mean the dev is exposed to the "launch and leave" pattern, mention it as a caution, not as proof of a scam.

5q. PAIRS (paired_with): a coin that trades against something other than SOL/USDC — a tokenized stock (NVDAx, SPYx…), a pre-IPO token (ANTHROPIC, OPENAI), PUMP, another meme — is making a narrative play: "the Nvidia coin", "the Anthropic coin". Say it in the story. The paired token's CA showing up on the site or X is the PAIR, not a second CA of this coin. other_token_addresses_in_project_text names every token address the project shows: NEVER say "two CAs", "pushes another CA" or similar unless an address there is a DIFFERENT token with this coin's own name/ticker. A paired coin is not affiliated with the company behind the stock.
5r. WHAT KIND OF COIN IS THIS — decide first, it changes everything:
   - "meme": no concrete tech promised (just a character, a joke, a person, an event, a vibe). There is NO tech to judge, so never call it Vapor/Cap for lacking tech. verdict = "meme". The report becomes a narrative read: the story (what it is, where the meme comes from, who it's about, which meta it rides — pairs, AI agents, -inu, tribute coins…), the origin (the viral post/news/thread — use leads_followed, especially search_web results), the link to the subject, and the coin facts that matter (OG or copy, dev bag and behaviour, fees route, bundles). claims: only implied story claims that can be checked ("The OG $X", "Fees go to the Reddit guy", "Official coin of Y"), 0–3 of them. Only use verdict "busted" for a meme when it LIES (poses as official/endorsed without proof, fake partner) — then the lie is the headline.
   - "meme_with_promises": a meme that also promises something concrete (buybacks, an AI agent running it, a game, airdrops from fees). verdict "meme" if the promises hold up or can't be checked yet and nothing contradicts them; use proven/trust/busted/no_evidence only when the promises are the main thing it sells. Judge each promise as a claim.
   - "tech": the project sells a product/protocol. Judge it like before (proven/trust/busted/no_evidence).
   - ORIGIN (search_web lead results): when PRUF found where the meme comes from, tell it concretely (who, where, when — "Reddit user spent $1,900 on Claude making a 3D dog; it came out a Doge–Pepe mix and went viral"). If the subject published a wallet/CA, compare it with creator_fees_onchain: fees going to that wallet = the subject is being paid (acknowledged at least); fees going elsewhere = this coin rides the story without paying the subject — say which. If several coins ride the same meme, say which one this is (the one paying the subject, the paired one, the copy).
   - "meta": name the trend it rides in max 10 words, only if you can name it from evidence or the market context.
   - MEME LARPS — a meme that lies is "busted" (Cap), and the lie is the headline. Check every one of these the coin claims or implies, with the evidence named:
     · "official / endorsed / backed by <someone>" → did they post the CA/ticker (did_named_accounts_mention_it, leads)? No → busted.
     · "<someone> tweeted/posted about it" → posts_the_coin_points_to: does the post exist, is it by that account, does it really say that, was it before launch?
     · "fees go to <person/charity/holders>" → creator_fees_onchain recipient must match.
     · "the OG" → og_or_copycat; "CTO / community takeover" → the dev really sold out (dev.trades) and the X/site changed hands; "LP burned / dev can't rug" → token_mint + pool facts.
     · Stolen identity: same image or site code as an older coin (prufy_memory, og_or_copycat.sameImage) presented as new.
     · Fake hype: x_posts_with_this_ca all from tiny accounts in a burst = coordinated shilling (mention, not proof).
     A meme that claims nothing just gets verdict "meme" — no larp, nothing to bust.

Scoring: PRUF computes the score from claim statuses — classify each claim honestly. Memes show no score.

WRITING STYLE — read by degens in 5-10 seconds, on a phone, mid-trade:
- Short, blunt, trench language (CA, dev, on-chain, rug, larp, cap, ser, bonding curve, graduated are all fine). No corporate words, no hedging.
- Lead with the punchline. Numbers and facts over adjectives ("0 txs in 3 days", not "very low activity").
- Every field has a hard word limit. Respect it. Cut, don't cram. Keep the whole report SHORT.

Deliver the report by calling the "report" tool exactly once. English only. Fields:
- kind: meme | meme_with_promises | tech (see 5r).
- verdict: meme | proven | trust | busted | no_evidence. proven = core tech exists and is used; trust = some real parts, core depends on their servers; busted = key promises or the story contradicted by evidence; no_evidence = tech promises with nothing behind them.
- headline: max 8 words, the punchline (memes: what it IS, e.g. "Reddit's $1.9k Claude dog, paired with Anthropic").
- story: max 40 words, plain English, no slang — what is ACTUALLY happening: what the coin is about and where that comes from, who launched it, where, what it trades against, who runs it, is the subject involved.
- origin: {what (max 14 words), where (site/platform), when (date or empty), url (or empty)} — only when PRUF found the source; otherwise omit.
- meta: max 10 words or empty.
- link: {subject (max 8 words or empty), relation: official|acknowledged|tribute|impersonation|unverified|none, proof (max 14 words)}.
- plain: bottom line, max 25 words, trench voice: what this really is today and the one thing that can burn you.
- claims: 0–4 items, most important first: {claim (max 6 words), status: proven|trust|busted|no_evidence, evidence (ONE sentence, max 16 words, cite the fact), checked (max 14 words: what PRUF looked at)}. Tech projects: 2–4 claims.
- custody: {keys, fees, funds} max 6 words each — tech projects or when money flows through someone; omit for plain memes.
- red_flags / green_flags: max 4 each, max 6 words each.
- crowd: max 18 words on what replies say, or empty.
- post: tweet under 240 chars, punchy degen voice, no hashtags/emojis, name the ticker if known.`;
  const user = `EVIDENCE COLLECTED BY PRUF:
${JSON.stringify(evidence).slice(0, limit)}

PROJECT'S OWN TEXT (site and docs):
${pages || "(no website or docs text could be read)"}`;
  return { system, user };
}

// The report comes back as a tool call, so it's always valid JSON (no more "malformed").
const REPORT_TOOL = { name: "report", description: "Deliver PRUF's report.", input_schema: { type: "object", properties: {
  kind: { type: "string", enum: ["meme", "meme_with_promises", "tech"] },
  verdict: { type: "string", enum: ["meme", "proven", "trust", "busted", "no_evidence"] },
  headline: { type: "string" }, story: { type: "string" },
  origin: { type: "object", properties: { what: { type: "string" }, where: { type: "string" }, when: { type: "string" }, url: { type: "string" } } },
  meta: { type: "string" },
  link: { type: "object", properties: { subject: { type: "string" }, relation: { type: "string", enum: ["official", "acknowledged", "tribute", "impersonation", "unverified", "none"] }, proof: { type: "string" } } },
  plain: { type: "string" },
  claims: { type: "array", maxItems: 4, items: { type: "object", properties: { claim: { type: "string" }, status: { type: "string", enum: ["proven", "trust", "busted", "no_evidence"] }, evidence: { type: "string" }, checked: { type: "string" } }, required: ["claim", "status", "evidence"] } },
  custody: { type: "object", properties: { keys: { type: "string" }, fees: { type: "string" }, funds: { type: "string" } } },
  red_flags: { type: "array", items: { type: "string" } }, green_flags: { type: "array", items: { type: "string" } },
  crowd: { type: "string" }, post: { type: "string" },
}, required: ["kind", "verdict", "headline", "story", "plain", "claims", "red_flags", "green_flags", "post"] } };

// The score is computed, not guessed: Real 100, Trust me bro 50 (can't be checked ≠ fake), Vapor 10, Cap 0.
// The first claims are the core promises, so they weigh a bit more.
const CLAIM_PTS = { proven: 100, trust: 50, no_evidence: 10, busted: 0 };
function scoreReport(r){
  if (r?.verdict === "meme") return { ...r, score: null };
  const cl = Array.isArray(r?.claims) ? r.claims.filter(c => c && c.status in CLAIM_PTS) : [];
  if (!cl.length) return r;
  let sum = 0, w = 0;
  cl.forEach((c, i) => { const k = 1 / (1 + 0.2 * i); sum += CLAIM_PTS[c.status] * k; w += k; });
  return { ...r, score: Math.round(sum / w) };
}

function parseJSON(text){
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) try { return JSON.parse(fence[1]); } catch {}
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) try { return JSON.parse(text.slice(a, b + 1)); } catch {}
  return null;
}

// Clean the key: Windows terminals and copy-paste can add quotes, spaces or invisible characters.
function claudeKey(){
  return String(process.env.ANTHROPIC_API_KEY || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim().replace(/^["']+|["']+$/g, "").trim();
}

// Busy (429 rate limit / 529 overloaded)? Don't fail: switch to the other model (separate limits) and wait in line
// while there's still time to answer. onWait(msg) tells the user why it's slower.
const BUSY = "Prufy is slammed right now — too many checks at once. Try again in a minute.";
// prompt: a string, or {system, user} — the system part (PRUF's fixed rules) is cached by Anthropic: faster + cheaper.
// opts.tool: force a tool call and return its input (always valid JSON). opts.tools: extra tools (web search).
async function askClaude(prompt, ms = 45000, model = MODEL, maxTokens = 2500, onWait = null, opts = {}){
  const end = Date.now() + ms;
  const sys = typeof prompt === "object" ? [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }] : undefined;
  const userText = typeof prompt === "object" ? prompt.user : prompt;
  let r, j, tries = 0, swapped = false;
  for (;;){
    const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: userText }] };
    if (sys) body.system = sys;
    if (opts.tool){ body.tools = [opts.tool]; body.tool_choice = { type: "tool", name: opts.tool.name }; }
    if (opts.tools) body.tools = opts.tools;
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: AbortSignal.timeout(Math.max(1000, end - Date.now())),
      headers: { "content-type": "application/json", "x-api-key": claudeKey(), "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    j = await r.json().catch(() => ({}));
    if (r.ok || ![429, 503, 529].includes(r.status) || !onWait) break;
    if (!swapped && model !== FAST_MODEL){ swapped = true; model = FAST_MODEL; onWait("Lots of checks right now — switching to the fast lane"); continue; }
    const wait = Math.min(Math.max(2000, Number(r.headers.get("retry-after")) * 1000 || 2500 + Math.random() * 3000), 8000);
    if (end - Date.now() - wait < 15000) throw new Error(BUSY);
    if (!tries++) onWait("Prufy is busy — you're in line");
    await new Promise(ok => setTimeout(ok, wait));
  }
  if (!r.ok){
    if ([429, 503, 529].includes(r.status)) throw new Error(BUSY);
    const k = claudeKey();
    const hint = r.status === 401 ? ` (server sees a key starting "${k.slice(0, 10)}…", ${k.length} characters)` : "";
    throw new Error("Claude API: " + (j.error?.message || r.status) + hint);
  }
  const u = j.usage || {};
  console.log(`[pruf] claude ${model} stop=${j.stop_reason} in=${u.input_tokens} cached=${u.cache_read_input_tokens || 0} out=${u.output_tokens}`);
  if (opts.tool){
    const call = (j.content || []).find(b => b.type === "tool_use" && b.name === opts.tool.name);
    if (call?.input && typeof call.input === "object") return call.input;
    console.log("[pruf] no tool call:", JSON.stringify(j.content || []).slice(0, 400));
    throw new Error("The analysis came back incomplete. Try again.");
  }
  const texts = (j.content || []).filter(b => b.type === "text").map(b => b.text);
  const text = texts.join("");
  // web search answers come in several text blocks (with citations): the JSON is usually in the last ones
  const out = parseJSON(text) || (texts.length > 1 ? parseJSON(texts.slice(-3).join("")) : null);
  if (!out){ console.log(`[pruf] malformed (stop=${j.stop_reason}):`, text.slice(-300)); throw new Error("The analysis came back malformed. Try again."); }
  return out;
}

// ---------- Prufy's memory: every check is indexed, so the next one can say "seen before" ----------
// Keys: m/dev/<wallet>, m/funder/<wallet>, m/site/<code hash>, m/img/<image CID>, m/fee/<fee wallet>.
function memoryKeys(f){
  const d = f.launch?.dev, fe = f.fees;
  return {
    dev: d?.address ? `m/dev/${d.address}` : null,
    funder: d?.funding?.from && !d.funding.label ? `m/funder/${d.funding.from}` : null,
    funderAsDev: d?.funding?.from && !d.funding.label ? `m/dev/${d.funding.from}` : null,
    site: f.site?.codeHash ? `m/site/${f.site.codeHash}` : null,
    img: f.og?.imageCid ? `m/img/${f.og.imageCid}` : null,
    fee: fe?.kind === "wallet" && fe.recipient && fe.label !== "dev wallet" ? `m/fee/${fe.recipient}` : null,
  };
}
async function memoryLookup(store, f, selfId){
  if (!store) return null;
  const keys = memoryKeys(f);
  const out = {};
  await Promise.allSettled(Object.entries(keys).filter(([, k]) => k).map(async ([name, k]) => {
    const list = ((await store.get(k, { type: "json" })) || []).filter(e => e.id !== selfId && (!f.ca || e.ca !== f.ca));
    if (list.length) out[name] = list.slice(0, 6);
  }));
  return Object.keys(out).length ? out : null;
}
async function memorySave(store, f, entry){
  if (!store) return;
  const keys = memoryKeys(f); delete keys.funderAsDev;
  await Promise.allSettled(Object.values(keys).filter(Boolean).map(async k => {
    const list = (await store.get(k, { type: "json" }).catch(() => null)) || [];
    await store.setJSON(k, [entry, ...list.filter(e => e.id !== entry.id)].slice(0, 20));
  }));
}

// ---------- leads: after collecting, PRUF picks what to double-check and follows it ----------
const LEAD_TOOLS = {
  open_url: "read a web page (docs, an article, a claimed partner's site, a livestream page) — arg: full https URL",
  read_x_post: "read one X post — arg: the post URL",
  search_x: "search X posts from the last 7 days — arg: an X search query, e.g. from:brand \"$TICKER\"",
  search_github: "search GitHub code + issues/PRs — arg: an exact string (a repo name, an address, a claimed library)",
  solana_account: "probe a Solana address on-chain (program? wallet? used?) — arg: the address",
  search_tokens: "search Solana tokens by name/ticker on DexScreener — arg: the name or ticker",
  search_web: "search the web (Reddit, news, X, TikTok, blogs) to find where a meme/name/story comes from or who a subject is — arg: a precise search query",
};
// Triage: one fast call that decides WHAT this is (meme / meme with promises / tech), what the story stands on,
// and which lookups are worth the time — so memes skip on-chain program probes and tech skips meme archaeology.
async function triage(f, model){
  const text = f.pages.map(p => `--- ${p.url} ---\n${p.text}`).join("\n").slice(0, 8000);
  const known = {
    token: { name: f.meta?.name || f.market?.name || null, symbol: f.meta?.symbol || f.market?.symbol || null, ca: f.ca || null, description: f.meta?.description?.slice(0, 400) || null },
    paired_with: f.market?.pairedWith?.length ? f.market.pairedWith.map(p => p.symbol + " (" + p.name + ")") : "SOL/USDC",
    platforms: (f.ecosystem || []).map(e => e.name), launchpad: f.launch?.launchpad?.name || null,
    linked_accounts: f.meta?.links || [], x_bio: f.x?.bio || null,
    tech: { flags: f.tech?.flags, github: f.tech?.github?.url || null, programs_in_code: (f.site?.solAddresses || []).length },
    og: f.og ? { older_same_name: f.og.olderCount ?? null } : null,
    ca_on_github: f.ghMentions ? { code: f.ghMentions.codeTotal ?? null, prs: f.ghMentions.prTotal ?? null } : null,
    replies: (f.replies?.replies || []).slice(0, 4).map(r => r.text),
  };
  const prompt = `You are PRUF's triage. PRUF checks whether a crypto coin's story and tech are real. Decide fast, from the facts below:
1. kind: "meme" (no concrete tech promised — a character, joke, person, event, vibe), "meme_with_promises" (a meme that also promises something concrete: buybacks, an AI agent running it, a game, airdrops), or "tech" (sells a product/protocol/app).
2. core: max 12 words — what the coin's story stands on (e.g. "Reddit post: guy spent $1.9k on Claude for a 3D dog", "Shiba as Neo, paired with NVDAx on StonkFun").
3. subject: who/what the coin is about (a person, character, brand, post), or "".
4. probes: true only if the project claims its OWN on-chain program/contract/mechanism that probing addresses could prove.
5. leads: up to 3 follow-up lookups that would most change the verdict. Don't redo what's known (CA GitHub search, OG search, linked posts, dev wallet, fees, replies).
   - search_web is NOT a ritual (it costs time). Use it ONLY when the coin is about something from OUTSIDE crypto that the facts don't explain — a viral moment, a news story, a real person/pet/creator, a post somewhere (Reddit, TikTok, YouTube, news) — and its own site/X/metadata/linked posts don't already say where it comes from. Never for the team's own original character, a classic meme archetype (Pepe, Doge, -inu…) or a tech project. Write a precise query about the THING, not the coin (e.g. "3D dog doge pepe claude $1900 viral").
   - MEME LARPS: if the coin's text claims something checkable — "official", "endorsed by", "X tweeted it", "fees go to <person>", "CTO", "the OG", "LP burned", "dev doxxed", a partnership — spend a lead on the strongest one.
   - BORROWED IDENTITY: if it's named after or links to a real person/creator/brand, a lead can check whether THEY posted this CA/ticker: search_x "from:<handle> (<CA> OR $<TICKER>)". Watch for lookalikes (a16z ≠ ai16z).
   - For tech: leads that test the main promise (a docs page, a claimed partner, an address).

Tools:
${Object.entries(LEAD_TOOLS).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

Reply with ONLY JSON: {"kind":"meme|meme_with_promises|tech","core":"…","subject":"…","probes":false,"leads":[{"why":"<max 10 words: what this settles>","tool":"<tool>","arg":"<argument>"}]}

FACTS:
${JSON.stringify(known).slice(0, 5000)}

PROJECT'S OWN TEXT (site, metadata, X posts):
${text || "(none)"}`;
  const j = await askClaude(prompt, 6500, model, 500);
  const kinds = ["meme", "meme_with_promises", "tech"];
  return {
    kind: kinds.includes(j?.kind) ? j.kind : null, core: String(j?.core || "").slice(0, 120), subject: String(j?.subject || "").slice(0, 80), probes: !!j?.probes,
    leads: (Array.isArray(j?.leads) ? j.leads : []).filter(l => l && LEAD_TOOLS[l.tool] && typeof l.arg === "string" && l.arg.length < 300).slice(0, 3),
  };
}

// Web research with Claude's own web search: where does this meme/name come from?
async function webResearch(query, f, ms){
  const coin = { name: f.meta?.name || f.market?.name, ticker: f.meta?.symbol || f.market?.symbol, description: f.meta?.description?.slice(0, 300), paired_with: (f.market?.pairedWith || []).map(p => p.symbol), subject: f.triage?.subject || undefined };
  const prompt = `Research the ORIGIN of a crypto meme coin's story on the web. Coin: ${JSON.stringify(coin)}. Start with this query: ${query}
Find: what the name/meme refers to, the original source (viral Reddit/X/TikTok post, news), who the subject/creator is, when, whether the subject publicly acknowledged a coin or posted a crypto wallet/CA, and whether several coins ride the same story. Use at most 2 searches. Be factual; if you find nothing solid, say so.
Reply with ONLY JSON: {"found":true,"refers_to":"<max 20 words>","origin":"<max 25 words: who posted what, where>","origin_url":"","origin_date":"","subject":"","subject_acknowledged_coin":"yes|no|unknown","subject_wallet_or_ca":"","other_coins":"<max 20 words or empty>","confidence":"low|medium|high"}`;
  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }];
  try { return await askClaude(prompt, ms, FAST_MODEL, 900, null, { tools }); }
  catch (e) {
    if (!/Claude API/.test(String(e?.message))) throw e;
    return await askClaude(prompt, Math.max(4000, ms - 2000), MODEL, 900, null, { tools }); // fast model without web search? try the main one
  }
}

async function runLead(l, f, ms = 7000){
  const H = { authorization: `Bearer ${xToken()}` };
  switch (l.tool){
    case "open_url": {
      const u = safeUrl(l.arg); if (!u) throw new Error("bad url");
      const t = await readPage(u);
      return { short: `read ${new URL(u).hostname} (${t.length.toLocaleString("en")} chars)`, data: t.slice(0, 3000) };
    }
    case "read_x_post": {
      const id = (l.arg.match(/status\/(\d+)/) || [])[1]; if (!id) throw new Error("no post id");
      const t = await readTweet(id); if (!t?.text) throw new Error("post not found");
      return { short: `post by @${t.handle}${t.at ? " on " + String(t.at).slice(0, 10) : ""}`, data: t };
    }
    case "search_x": {
      if (!xToken()) throw new Error("no X API");
      const j = await req(`https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(l.arg)}&max_results=10&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username,public_metrics`, { headers: H, ms: 7000 });
      const users = Object.fromEntries((j?.includes?.users || []).map(u => [u.id, u]));
      const posts = (j?.data || []).map(t => ({ by: users[t.author_id]?.username, followers: users[t.author_id]?.public_metrics?.followers_count, at: t.created_at, text: String(t.text).slice(0, 200) }));
      return { short: `${posts.length} post${posts.length === 1 ? "" : "s"} found (last 7 days)`, data: posts };
    }
    case "search_github": {
      const GH = { accept: "application/vnd.github+json" }; if (process.env.GITHUB_TOKEN) GH.authorization = "Bearer " + process.env.GITHUB_TOKEN;
      const q = encodeURIComponent(`"${l.arg}"`);
      const [c, i] = await Promise.allSettled([GH.authorization ? req(`https://api.github.com/search/code?q=${q}&per_page=5`, { headers: GH, ms: 7000 }) : Promise.reject(), req(`https://api.github.com/search/issues?q=${q}&per_page=5`, { headers: GH, ms: 7000 })]);
      const code = c.status === "fulfilled" ? (c.value.items || []).map(x => ({ repo: x.repository?.full_name, path: x.path })) : null;
      const iss = i.status === "fulfilled" ? (i.value.items || []).map(x => ({ title: x.title, url: x.html_url, state: x.state })) : null;
      return { short: `${code ? code.length + " code hits, " : ""}${iss ? iss.length + " issues/PRs" : ""}`, data: { code, issues: iss } };
    }
    case "solana_account": {
      if (!isSol(l.arg)) throw new Error("not a Solana address");
      const [p] = await probeSolana([l.arg]);
      return { short: `${p?.kind || "?"}${p?.txCount != null ? `, ${p.txCount} recent txs` : ""}`, data: p };
    }
    case "search_web": {
      const r = await webResearch(l.arg, f, ms);
      return { short: r?.found ? `found: ${String(r.origin || r.refers_to || "").slice(0, 70)}` : "nothing solid found", data: r };
    }
    case "search_tokens": {
      const j = await req(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(l.arg)}`, { ms: 6000 });
      const seen = {};
      (j.pairs || []).filter(p => p.chainId === "solana").forEach(p => { const m = p.baseToken?.address; if (m && !seen[m]) seen[m] = { symbol: p.baseToken.symbol, name: p.baseToken.name, mint: m, created: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString().slice(0, 10) : null, mc: p.marketCap ?? p.fdv ?? null }; });
      const list = Object.values(seen).slice(0, 6);
      return { short: `${list.length} token${list.length === 1 ? "" : "s"} found`, data: list };
    }
  }
  throw new Error("unknown tool");
}

// ---------- the run ----------
async function run(input, send, ctx = {}){
  const started = Date.now();
  const left = () => 52000 - (Date.now() - started); // Netlify stops functions at 60s
  const log = m => console.log(`[pruf] ${((Date.now() - started) / 1000).toFixed(1)}s ${m}`);
  // An X post link? Then that post's claims are what we check.
  let tweet = null;
  const tm = String(input.website || "").match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i);
  if (tm){ tweet = { id: tm[2], handle: tm[1] }; input = { ...input, website: "" }; }
  let ca0 = (input.ca || "").trim();
  let site = safeUrl(input.website);
  let handle = xHandle(input.x) || tweet?.handle || null;

  // Same thing checked in the last 6h? Serve the saved report (instant, costs nothing).
  const store = reportStore();
  const cacheKey = tweet ? `tweet:${tweet.id}` : ca0 || (site ? new URL(site).hostname.replace(/^www\./, "") : handle || "");
  const id = reportId(cacheKey);
  if (store && cacheKey && !input.fresh){
    try {
      const c = await store.get(`r/${id}`, { type: "json" });
      if (c && Date.now() - c.at < 6 * 3600e3){ send({ t: "facts", data: c.facts }); send({ t: "report", data: c.report }); send({ t: "saved", id, cached: true, at: c.at }); return; }
    } catch {}
  }

  // Someone else is checking this exact thing right now (launch rush: everyone pastes the same CA)?
  // Wait for their verdict instead of paying for the same check twice.
  const live = store && cacheKey ? liveStore() : null;
  if (live && !input.fresh){
    const lk = await live.get(`p/${id}`, { type: "json" }).catch(() => null);
    if (lk && Date.now() - lk.at < 70000){
      send({ t: "step", msg: "Someone is checking this right now — waiting for their verdict" });
      while (left() > 6000){
        await sleep(2500);
        const c = await live.get(`r/${id}`, { type: "json" }).catch(() => null);
        if (c && c.at >= lk.at - 5000){ send({ t: "facts", data: c.facts }); send({ t: "report", data: c.report }); send({ t: "saved", id, cached: true, at: c.at }); return; }
        if (!(await live.get(`p/${id}`, { type: "json" }).catch(() => null))) break; // their check failed
      }
      throw new Error("Couldn't finish this one — try again in a moment.");
    }
  }

  // Fair use: a few fresh checks per person per hour, so nobody burns the launch budget.
  if (!(process.env.OWNER_CODE && input.code === process.env.OWNER_CODE)){
    const limited = await rateCheck(live || store, ctx.ip);
    if (limited){ send({ t: "error", code: "rate", msg: limited }); return; }
  }
  if (live){
    await live.setJSON(`p/${id}`, { at: Date.now() }).catch(() => {});
    ctx.unlock = () => live.delete(`p/${id}`).catch(() => {});
  }

  let repliesP = null;
  if (tweet){
    send({ t: "step", msg: "Reading the X post" });
    try { Object.assign(tweet, await readTweet(tweet.id)); } catch {}
    repliesP = xReplies(tweet.conversationId || tweet.id, tweet.handle).then(r => r && { ...r, on: `x.com/${tweet.handle}/status/${tweet.id}` }).catch(e => { log("replies failed: " + (e?.message || e)); return null; });
    if (tweet.handle) handle = tweet.handle;
    if (!site && tweet.links?.length) site = safeUrl(tweet.links[0]);
    if (!ca0){ const m = String(tweet.text || "").match(/(?<![A-Za-z0-9])([1-9A-HJ-NP-Za-km-z]{32,44})(?![A-Za-z0-9])/); if (m && looksLikeKey(m[1])) ca0 = m[1]; }
  }
  if (ca0 && !isSol(ca0) && !isEvm(ca0)) throw new Error("That doesn't look like a Solana or EVM contract address.");
  if (!ca0 && !site && !handle) throw new Error("Paste a contract address, a website or an X post.");

  const f = { ca: null, chain: null, market: null, mint: null, x: null, github: null, domain: null, site: null, probes: [], docAddresses: [], pages: [], sources: [], misses: [] };

  async function loadToken(addr, quiet){
    const [dex, mint, meta] = await Promise.allSettled([dexscreener(addr), isSol(addr) ? solanaMint(addr) : Promise.resolve(null), isSol(addr) ? tokenMeta(addr) : Promise.resolve(null)]);
    const found = dex.status === "fulfilled" && dex.value;
    const m = meta.status === "fulfilled" ? meta.value : null;
    if (!found && !(m && m.from.length) && quiet) return false;
    f.ca = addr; f.chain = isEvm(addr) ? "evm" : "solana";
    if (found){
      f.market = dex.value; f.chain = dex.value.chainId;
      f.sources.push({ label: "DexScreener", url: dex.value.pairUrl });
      if (!site) site = safeUrl(dex.value.websites[0]);
      const dxTw = dex.value.socials.find(s => s.type === "twitter")?.url;
      if (!handle && !isPostLink(dxTw)) handle = xHandle(dxTw);
    } else f.misses.push("Token not found on DexScreener");
    if (mint.status === "fulfilled" && mint.value) f.mint = mint.value;
    if (m){
      f.meta = m;
      for (const u of [...(f.market?.socials || []).map(x => x.url), ...(f.market?.websites || [])]){
        const a = socialAccount(u); if (a && !m.links.some(l => l.url === a.url) && m.links.length < 10) m.links.push(a);
      }
      if (!site && m.website) site = m.website;
      if (!handle && m.twitter && !isPostLink(m.twitter)) handle = xHandle(m.twitter);
      if (m.metaFailed && !m.website && !m.twitter) f.misses.push("Couldn't read the token's metadata file (IPFS too slow) — it may list a site and X that PRUF didn't see");
      if (m.description) f.pages.push({ url: "token metadata (written by the creator at launch)", text: m.description.slice(0, 3000) });
      if (m.from.includes("pump.fun")) f.sources.push({ label: "pump.fun", url: `https://pump.fun/coin/${addr}` });
    }
    return true;
  }

  if (tweet?.text) f.pages.push({ url: `x.com/${tweet.handle}/status/${tweet.id}`, text: `THE X POST BEING CHECKED (${tweet.at || ""}):\n${tweet.text}` });
  if (ca0){ send({ t: "step", msg: "Pulling the CA" }); await loadToken(ca0); }
  // No site yet? Use the one on their X profile.
  if (!site && handle){ try { const xp = await xProfile(handle); if (xp?.website) site = safeUrl(xp.website); } catch {} }
  if (!site) f.misses.push("No website found");

  // Website: rendered text + raw code, in parallel.
  let links = [];
  if (site){
    send({ t: "step", msg: "Reading the site + its JS" });
    const [page, code, dom] = await Promise.allSettled([readPage(site), siteForensics(site), domainAge(site)]);
    if (page.status === "fulfilled"){
      f.pages.push({ url: site, text: page.value.slice(0, 20000) });
      f.sources.push({ label: new URL(site).hostname, url: site });
      links = findLinks(page.value);
    } else f.misses.push("Couldn't load the website");
    if (code.status === "fulfilled") f.site = code.value; else f.misses.push("Couldn't read the website code");
    if (dom.status === "fulfilled") f.domain = dom.value;
    if (!handle) handle = xHandle(links.find(l => /(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/?$/i.test(l)));

    if (!f.ca){
      const text = f.pages.filter(p => p.url === site || p.url.startsWith("x.com/")).map(p => p.text).join("\n");
      const cands = [...new Set([...text.matchAll(/(?<![A-Za-z0-9])(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})(?![A-Za-z0-9])/g)].map(m => m[1]))]
        .filter(c => !KNOWN[c] && (isEvm(c) || looksLikeKey(c)))
        .sort((a, b) => (/pump$|bonk$/.test(b) ? 1 : 0) - (/pump$|bonk$/.test(a) ? 1 : 0)).slice(0, 3);
      for (const c of cands){ try { if (await loadToken(c, true)) break; } catch {} }
      if (!f.ca) f.misses.push("No contract address found on the website");
    }

    // Up to two docs pages.
    const host = new URL(site).hostname.replace(/^www\./, "");
    const docLinks = links.filter(l => { try {
      const u = new URL(l); const h = u.hostname.replace(/^www\./, "");
      const docHost = /gitbook\.io|notion\.site|notion\.so|medium\.com|mirror\.xyz|^docs\./.test(h);
      const docPath = /doc|how-it-works|whitepaper|litepaper|faq|tokenomics|guide/i.test(u.pathname + h);
      return u.href.replace(/\/$/, "") !== site.replace(/\/$/, "") && (docHost || ((h === host || h.endsWith("." + host)) && docPath));
    } catch { return false; } }).slice(0, 2);
    if (docLinks.length && left() > 40000){
      send({ t: "step", msg: "Reading the docs" });
      const docs = await Promise.allSettled(docLinks.map(u => safeUrl(u) ? within(readPage(safeUrl(u)), 6000) : Promise.reject()));
      docs.forEach((d, i) => { if (d.status === "fulfilled"){ f.pages.push({ url: docLinks[i], text: d.value.slice(0, 12000) }); f.sources.push({ label: "Docs", url: docLinks[i] }); links.push(...findLinks(d.value)); } });
    }
  }

  // GitHub + X in parallel.
  send({ t: "step", msg: "Checking GitHub, X & dev wallet" });
  const [ghr, xr, ldr, fer, gmr, ogr, shr] = await Promise.allSettled([
    githubDeep([...(f.site?.deployedCommit?.repo ? [`https://github.com/${f.site.deployedCommit.repo}`] : []), ...(f.site?.githubLinks || []), ...links]),
    handle ? xProfile(handle) : Promise.resolve(null),
    f.ca && isSol(f.ca) ? launchAndDev(f.ca, f.meta, f.mint?.supply) : Promise.resolve(null),
    f.ca && isSol(f.ca) ? creatorFees(f.ca, f.market) : Promise.resolve(null),
    f.ca ? githubMentions(f.ca) : Promise.resolve(null),
    f.ca && f.chain !== "evm" ? ogCheck(f.ca, f.market?.name || f.meta?.name, f.market?.symbol || f.meta?.symbol, isFinite(f.market?.createdAt) ? f.market.createdAt : null, f.meta?.image) : Promise.resolve(null),
    f.ca ? xCaPosts(f.ca).catch(() => null) : Promise.resolve(null),
  ]);
  if (ogr.status === "fulfilled" && ogr.value) f.og = ogr.value;
  if (shr.status === "fulfilled" && shr.value) f.caPosts = shr.value;
  if (gmr.status === "fulfilled" && gmr.value) f.ghMentions = gmr.value;
  if (fer.status === "fulfilled" && fer.value) f.fees = fer.value;
  else if (fer.status === "rejected") log("fees read failed: " + (fer.reason?.message || fer.reason));
  if (ldr.status === "fulfilled" && ldr.value){
    f.launch = ldr.value;
    if (f.launch.dev?.address) f.sources.push({ label: "Dev wallet", url: `https://solscan.io/account/${f.launch.dev.address}` });
  }
  if (ghr.status === "fulfilled" && ghr.value){ f.github = ghr.value; f.sources.push({ label: "GitHub", url: ghr.value.url }); }
  try { f.backend = await verifyBackend(f.site, f.github); } catch {}
  if (f.backend?.deployedCommitInRepo) f.sources.push({ label: "Live commit", url: `https://github.com/${f.backend.repo}/commit/${f.site.deployedCommit.sha}` });
  if (xr.status === "fulfilled" && xr.value){ f.x = xr.value; f.sources.push({ label: "@" + xr.value.handle, url: `https://x.com/${xr.value.handle}` }); }
  else if (handle) f.misses.push(`Couldn't read @${handle} on X`);
  if (f.fees) labelFees(f.fees, f.launch?.dev?.address || f.meta?.creator);
  // Replies: under the checked post, or under the project's busiest recent post.
  if (!repliesP && f.x){
    const bp = busiestPost(f.x);
    if (bp) repliesP = xReplies(bp.id, f.x.handle).then(r => r && { ...r, on: `x.com/${f.x.handle}/status/${bp.id}` }).catch(e => { log("replies failed: " + (e?.message || e)); return null; });
  }

  // X posts are the project's own words too: feed them to the promise-matching.
  if (f.x?.pinned || f.x?.recentPosts?.length){
    const xs = [f.x.pinned && `PINNED (${f.x.pinned.at?.slice(0, 10)}): ${f.x.pinned.text}`, ...(f.x.recentPosts || []).map(p => `${p.at?.slice(0, 10)} · ${p.likes ?? 0} likes · ${p.views ?? "?"} views: ${p.text}`)].filter(Boolean).join("\n");
    f.pages.push({ url: `x.com/${f.x.handle} (latest posts)`, text: xs.slice(0, 6000) });
  }

  // From here everything runs side by side: the story's sources, Prufy's memory, triage → leads (+ web search),
  // and on-chain probes only when the coin claims on-chain tech. Memes skip the probes: faster, same answer.
  const narrP = (async () => {
    const srcTexts = [f.meta?.twitter, f.meta?.website, f.meta?.description, f.meta?.raw ? JSON.stringify(f.meta.raw) : "", ...f.pages.map(p => p.text)];
    try { f.narrative = { sources: await narrativeSources(srcTexts, tweet?.id) }; } catch { f.narrative = { sources: [] }; }
    const projectX = (f.x?.handle || "").toLowerCase();
    const named = [...new Set([...f.narrative.sources.map(s => s.by), isPostLink(f.meta?.twitter) ? null : xHandle(f.meta?.twitter)].filter(h => h && h.toLowerCase() !== projectX))].slice(0, 2);
    const sym = f.market?.symbol || f.meta?.symbol;
    const ms = await Promise.allSettled(named.map(h => within(xMentions(h, f.ca || "", sym), 8000)));
    f.narrative.mentions = ms.filter(m => m.status === "fulfilled" && m.value).map(m => m.value);
    if (f.narrative.sources.length) f.narrative.sources.forEach(s => f.sources.push({ label: "Post by @" + s.by, url: "https://" + s.url }));
  })();
  const memP = store ? memoryLookup(store, f, id).then(m => { f.memory = m; }).catch(() => {}) : null;

  // Market context: which known platforms/services this project touches.
  f.ecosystem = detectEcosystem(
    [...f.pages.map(p => p.text), f.meta?.raw ? JSON.stringify(f.meta.raw) : "", f.meta?.createdOn, f.x?.bio, f.launch?.launchpad?.host, f.meta?.website, ...(f.market?.websites || []), ...(f.market?.socials || []).map(x => x.url), ...f.pages.map(p => p.url)],
    [...(f.launch?.programsInLaunchTx || []).map(p => p.id), ...(f.launch?.dev?.topSolRecipients || []).map(r => r.to), f.launch?.dev?.address, ...(f.site?.solAddresses || [])]
  );

  // Every Solana address the project shows: name the tokens among them (a pair token is not "a second CA").
  const allText = f.pages.map(p => p.text).join("\n");
  f.docAddresses = [...new Set([...allText.matchAll(/(?<![A-Za-z0-9])([1-9A-HJ-NP-Za-km-z]{32,44})(?![A-Za-z0-9])/g)].map(m => m[1]).filter(looksLikeKey))];
  const namesP = f.chain === "evm" ? null : nameTokens([...f.docAddresses, ...(f.site?.solAddresses || [])].filter(a => a !== f.ca && !KNOWN[a]))
    .then(t => { f.otherTokens = t.map(x => ({ ...x, is_this_coins_pair: !!f.market?.pairedWith?.some(p => p.ca === x.ca) })); }).catch(() => {});

  // Triage: what is this, really?
  f.tech = techSummary(f);
  send({ t: "step", msg: "Figuring out what this is" });
  let tri = null;
  try { tri = await within(triage(f, FAST_MODEL), 7000); } catch (e) { log("triage skipped: " + (e?.message || e)); }
  if (tri){
    f.triage = { kind: tri.kind, core: tri.core, subject: tri.subject };
    if (tri.kind) send({ t: "step", msg: (tri.kind === "tech" ? "Tech project" : tri.kind === "meme" ? "It's a meme" : "Meme with promises") + (tri.core ? ": " + tri.core : "") });
  }

  // On-chain probes — only when it claims on-chain tech of its own.
  const launchProg = f.launch?.launchProgram && isSol(f.launch.launchProgram) ? [f.launch.launchProgram] : [];
  const toProbe = [...new Set([...launchProg, ...(f.github?.declaredProgramIds || []), ...(f.site?.solAddresses || []), ...f.docAddresses])]
    .filter(a => a !== f.ca && !KNOWN[a] && !(f.market?.pairedWith || []).some(p => p.ca === a)).slice(0, 12);
  let probeP = null;
  if (toProbe.length && f.chain !== "evm" && (!tri || tri.kind !== "meme" || tri.probes)){
    send({ t: "step", msg: `Probing ${toProbe.length} address${toProbe.length > 1 ? "es" : ""} on-chain` });
    probeP = within(probeSolana(toProbe), 12000).then(p => {
      f.probes = p;
      if (f.github?.declaredProgramIds?.length) f.github.declaredIdsOnChain = f.github.declaredProgramIds.map(id => ({ id, deployed: f.probes.find(x => x.address === id)?.kind === "program" }));
    }).catch(() => f.misses.push("Solana RPC didn't answer the probes"));
  }

  // Leads, web search included. The verdict keeps ~22s for itself.
  let leadsP = null;
  const leads = tri?.leads || [];
  if (leads.length && left() > 26000){
    leads.forEach(l => send({ t: "step", msg: (l.tool === "search_web" ? "Searching the web: " : "Lead: ") + l.why }));
    const cap = l => Math.max(3000, Math.min(l.tool === "search_web" ? 14000 : 7000, left() - 22000));
    leadsP = Promise.allSettled(leads.map(l => { const ms = cap(l); return Promise.race([runLead(l, f, ms), new Promise((_, r) => setTimeout(() => r(new Error("timed out")), ms))]); }))
      .then(res => {
        f.leads = leads.map((l, i) => res[i].status === "fulfilled" ? { ...l, ok: true, short: res[i].value.short, data: res[i].value.data } : { ...l, ok: false, short: "couldn't check: " + (res[i].reason?.message || "error") });
        log(`leads: ${f.leads.map(l => l.tool + (l.ok ? "✓" : "✗")).join(" ")}`);
      });
  }
  await Promise.allSettled([narrP, memP, namesP, probeP, leadsP]);

  // Does this token really belong to this site? (Copycat tokens are everywhere.)
  if (f.ca && site){
    const host = u => { try { return new URL(safeUrl(u)).hostname.replace(/^www\./, ""); } catch { return null; } };
    const siteHost = host(site);
    const tokenSites = [f.meta?.website, ...(f.market?.websites || [])].map(host).filter(Boolean);
    const seen = f.pages.map(p => p.text).join("\n") + " " + (f.site?.solAddresses || []).join(" ");
    f.linkage = { site: siteHost, tokenLinksTo: tokenSites[0] || null, tokenLinksToSite: tokenSites.includes(siteHost), siteShowsThisCA: seen.includes(f.ca) };
    f.linkage.verified = f.linkage.tokenLinksToSite || f.linkage.siteShowsThisCA;
  }
  if (repliesP){ f.replies = await repliesP; if (f.replies) f.sources.push({ label: "Replies", url: "https://" + f.replies.on }); }
  f.tech = techSummary(f);
  if (f.linkage && !f.linkage.verified) f.tech.flags.unshift({ tone: "bad", text: f.linkage.tokenLinksTo
    ? `This token links to ${f.linkage.tokenLinksTo}, not ${f.linkage.site} — it may not be this project's token`
    : `No proof this token belongs to ${f.linkage.site}: the site doesn't show this CA and the token doesn't link the site` });

  const factsData = {
    ca: f.ca, chain: f.chain,
    token: f.market ? { name: f.market.name, symbol: f.market.symbol, image: f.market.image } : null,
    website: site, x: f.x?.handle || handle, tech: f.tech, platforms: (f.ecosystem || []).map(e => e.name), basics: tokenBasics(f), sources: f.sources, misses: f.misses,
    tweet: tweet?.text ? { handle: tweet.handle, id: tweet.id, text: tweet.text.slice(0, 400) } : null,
    leads: (f.leads || []).map(l => ({ why: l.why, tool: l.tool, arg: l.arg, ok: l.ok, short: l.short })),
    kind: f.triage?.kind || null, pairedWith: f.market?.pairedWith || [],
    replies: f.replies ? { read: f.replies.read, kept: f.replies.replies.length, on: f.replies.on } : null,
    ghMentions: f.ghMentions ? { searched: f.ghMentions.searched, code: f.ghMentions.codeTotal ?? null, prs: f.ghMentions.prTotal ?? null,
      officialMerged: f.ghMentions.code.some(c => c.official && !c.looksLikeSampleData),
      officialSampleOnly: f.ghMentions.code.some(c => c.official) && !f.ghMentions.code.some(c => c.official && !c.looksLikeSampleData), top: [...f.ghMentions.code.slice(0, 2).map(c => ({ label: c.repo, url: c.url })), ...f.ghMentions.prs.slice(0, 2).map(p => ({ label: `${p.repo} ${p.isPR ? "PR" : "issue"} (${p.merged ? "merged" : p.state})`, url: p.url }))] } : null,
  };
  send({ t: "facts", data: factsData });

  if (!f.pages.length && !f.site && !f.market) throw new Error("Couldn't find anything to check. Try the website instead of the CA, or the other way round.");

  send({ t: "step", msg: "Writing the verdict" });
  if (left() < 10000) throw new Error("This project's sites were too slow to read. Try again in a moment.");
  const model = left() < 24000 ? FAST_MODEL : MODEL;
  log(`asking ${model}, ${Math.round(left() / 1000)}s left`);
  let report;
  try { report = scoreReport({ ...(await askClaude(buildPrompt(f, left() < 25000 ? 22000 : 40000), left() - 1000, model, 3000, msg => send({ t: "step", msg }), { tool: REPORT_TOOL })) }); send({ t: "report", data: report }); log("done"); }
  catch (e) { if (e?.name === "TimeoutError") throw new Error("The analysis ran out of time. Try again."); throw e; }

  // Save it: share link + "recently checked".
  if (store && cacheKey){
    try {
      const at = Date.now();
      await store.setJSON(`r/${id}`, { at, key: cacheKey, facts: factsData, report });
      const title = factsData.token ? `${factsData.token.name} ($${factsData.token.symbol})` : factsData.website ? new URL(factsData.website).hostname : tweet ? `@${tweet.handle} post` : cacheKey;
      const list = (await store.get("recent", { type: "json" }).catch(() => null)) || [];
      const entry = { id, at, title, image: factsData.token?.image || null, verdict: report.verdict, score: report.score, headline: report.headline };
      await store.setJSON("recent", [entry, ...list.filter(e => e.id !== id)].slice(0, 30));
      await memorySave(store, f, { id, ca: f.ca, title, verdict: report.verdict, score: report.score, at });
      send({ t: "saved", id });
    } catch (e) { log("save failed: " + (e?.message || e)); }
  }
}

export default async (request, context) => {
  if (request.method !== "POST") return new Response("Use POST", { status: 405 });
  let input;
  try { input = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
  const ctx = { ip: context?.ip || request.headers.get("x-nf-client-connection-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null };
  const stream = new ReadableStream({
    async start(controller){
      const enc = new TextEncoder();
      let open = true;
      const send = o => { if (open) try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch {} };
      // Keep the connection alive while slow steps run, so nothing in between closes it as idle.
      const beat = setInterval(() => send({ t: "ping" }), 4000);
      try {
        if (process.env.ACCESS_CODE && input.code !== process.env.ACCESS_CODE) send({ t: "error", code: "access", msg: "This beta needs an access code." });
        else if (!process.env.ANTHROPIC_API_KEY) send({ t: "error", msg: "The server is missing its ANTHROPIC_API_KEY. Add it in Netlify and redeploy." });
        else await run(input || {}, send, ctx);
      } catch (e) { console.log("[pruf] error", e?.message || e); send({ t: "error", msg: String(e?.message || e) }); }
      await ctx.unlock?.();
      clearInterval(beat); open = false;
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
};

export const config = { path: "/api/check" };
