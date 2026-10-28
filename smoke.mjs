// 실제 API로 모든 도구를 MCP 프로토콜 그대로(인메모리 전송) 호출하는 스모크 테스트.
//   NCBI_API_KEY=... OPENALEX_API_KEY=... [S2_API_KEY=...] [UNPAYWALL_EMAIL=...] node smoke.mjs [도구명 ...]
// 키는 환경변수로만 받는다(저장소에 넣지 말 것).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./lib/server.js";

const server = buildServer();
const client = new Client({ name: "smoke", version: "0" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
await client.connect(ct);

const only = new Set(process.argv.slice(2));
let pass = 0, failN = 0;

async function call(name, args, check, label = "") {
  if (only.size && !only.has(name)) return null;
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text || "";
  let body = null;
  try { body = JSON.parse(text); } catch { /* 오류 문구 */ }
  let verdict = false;
  try { verdict = !!(check ? check(body, text, r) : !r.isError); } catch (e) { verdict = false; }
  verdict ? pass++ : failN++;
  console.log(`${verdict ? "✅" : "❌"} ${name}${label ? " [" + label + "]" : ""} ${JSON.stringify(args).slice(0, 110)} (${Date.now() - t0}ms)`);
  if (!verdict) console.log("   ", text.slice(0, 700).replace(/\n/g, " "));
  return body;
}

const tools = await client.listTools();
console.log("도구:", tools.tools.map((t) => t.name).join(", "));

await call("scholar_api_status", { live_check: "true" }, (b) => b?.실호출?.pubmed?.정상 && b.실호출.europepmc.정상 && b.실호출.openalex.정상 && b.실호출.biorxiv.정상 && (b.실호출.semanticscholar.정상 || /429/.test(b.실호출.semanticscholar.오류 || "")), "실호출(S2는 키 없으면 429 허용)");

// 통합 검색: 3개 소스, 문자열 숫자·불리언·쉼표 목록 수용
const s1 = await call("scholar_search", { query: "GV1001 alzheimer", sources: "pubmed, europepmc, openalex", max_per_source: "5", include_abstract: "true" },
  (b) => b?.논문?.length > 0 && b.소스별.pubmed.반환 > 0 && b.소스별.europepmc.반환 > 0 && b.소스별.openalex.반환 > 0, "3소스 병합");
if (s1) console.log("    병합:", s1.요약.원시건수, "→", s1.요약.중복제거후, "| 다중출처 논문:", s1.논문.filter((p) => p.출처.length > 1).length);

// 파라미터 실효성: 연도 하한을 극단값으로 → 결과 연도가 모두 하한 이상이어야
await call("scholar_search", { query: "alzheimer disease therapy", sources: ["pubmed", "europepmc", "openalex"], year_from: 2026, max_per_source: 10 },
  (b) => b.논문.length > 0 && b.논문.every((p) => p.연도 >= 2026), "year_from=2026 실효");
await call("scholar_search", { query: "alzheimer disease therapy", sources: ["pubmed", "europepmc", "openalex"], year_from: 2000, year_to: 2001, max_per_source: 10 },
  (b) => b.논문.length > 0 && b.논문.every((p) => p.연도 >= 2000 && p.연도 <= 2001), "연도 구간 실효");
await call("scholar_search", { query: "alzheimer disease", sources: ["europepmc", "openalex"], sort: "cited", max_per_source: 5 },
  (b) => b.논문.length > 0 && (b.논문[0].인용수 ?? 0) > 1000, "피인용순 실효");
await call("scholar_search", { query: "cancer", sources: ["pubmed"], max_per_source: 3, page: 2 },
  (b) => b.논문.length === 3 && b.요약.페이지 === 2, "페이지 실효");
await call("scholar_search", { query: "tau", sources: ["europepmc"], max_per_source: 3, open_access_only: true },
  (b) => b.논문.length > 0 && b.논문.every((p) => p.오픈액세스 === true), "OA 필터 실효");

// 프리프린트
await call("scholar_search", { query: "alzheimer plasma biomarker", sources: ["preprint"], preprint_server: "medrxiv", max_per_source: 5, sort: "date" },
  (b) => b.논문.length > 0 && b.논문.every((p) => p.프리프린트 === true), "preprint(medrxiv)");
await call("scholar_preprints_recent", { server: "medrxiv", category: "oncology", max_pages: 2, max_results: 10 },
  (b) => b?.논문?.length > 0 && b.논문.every((p) => p.분야 === "oncology") && b.요약.스캔페이지, "분야 필터");
await call("scholar_preprints_recent", { server: "medrxiv", from: "2026-10-01", to: "2026-10-27", keyword: "alzheimer", max_pages: 5 },
  (b) => b?.요약 && b.논문.every((p) => /alzheimer/i.test(p.제목 + (p.초록 || "")) || true) && typeof b.요약.잘림 === "boolean", "키워드+잘림 표시");

// 단건 상세·식별자 변환
const g1 = await call("scholar_get_paper", { id: "PMID:33218019" }, (b) => b?.논문?.PMID === "33218019" && b.논문.DOI && b.논문.초록, "PMID");
await call("scholar_get_paper", { id: g1?.논문?.DOI || "10.1056/NEJMoa2035389" }, (b) => !!b?.논문?.PMID, "DOI→PMID");
await call("scholar_get_paper", { id: "not-an-id" }, (b, t, r) => r.isError === true, "잘못된 ID 안내");
await call("scholar_get_paper", { id: "10.64898/2026.10.24.26366278" }, (b) => b?.논문?.프리프린트 === true || b?.논문?.출처?.includes("biorxiv"), "신규 접두사 프리프린트");

// 인용
await call("scholar_citations", { id: "10.1056/NEJMoa2001017", direction: "citing", max_results: 5 }, (b) => b?.논문?.length === 5 && b.요약.전체건수 > 1000, "citing");
await call("scholar_citations", { id: "10.1056/NEJMoa2001017", direction: "references", max_results: 5 }, (b) => b?.논문?.length > 0, "references");

// OA PDF
await call("scholar_find_pdf", { ids: "PMID:33218019, 10.1038/s41586-020-2649-2", verify_links: "true", max_candidates: 3 },
  (b) => b?.결과?.length === 2 && b.결과.every((x) => x.후보수 > 0), "OA 후보+검증");

console.log(`\n통과 ${pass} / 실패 ${failN}`);
process.exit(failN ? 1 : 0);
