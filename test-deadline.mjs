// 소스 하나가 응답하지 않아도 scholar_get_paper·scholar_find_pdf가 시간 예산 안에 나머지 결과를 돌려주는지(네트워크 없이 fetch 흉내)
process.env.SCHOLAR_BUDGET_MS = "3000";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("eutils.ncbi")) return new Promise((_, rej) => opts.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))); // PubMed 무응답
  if (u.includes("ebi.ac.uk/europepmc")) return J({ resultList: { result: [] } });
  if (u.includes("api.openalex.org/works/")) return J({ id: "https://openalex.org/W9", doi: "https://doi.org/10.1056/nejmoa2212948", title: "Lecanemab in Early Alzheimer's Disease.", publication_year: 2023, ids: { openalex: "https://openalex.org/W9", pmid: "https://pubmed.ncbi.nlm.nih.gov/36449413" }, open_access: { is_oa: true }, best_oa_location: { pdf_url: "https://example.org/a.pdf", version: "publishedVersion" }, locations: [] });
  if (u.includes("api.unpaywall.org")) return new Promise(() => {}); // Unpaywall 무응답
  return new Response("not found", { status: 404 });
};
const { buildServer } = await import("./lib/server.js");
const server = buildServer(); const client = new Client({ name: "t", version: "0" });
const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
let t0 = Date.now();
let r = await client.callTool({ name: "scholar_get_paper", arguments: { id: "PMID:36449413" } });
let ms = Date.now() - t0; let b = JSON.parse(r.content[0].text);
ok(!r.isError && ms < 4500 && /openalex/.test(JSON.stringify(b.요약)) && /pubmed: .*시간 한도/.test((b.조회메모 || []).join(" ")), `get_paper ${ms}ms, 메모: ${(b.조회메모 || []).join(" / ").slice(0, 120)}`);
process.env.UNPAYWALL_EMAIL = "t@example.org";
t0 = Date.now();
r = await client.callTool({ name: "scholar_find_pdf", arguments: { ids: ["PMID:36449413"], max_candidates: 3 } });
ms = Date.now() - t0; b = JSON.parse(r.content[0].text);
const x = b.결과?.[0] || {};
ok(!r.isError && ms < 4500 && x.논문?.제목 && /unpaywall: .*시간 한도/.test((x.조회메모 || []).join(" ")), `find_pdf ${ms}ms, 후보 ${x.후보수}, 메모: ${(x.조회메모 || []).join(" / ").slice(0, 160)}`);
console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
