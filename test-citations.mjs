// scholar_citations 방향 별칭·S2 429 대체를 네트워크 없이 확인(fetch 흉내)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./lib/server.js";
const seen = [];
globalThis.fetch = async (url) => {
  const u = String(url); seen.push(u);
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
  if (u.includes("semanticscholar")) return new Response("Too Many Requests", { status: 429 });
  if (u.includes("/works/doi")) return J({ id: "https://openalex.org/W1", title: "기준", ids: { openalex: "https://openalex.org/W1" } });
  if (u.includes("/works?")) return J({ meta: { count: 2 }, results: [{ id: "https://openalex.org/W2", title: "A" }, { id: "https://openalex.org/W3", title: "B" }] });
  return new Response("not found", { status: 404 });
};
const server = buildServer(); const client = new Client({ name: "t", version: "0" });
const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const call = async (args) => { const r = await client.callTool({ name: "scholar_citations", arguments: args }); const t = r.content?.[0]?.text || ""; let b = null; try { b = JSON.parse(t); } catch {} return { r, t, b }; };
let x = await call({ id: "10.1056/NEJMoa2001017", direction: "cited_by", max_results: 5 });
ok(!x.r.isError && x.b?.요약?.방향 === "citing" && seen.some((u) => u.includes("cites%3AW1") || u.includes("cites:W1")), "cited_by → citing");
x = await call({ id: "10.1056/NEJMoa2001017", direction: "refs" });
ok(!x.r.isError && x.b?.요약?.방향 === "references", "refs → references");
x = await call({ id: "10.1056/NEJMoa2001017", direction: "sideways" });
ok(x.r.isError, "모르는 값은 그대로 거절");
x = await call({ id: "10.1056/NEJMoa2001017", direction: "citing", source: "semanticscholar", max_results: 100 });
ok(!x.r.isError && x.b?.요약?.소스 === "openalex" && /429/.test(x.b?.요약?.대체 || ""), "S2 429 → OpenAlex 대체: " + (x.b?.요약?.대체 || x.t.slice(0, 120)));
console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
