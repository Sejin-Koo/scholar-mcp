// scholar-mcp 도구 정의
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  pubmedSearch,
  pubmedFetch,
  epmcSearch,
  epmcById,
  openalexSearch,
  openalexById,
  openalexRelated,
  s2Search,
  s2ById,
  s2Related,
  biorxivRange,
  biorxivByDoi,
  unpaywall,
  checkPdfLink,
} from "./sources.js";
import { zInt, zBool, zList, parseId, mergeRecords, clip, today, normDoi, SourceError } from "./util.js";

const env = (k) => (process.env[k] || "").trim();

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const fail = (msg) => ({ isError: true, content: [{ type: "text", text: String(msg) }] });

/** 내부용(_로 시작) 필드를 떼고 초록을 잘라 응답용으로 만든다 */
function slim(r, { abstract = true, chars = 500 } = {}) {
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    if (k.startsWith("_")) continue;
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
    o[k] = v;
  }
  if (!abstract) delete o.초록;
  else if (o.초록) o.초록 = clip(o.초록, chars);
  return o;
}

function errInfo(e) {
  if (e instanceof SourceError) {
    if (e.status === 429) return `요청 한도 초과(429)${e.retryAfter ? `, ${e.retryAfter}초 후 재시도` : ""} — 키가 없거나 한도에 걸림`;
    return e.message;
  }
  return String(e?.message || e);
}

function offsetHint(sources) {
  return sources.length ? undefined : "조회할 소스가 없습니다";
}

const SOURCE_ENUM = ["pubmed", "europepmc", "openalex", "semanticscholar", "preprint"];

