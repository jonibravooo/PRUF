// "Did Prufy get it right?" — votes + notes from the report page.
// POST /api/feedback {id, vote:"up"|"down", note?}  → saves it (no IP, no account, nothing personal).
// GET  /api/feedback?key=<FEEDBACK_KEY>             → readable list for the team (FEEDBACK_KEY is set in Netlify).
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export default async (request, context) => {
  let fb, reports;
  try { fb = getStore("feedback"); reports = getStore("reports"); } catch { return json({ error: "storage unavailable" }, 503); }

  if (request.method === "POST"){
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const id = String(b?.id || ""), vote = b?.vote, note = String(b?.note || "").replace(/\s+/g, " ").trim().slice(0, 600);
    if (!/^[0-9a-f]{10}$/.test(id) || !["up", "down"].includes(vote)) return json({ error: "bad input" }, 400);
    const rep = await reports.get(`r/${id}`, { type: "json" }).catch(() => null);
    if (!rep) return json({ error: "unknown check" }, 404);
    // one vote per person per check (a later vote/note replaces the earlier one)
    const ip = context?.ip || request.headers.get("x-nf-client-connection-ip") || "";
    const who = createHash("sha256").update(ip + "|" + (process.env.PRUF_SALT || "prufy")).digest("hex").slice(0, 12);
    await fb.setJSON(`f/${id}/${who}`, { at: Date.now(), id, vote, note, key: rep.key, verdict: rep.report?.verdict, score: rep.report?.score, headline: rep.report?.headline });
    return json({ ok: true });
  }

  // Team view
  const key = new URL(request.url).searchParams.get("key");
  if (!process.env.FEEDBACK_KEY || key !== process.env.FEEDBACK_KEY) return new Response("Not found", { status: 404 });
  const { blobs } = await fb.list({ prefix: "f/" });
  const items = (await Promise.all(blobs.slice(-500).map(b => fb.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean).sort((a, b) => b.at - a.at);
  const up = items.filter(i => i.vote === "up").length, down = items.length - up;
  const V = { proven: "Real", trust: "Trust me bro", busted: "Cap", no_evidence: "Vapor" };
  const rows = items.map(i => `<tr class="${i.vote}"><td>${i.vote === "up" ? "👍" : "👎"}</td><td><a href="/?r=${esc(i.id)}" target="_blank">${esc(i.key)}</a><br><small>${esc(V[i.verdict] || i.verdict)} ${esc(i.score)}% · ${esc(i.headline)}</small></td><td>${esc(i.note) || "<small>—</small>"}</td><td><small>${new Date(i.at).toISOString().slice(0, 16).replace("T", " ")}</small></td></tr>`).join("");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PRUF feedback</title>
<style>body{font:15px system-ui,sans-serif;background:#0b0c0c;color:#eef1ef;margin:0;padding:16px}h1{font-size:1.3rem}table{width:100%;border-collapse:collapse}td{border-top:1px solid #232726;padding:8px 6px;vertical-align:top;word-break:break-word}small{color:#9aa19d}a{color:#35d07f}tr.down td:first-child{background:#311715}tr.up td:first-child{background:#12291c}</style>
<h1>PRUF feedback · 👍 ${up} · 👎 ${down}</h1><p><small>Newest first. Click a check to open its report.</small></p><table>${rows || "<tr><td>No feedback yet.</td></tr>"}</table>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
};

export const config = { path: "/api/feedback" };
