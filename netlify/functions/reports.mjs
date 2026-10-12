// Saved PRUF reports: GET /api/reports → recently checked list; GET /api/reports?id=… → one saved report.
// Team only (FEEDBACK_KEY): /api/reports?key=…&remove=<id> drops one entry from "recently checked"; &clear=1 empties it.
import { getStore } from "@netlify/blobs";

export default async (request) => {
  const q = new URL(request.url).searchParams;
  const id = q.get("id");
  const json = (o, s = 200, cache = "public, max-age=30") => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": cache } });
  try {
    const store = getStore("reports");
    if (q.get("key")){
      if (!process.env.FEEDBACK_KEY || q.get("key") !== process.env.FEEDBACK_KEY) return new Response("Not found", { status: 404 });
      const list = (await store.get("recent", { type: "json" })) || [];
      const next = q.get("clear") === "1" ? [] : q.get("remove") ? list.filter(e => e.id !== q.get("remove")) : list;
      if (next.length !== list.length) await store.setJSON("recent", next);
      return json({ ok: true, removed: list.length - next.length, recent: next.map(e => ({ id: e.id, title: e.title, verdict: e.verdict })) }, 200, "no-store");
    }
    if (id){
      if (!/^[0-9a-f]{10}$/.test(id)) return json({ error: "bad id" }, 400);
      const r = await store.get(`r/${id}`, { type: "json" });
      return r ? json({ id, at: r.at, facts: r.facts, report: r.report }, 200, "public, max-age=300") : json({ error: "not found" }, 404);
    }
    return json({ recent: (await store.get("recent", { type: "json" })) || [] });
  } catch (e) {
    return json({ error: "storage unavailable" }, 503, "no-store");
  }
};

export const config = { path: "/api/reports" };
