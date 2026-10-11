// Saved PRUF reports: GET /api/reports → recently checked list; GET /api/reports?id=… → one saved report.
import { getStore } from "@netlify/blobs";

export default async (request) => {
  const id = new URL(request.url).searchParams.get("id");
  const json = (o, s = 200, cache = "public, max-age=30") => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": cache } });
  try {
    const store = getStore("reports");
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
