// Runs on every Netlify build from GitHub. Writes the public commit the site is built from into
// version.json and the footer, so anyone (and PRUF itself) can check the live site runs that exact code.
import fs from "node:fs";
const sha = (process.env.COMMIT_REF || "").trim();
const m = (process.env.REPOSITORY_URL || "").trim().match(/github\.com[\/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
if (!/^[0-9a-f]{7,40}$/i.test(sha) || !m){ console.log("stamp: no Git info, skipping"); process.exit(0); }
const repo = `https://github.com/${m[1]}/${m[2]}`;
fs.writeFileSync("version.json", JSON.stringify({ repo, commit: sha, builtAt: new Date().toISOString() }, null, 2));
const html = fs.readFileSync("index.html", "utf8").replaceAll("__REPO__", repo).replaceAll("__COMMIT__", sha).replaceAll("__SHORT__", sha.slice(0, 7));
fs.writeFileSync("index.html", html);
console.log(`stamp: ${repo} @ ${sha.slice(0, 7)}`);