async function resolvePaper(idRaw, { withS2 = false } = {}) {
  const id = parseId(idRaw);
  if (!id) throw new Error(`식별자를 해석할 수 없습니다: "${idRaw}" — PMID(숫자)·PMCID(PMC…)·DOI(10.…)·OpenAlex(W…)·Semantic Scholar(40자 해시) 중 하나를 넣으세요`);
  const found = [];
  const notes = [];
  let { doi, pmid, pmcid } = { doi: id.type === "doi" ? id.value : null, pmid: id.type === "pmid" ? id.value : null, pmcid: id.type === "pmcid" ? id.value : null };

  const safe = async (label, fn) => {
    try {
      const r = await fn();
      if (r) found.push(...[].concat(r));
      else notes.push(`${label}: 결과 없음`);
      return r;
    } catch (e) {
      notes.push(`${label}: ${errInfo(e)}`);
      return null;
    }
  };

  if (id.type === "openalex") {
    const r = await safe("openalex", () => openalexById({ openalex: id.value }));
    if (r) ({ DOI: doi, PMID: pmid, PMCID: pmcid } = { DOI: r.DOI, PMID: r.PMID, PMCID: r.PMCID });
  } else if (id.type === "s2") {
    const r = await safe("semanticscholar", () => s2ById(id.value));
    if (r) ({ DOI: doi, PMID: pmid, PMCID: pmcid } = { DOI: r.DOI, PMID: r.PMID, PMCID: r.PMCID });
  } else if (id.type === "arxiv") {
    doi = `10.48550/arxiv.${id.value}`;
  }

  // 핵심 3소스 병렬
  const tasks = [];
  tasks.push(safe("europepmc", () => epmcById({ pmid, pmcid, doi })));
  tasks.push(safe("openalex", () => openalexById({ doi, pmid, pmcid })));
  if (pmid) tasks.push(safe("pubmed", () => pubmedFetch([pmid])));
  await Promise.all(tasks);

  // 다른 소스에서 PMID를 새로 알게 되었으면 PubMed 보강
  if (!pmid) {
    const p = found.find((r) => r.PMID)?.PMID;
    if (p) {
      pmid = p;
      await safe("pubmed", () => pubmedFetch([pmid]));
    }
  }
  if (!doi) doi = found.find((r) => r.DOI)?.DOI || null;
  if (!pmcid) pmcid = found.find((r) => r.PMCID)?.PMCID || null;

  // 프리프린트 접두사(10.1101=bioRxiv/medRxiv 구접두사, 10.64898=신접두사)면 bioRxiv API로 버전·게재본 확인
  if (doi && /^10\.(1101|64898)\//.test(doi)) await safe("biorxiv", () => biorxivByDoi(doi));
  if (withS2 && (doi || pmid)) await safe("semanticscholar", () => s2ById(doi ? `DOI:${doi}` : `PMID:${pmid}`));

  return { id, doi, pmid, pmcid, records: found, notes };
}

export function buildServer() {
  const server = new McpServer({ name: "scholar-mcp", version: "1.0.0" });

  // ───────────────────────── 통합 검색 ─────────────────────────
  server.registerTool(
    "scholar_search",
    {
      title: "논문 통합 검색",
      description:
        "PubMed·Europe PMC·OpenAlex·Semantic Scholar·프리프린트(bioRxiv/medRxiv 등, Europe PMC 경유)를 한 번에 검색해 DOI 기준으로 중복을 합쳐 돌려줍니다. " +
        "소스별 건수·전체 히트 수·오류를 함께 보고하므로(한 소스가 실패해도 나머지는 반환) '○○ 소스는 실패' 같은 사실을 그대로 전달하세요. " +
        "검색식: 키워드·\"구문\"·AND/OR/NOT(대문자)는 모든 소스에서 통한다. PubMed 필드태그([tiab], [Title/Abstract], [MeSH Terms], [pt] 등)는 PubMed에서만 해석된다. " +
        "초록은 기본 500자까지만 반환합니다(전문은 scholar_get_paper). 인용수는 Europe PMC·OpenAlex·Semantic Scholar가 서로 다르게 셀 수 있어 병합 시 최댓값을 씁니다. " +
        "※ Semantic Scholar는 API 키가 없으면 공용 한도 때문에 429가 자주 나며, 이때 소스별 보고에 그 사실이 표시됩니다.",
      inputSchema: {
        query: z.string().min(1).describe("검색어(영문 권장). 예: \"GV1001\" AND (alzheimer OR \"hTERT peptide\")"),
        sources: zList(z.enum(SOURCE_ENUM)).describe("검색할 소스 목록(쉼표 문자열 가능). 기본: pubmed, europepmc, openalex. preprint는 bioRxiv·medRxiv 등 프리프린트"),
        max_per_source: zInt(1, 50, 10).describe("소스당 최대 건수(1~50). 기본 10"),
        year_from: zInt(1800, 2100).describe("발행연도 하한(포함)"),
        year_to: zInt(1800, 2100).describe("발행연도 상한(포함)"),
        sort: z.enum(["relevance", "date", "cited"]).optional().describe("relevance(기본)|date(최신순)|cited(피인용순). Semantic Scholar는 항상 관련도순"),
        open_access_only: zBool(false).describe("true면 전문 무료 공개 논문만(Europe PMC·OpenAlex·Semantic Scholar에 적용; PubMed는 적용 안 됨)"),
        preprint_server: z.enum(["all", "biorxiv", "medrxiv"]).optional().describe("preprint 소스에서 서버 한정. 기본 all"),
        include_abstract: zBool(true).describe("초록 포함 여부. 기본 true"),
        abstract_chars: zInt(0, 5000, 500).describe("초록 최대 글자 수. 기본 500"),
        pubmed_query: z.string().optional().describe("PubMed에만 다른 검색식을 쓰고 싶을 때(필드태그 등)"),
        page: zInt(1, 100, 1).describe("2페이지 이상이 필요할 때(소스별 max_per_source 단위). 기본 1"),
      },
    },
    async (a) => {
      const sources = a.sources?.length ? [...new Set(a.sources)] : ["pubmed", "europepmc", "openalex"];
      const max = a.max_per_source;
      const page = a.page;
      const offset = (page - 1) * max;
      const common = { max, yearFrom: a.year_from, yearTo: a.year_to };
      const sort = a.sort || "relevance";
      const jobs = {
        pubmed: () => pubmedSearch({ query: a.pubmed_query || a.query, ...common, sort, offset }),
        europepmc: () => epmcSearch({ query: a.query, ...common, sort, openAccessOnly: a.open_access_only, offset }),
        openalex: () => openalexSearch({ query: a.query, ...common, sort, page, openAccessOnly: a.open_access_only }),
        semanticscholar: () => s2Search({ query: a.query, ...common, offset, openAccessOnly: a.open_access_only }),
        preprint: () => epmcSearch({ query: a.query, ...common, sort, preprint: true, server: a.preprint_server === "all" ? undefined : a.preprint_server, openAccessOnly: a.open_access_only, offset }),
      };
      const t0 = Date.now();
      const settled = await Promise.allSettled(sources.map((s) => jobs[s]()));
      const report = {};
      const lists = [];
      settled.forEach((r, i) => {
        const s = sources[i];
        if (r.status === "fulfilled") {
          report[s] = { 반환: r.value.records.length, 전체히트: r.value.total, ...(r.value.변환된검색식 ? { 변환된검색식: r.value.변환된검색식 } : {}) };
          lists.push(r.value.records);
        } else {
          report[s] = { 반환: 0, 오류: errInfo(r.reason) };
        }
      });
      const merged = mergeRecords(lists);
      const rawCount = lists.flat().length;
      if (!lists.length) return fail(`모든 소스가 실패했습니다: ${JSON.stringify(report)}`);
      return ok({
        요약: {
          검색어: a.query,
          소스: sources,
          페이지: page,
          원시건수: rawCount,
          중복제거후: merged.length,
          소요ms: Date.now() - t0,
          안내: "전체히트는 소스별 전체 일치 건수이며 반환 건수는 max_per_source로 제한됩니다. 더 보려면 page를 올리거나 연도·정렬로 좁히세요.",
        },
        소스별: report,
        논문: merged.map((r) => slim(r, { abstract: a.include_abstract, chars: a.abstract_chars })),
      });
    }
  );

  // ───────────────────────── 단건 상세 ─────────────────────────
  server.registerTool(
    "scholar_get_paper",
    {
      title: "논문 상세(초록 전문·식별자 통합)",
      description:
        "PMID·PMCID·DOI·OpenAlex ID(W…)·Semantic Scholar ID 중 하나로 PubMed·Europe PMC·OpenAlex(+bioRxiv/medRxiv, 선택적으로 Semantic Scholar)를 조회해 한 건으로 합칩니다. 초록은 전문을 돌려줍니다. " +
        "DOI·PMID·PMCID 상호 변환과 게재본(프리프린트→정식 논문) DOI 확인에도 씁니다.",
      inputSchema: {
        id: z.string().min(1).describe("PMID(예 37234567 또는 PMID:37234567)·PMCID(PMC…)·DOI(10.…)·OpenAlex W…·Semantic Scholar 40자 해시"),
        include_s2: zBool(false).describe("Semantic Scholar도 조회(TL;DR·영향력 인용수). 키가 없으면 429 가능. 기본 false"),
      },
    },
    async (a) => {
      let r;
      try {
        r = await resolvePaper(a.id, { withS2: a.include_s2 });
      } catch (e) {
        return fail(e.message);
      }
      if (!r.records.length) return fail(`어느 소스에서도 찾지 못했습니다: ${a.id}. 조회 기록: ${r.notes.join(" / ")}`);
      const merged = mergeRecords([r.records]);
      const main = merged[0];
      return ok({
        요약: { 입력: a.id, 판정: r.id.type, 조회소스: main.출처, 병합레코드수: merged.length },
        논문: slim(main, { abstract: true, chars: 0 }),
        ...(merged.length > 1 ? { 참고_병합되지않은_레코드: merged.slice(1).map((x) => slim(x, { abstract: false })) } : {}),
        ...(r.notes.length ? { 조회메모: r.notes } : {}),
      });
    }
  );

  // ───────────────────────── 프리프린트 최신/기간 목록 ─────────────────────────
  server.registerTool(
    "scholar_preprints_recent",
    {
      title: "bioRxiv/medRxiv 기간별 프리프린트",
      description:
        "bioRxiv·medRxiv 공식 API로 기간(기본 최근 7일)·분야별 신규 프리프린트를 가져옵니다. 이 API에는 서버 측 키워드 검색이 없어, 기간·분야로 좁힌 뒤 제목·초록에서 keyword(공백=AND)를 서버가 걸러냅니다. " +
        "한 호출 30건이라 max_pages(기본 10=300건)까지만 훑고, 그보다 많으면 '잘림'으로 표시합니다. 키워드 중심 검색은 scholar_search(sources=preprint)가 더 정확합니다.",
      inputSchema: {
        server: z.enum(["medrxiv", "biorxiv"]).optional().describe("기본 medrxiv"),
        from: z.string().optional().describe("시작일 YYYY-MM-DD. 기본: 7일 전"),
        to: z.string().optional().describe("종료일 YYYY-MM-DD. 기본: 오늘"),
        category: z.string().optional().describe("분야(예: oncology, neurology, pharmacology_and_toxicology, neuroscience). 영문 소문자·밑줄"),
        keyword: z.string().optional().describe("제목·초록에서 거를 키워드(공백 구분 AND, 대소문자 무시)"),
        max_results: zInt(1, 100, 30).describe("반환 최대 건수. 기본 30"),
        max_pages: zInt(1, 40, 10).describe("훑을 최대 페이지 수(1페이지=30건). 기본 10"),
        include_abstract: zBool(false).describe("초록 포함. 기본 false(길어서)"),
      },
    },
    async (a) => {
      const to = a.to || today();
      const from = a.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return fail("from/to는 YYYY-MM-DD 형식이어야 합니다");
      try {
        const r = await biorxivRange({ server: a.server || "medrxiv", from, to, category: a.category, maxPages: a.max_pages });
        let recs = r.records;
        let kwNote;
        if (a.keyword) {
          const words = a.keyword.toLowerCase().split(/\s+/).filter(Boolean);
          recs = recs.filter((x) => {
            const hay = `${x.제목} ${x.초록 || ""}`.toLowerCase();
            return words.every((w) => hay.includes(w));
          });
          kwNote = `스캔한 ${r.records.length}건(버전 중복 제거 후) 중 키워드 일치 ${recs.length}건`;
        }
        recs.sort((x, y) => String(y.발행일).localeCompare(String(x.발행일)));
        const out = recs.slice(0, a.max_results);
        return ok({
          요약: {
            서버: a.server || "medrxiv",
            기간: `${from} ~ ${to}`,
            분야: a.category || "전체",
            API전체건수: r.total,
            스캔페이지: `${r.스캔페이지수}/${r.전체페이지수}`,
            잘림: r.잘림,
            ...(r.잘림 ? { 잘림안내: "기간 내 건수가 max_pages×30건을 넘어 일부만 훑었습니다. 기간을 줄이거나 category·max_pages를 조정하세요." } : {}),
            ...(kwNote ? { 키워드필터: kwNote } : {}),
            반환: out.length,
          },
          논문: out.map((x) => slim(x, { abstract: a.include_abstract, chars: 400 })),
        });
      } catch (e) {
        return fail(`bioRxiv API 오류: ${errInfo(e)}`);
      }
    }
  );

  // ───────────────────────── 인용/참고문헌 ─────────────────────────
  server.registerTool(
    "scholar_citations",
    {
      title: "인용·참고문헌 네트워크",
      description:
        "한 논문을 인용한 논문(citing) 또는 그 논문이 인용한 참고문헌(references)을 가져옵니다. 기본 소스는 OpenAlex(키 사용, 안정적). Semantic Scholar도 선택할 수 있으나 키가 없으면 429가 잦습니다. " +
        "OpenAlex의 참고문헌 목록은 OpenAlex가 해석한 범위까지만이라 원문 참고문헌 수와 다를 수 있습니다.",
      inputSchema: {
        id: z.string().min(1).describe("PMID·PMCID·DOI·OpenAlex W…·Semantic Scholar ID"),
        direction: z.enum(["citing", "references"]).optional().describe("citing=이 논문을 인용한 논문(기본), references=이 논문의 참고문헌"),
        source: z.enum(["openalex", "semanticscholar"]).optional().describe("기본 openalex"),
        max_results: zInt(1, 100, 20).describe("최대 건수. 기본 20"),
        sort: z.enum(["cited", "date"]).optional().describe("openalex 한정. cited=피인용순(기본), date=최신순"),
        page: zInt(1, 100, 1).describe("페이지(max_results 단위). 기본 1"),
      },
    },
    async (a) => {
      const direction = a.direction || "citing";
      const source = a.source || "openalex";
      const id = parseId(a.id);
      if (!id) return fail(`식별자를 해석할 수 없습니다: "${a.id}"`);
      try {
        if (source === "openalex") {
          let wid = id.type === "openalex" ? id.value : null;
          let base = null;
          if (!wid) {
            base = await openalexById({ doi: id.type === "doi" ? id.value : null, pmid: id.type === "pmid" ? id.value : null, pmcid: id.type === "pmcid" ? id.value : null });
            wid = base?.출처별ID?.openalex;
          }
          if (!wid) return fail(`OpenAlex에서 기준 논문을 찾지 못했습니다: ${a.id}`);
          const r = await openalexRelated({ workId: wid, direction, max: a.max_results, sort: a.sort, page: a.page });
          return ok({
            요약: { 기준논문: base ? slim(base, { abstract: false }) : { OpenAlexID: wid }, 방향: direction, 소스: "openalex", 전체건수: r.total, 반환: r.records.length, 페이지: a.page },
            논문: r.records.map((x) => slim(x, { abstract: false })),
          });
        }
        const idStr = id.type === "doi" ? `DOI:${id.value}` : id.type === "pmid" ? `PMID:${id.value}` : id.type === "pmcid" ? `PMCID:${id.value}` : id.type === "s2" ? id.value : null;
        if (!idStr) return fail("Semantic Scholar 조회는 DOI·PMID·PMCID·S2 ID만 지원합니다");
        const r = await s2Related({ idStr, direction, max: a.max_results, offset: (a.page - 1) * a.max_results });
        return ok({ 요약: { 방향: direction, 소스: "semanticscholar", 반환: r.records.length, 다음오프셋: r.next ?? null, 페이지: a.page }, 논문: r.records.map((x) => slim(x, { abstract: false })) });
      } catch (e) {
        return fail(`${source} 오류: ${errInfo(e)}`);
      }
    }
  );

  // ───────────────────────── OA PDF 링크 ─────────────────────────
  server.registerTool(
    "scholar_find_pdf",
    {
      title: "무료 전문(OA PDF) 링크 찾기",
      description:
        "논문의 합법적 무료 공개 전문 링크를 Unpaywall·OpenAlex·Europe PMC(PMC)·Semantic Scholar·bioRxiv/medRxiv에서 모아 우선순위(출판본 > 수락본 > 제출본, PDF > 랜딩)로 정렬해 돌려줍니다. " +
        "파일을 내려받지는 않고 링크만 반환합니다(1단계). verify_links=true면 상위 PDF 후보에 실제로 요청해 PDF가 맞는지(상태코드·%PDF 시그니처) 확인합니다. " +
        "무료 공개본이 없으면 '없음'으로 답하며 유료 논문을 우회해 받는 경로는 제공하지 않습니다. UNPAYWALL_EMAIL이 설정되지 않으면 Unpaywall은 건너뜁니다.",
      inputSchema: {
        ids: zList(z.string()).describe("PMID·PMCID·DOI 목록(쉼표 구분 문자열 가능), 최대 10개"),
        verify_links: zBool(false).describe("상위 PDF 후보를 실제 요청해 검증(느려짐). 기본 false"),
        max_candidates: zInt(1, 10, 5).describe("논문당 반환할 후보 수. 기본 5"),
      },
    },
    async (a) => {
      const ids = (a.ids || []).slice(0, 10);
      if (!ids.length) return fail("ids가 비어 있습니다");
      const rank = (c) => {
        const v = { publishedVersion: 0, acceptedVersion: 1, submittedVersion: 2 }[c.버전] ?? 1.5;
        return (c.종류 === "pdf" ? 0 : 10) + v + (c.출처 === "unpaywall" ? -0.2 : 0);
      };
      const results = await Promise.all(
        ids.map(async (raw) => {
          try {
            const r = await resolvePaper(raw);
            if (!r.records.length) return { 입력: raw, 오류: `논문을 찾지 못했습니다 (${r.notes.join(" / ")})` };
            const main = mergeRecords([r.records])[0];
            const cands = [];
            for (const rec of r.records) for (const l of rec._links || []) cands.push(l);
            // Unpaywall
            let upw = null;
            if (r.doi) {
              try {
                upw = await unpaywall(r.doi);
                for (const l of upw.위치 || []) cands.push(l);
              } catch (e) {
                r.notes.push(`unpaywall: ${errInfo(e)}`);
              }
            }
            // PMC 직접 링크(PMCID가 있으면 항상 무료)
            if (r.pmcid) {
              cands.push({ 출처: "pmc", 종류: "landing", url: `https://pmc.ncbi.nlm.nih.gov/articles/${r.pmcid}/`, 접근: "Open access" });
              cands.push({ 출처: "pmc", 종류: "pdf", url: `https://pmc.ncbi.nlm.nih.gov/articles/${r.pmcid}/pdf/`, 접근: "Open access" });
            }
            const seen = new Set();
            let uniq = cands
              .filter((c) => c.url && !seen.has(c.url) && seen.add(c.url))
              .sort((x, y) => rank(x) - rank(y))
              .slice(0, a.max_candidates);
            if (a.verify_links) {
              uniq = await Promise.all(uniq.map(async (c) => (c.종류 === "pdf" ? { ...c, 검증: await checkPdfLink(c.url) } : c)));
            }
            return {
              입력: raw,
              논문: slim(main, { abstract: false }),
              오픈액세스판정: { unpaywall: upw?.설정안됨 ? "UNPAYWALL_EMAIL 미설정으로 건너뜀" : upw ? { is_oa: upw.is_oa, oa_status: upw.oa_status } : undefined, openalex: main.오픈액세스 },
              후보수: uniq.length,
              후보: uniq,
              ...(uniq.length ? {} : { 결론: "확인된 무료 공개 전문이 없습니다(구독·유료 논문일 수 있음). 기관 구독, 저자 요청, 또는 게재본의 프리프린트 여부를 확인하세요." }),
              ...(r.notes.length ? { 조회메모: r.notes } : {}),
            };
          } catch (e) {
            return { 입력: raw, 오류: errInfo(e) };
          }
        })
      );
      return ok({
        요약: {
          요청: ids.length,
          후보있음: results.filter((r) => r.후보수 > 0).length,
          ...(a.verify_links
            ? { 검증해석: "PDF시그니처=true면 실제 PDF가 확인된 것입니다. false(403·html 등)는 서버가 자동 요청을 막는 경우가 많아 '링크 불량'을 뜻하지 않으며, 브라우저에서는 열릴 수 있습니다." }
            : {}),
        },
        결과: results,
      });
    }
  );

  // ───────────────────────── 상태 ─────────────────────────
  server.registerTool(
    "scholar_api_status",
    {
      title: "서버·키 설정 상태",
      description: "각 소스의 API 키/이메일 설정 여부(값은 노출하지 않음)와 한도 요약을 보여 줍니다. live_check=true면 소스마다 가벼운 호출로 실제 응답을 확인합니다.",
      inputSchema: { live_check: zBool(false).describe("소스별 실제 호출 확인. 기본 false") },
    },
    async (a) => {
      const cfg = {
        NCBI_API_KEY: { 설정됨: !!env("NCBI_API_KEY"), 효과: "PubMed 초당 3→10회" },
        OPENALEX_API_KEY: { 설정됨: !!env("OPENALEX_API_KEY"), 효과: "일일 예산 10배, 초당 30회" },
        S2_API_KEY: { 설정됨: !!env("S2_API_KEY"), 효과: "Semantic Scholar 전용 한도(없으면 공용 풀 429 잦음)" },
        UNPAYWALL_EMAIL: { 설정됨: !!env("UNPAYWALL_EMAIL"), 효과: "Unpaywall 사용 필수 조건(없으면 건너뜀)" },
        MCP_GATE_MODE: { 값: env("MCP_GATE_MODE") || "observe" },
      };
      const out = { 키설정: cfg };
      if (a.live_check) {
        const probe = async (label, fn) => {
          const t0 = Date.now();
          try {
            const r = await fn();
            return [label, { 정상: true, ms: Date.now() - t0, 전체히트: r.total }];
          } catch (e) {
            return [label, { 정상: false, ms: Date.now() - t0, 오류: errInfo(e) }];
          }
        };
        const res = await Promise.all([
          probe("pubmed", () => pubmedSearch({ query: "aspirin", max: 1 })),
          probe("europepmc", () => epmcSearch({ query: "aspirin", max: 1 })),
          probe("openalex", () => openalexSearch({ query: "aspirin", max: 1 })),
          probe("semanticscholar", () => s2Search({ query: "aspirin", max: 1 })),
          // Unpaywall: 이메일 미설정이면 호출하지 않고 '설정 안 됨'으로 표시, 설정돼 있으면 실제 DOI 1건으로 확인
          (async () => {
            if (!env("UNPAYWALL_EMAIL")) return ["unpaywall", { 정상: false, 오류: "UNPAYWALL_EMAIL 미설정(건너뜀)" }];
            return probe("unpaywall", async () => {
              const r = await unpaywall("10.1038/nature12373");
              if (r?.설정안됨) throw new Error("UNPAYWALL_EMAIL 미설정");
              if (typeof r?.is_oa !== "boolean" && r?.is_oa !== null) throw new Error("예상 밖 응답");
              return { total: undefined };
            });
          })(),
          probe("biorxiv", () => biorxivRange({ server: "medrxiv", from: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10), to: today(), maxPages: 1 }).then((r) => ({ total: r.total }))),
        ]);
        out.실호출 = Object.fromEntries(res);
      }
      return ok(out);
    }
  );

  return server;
}
