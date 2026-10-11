// Runs on every Netlify build from GitHub. Writes the public commit the site is built from into
// version.json and the footer, so anyone (and PRUF itself) can check the live site runs that exact code.
// It also writes the official $PRUF contract address from the PRUF_CA env var (set it in Netlify, then redeploy).
import fs from "node:fs";
let html = fs.readFileSync("index.html", "utf8");
const ca = (process.env.PRUF_CA || "").trim();
if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)){ html = html.replaceAll("__CA__", ca); console.log(`stamp: CA ${ca}`); }
else console.log("stamp: no PRUF_CA set, CA bar stays hidden");
const sha = (process.env.COMMIT_REF || "").trim();
const m = (process.env.REPOSITORY_URL || "").trim().match(/github\.com[\/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
if (/^[0-9a-f]{7,40}$/i.test(sha) && m){
  const repo = `https://github.com/${m[1]}/${m[2]}`;
  fs.writeFileSync("version.json", JSON.stringify({ repo, commit: sha, builtAt: new Date().toISOString(), ...(ca ? { ca } : {}) }, null, 2));
  html = html.replaceAll("__REPO__", repo).replaceAll("__COMMIT__", sha).replaceAll("__SHORT__", sha.slice(0, 7));
  console.log(`stamp: ${repo} @ ${sha.slice(0, 7)}`);
} else console.log("stamp: no Git info, skipping commit stamp");
fs.writeFileSync("index.html", html);
