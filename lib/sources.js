// 소스별 클라이언트. 모든 검색 함수는 표준 레코드 배열을 돌려준다.
//
// 표준 레코드: { 제목, 저자[], 저자수, 저널, 발행일, 연도, DOI, PMID, PMCID, 초록, 인용수,
//               오픈액세스, PDF링크, 유형[], 링크, 출처[], 출처별ID{} }
import { XMLParser } from "fast-xml-parser";
import { httpJson, httpText, qs, normDoi, stripTags, yearOf, SourceError } from "./util.js";

const env = (k) => (process.env[k] || "").trim();

// ───────────────────────── PubMed (NCBI E-utilities) ─────────────────────────
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  stopNodes: ["*.ArticleTitle", "*.AbstractText", "*.VernacularTitle"],
  isArray: (name) => ["PubmedArticle", "Author", "AbstractText", "ArticleId", "PublicationType", "MeshHeading"].includes(name),
  processEntities: true,
});

const tx = (n) => (n == null ? "" : typeof n === "object" ? stripTags(n["#text"] ?? "") : stripTags(String(n)));

function ncbiParams() {
  const p = {};
  if (env("NCBI_API_KEY")) p.api_key = env("NCBI_API_KEY");
  return p;
}

function parsePubmedArticle(pa) {
  const mc = pa.MedlineCitation || {};
  const art = mc.Article || {};
  const pmid = tx(mc.PMID);
  const ids = pa.PubmedData?.ArticleIdList?.ArticleId || [];
  const idOf = (t) => {
    const f = ids.find((x) => x["@_IdType"] === t);
    return f ? tx(f) : null;
  };
  const abs = (art.Abstract?.AbstractText || [])
    .map((a) => {
      const label = typeof a === "object" ? a["@_Label"] : null;
      const t = tx(a);
      return label ? `${label}: ${t}` : t;
    })
    .filter(Boolean)
    .join(" ");
  const authors = (art.AuthorList?.Author || []).map((a) => (a.CollectiveName ? tx(a.CollectiveName) : [tx(a.LastName), tx(a.Initials)].filter(Boolean).join(" "))).filter(Boolean);
  const pd = art.Journal?.JournalIssue?.PubDate || {};
  const artDate = Array.isArray(art.ArticleDate) ? art.ArticleDate[0] : art.ArticleDate;
  const pubDate = pd.Year ? [pd.Year, pd.Month, pd.Day].filter(Boolean).join("-") : tx(pd.MedlineDate);
  const year = Number(pd.Year) || yearOf(pd.MedlineDate) || (artDate ? Number(artDate.Year) : null);
  const doi = normDoi(idOf("doi") || ((Array.isArray(art.ELocationID) ? art.ELocationID : art.ELocationID ? [art.ELocationID] : []).find((e) => e["@_EIdType"] === "doi") || {})["#text"]);
  const pmc = idOf("pmc");
  return {
    제목: tx(art.ArticleTitle),
    저자: authors.slice(0, 10),
    저자수: authors.length,
    저널: tx(art.Journal?.Title),
    발행일: pubDate || null,
    연도: year,
    DOI: doi,
    PMID: pmid,
    PMCID: pmc,
    초록: abs || null,
    인용수: null,
    오픈액세스: pmc ? true : null,
    PDF링크: null,
    유형: (art.PublicationTypeList?.PublicationType || []).map(tx),
    링크: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    출처: ["pubmed"],
    출처별ID: { pubmed: pmid },
  };
}

export async function pubmedFetch(pmids) {
  if (!pmids.length) return [];
  const url = `${EUTILS}/efetch.fcgi?` + qs({ db: "pubmed", id: pmids.join(","), retmode: "xml", ...ncbiParams() });
  const t = await httpText(url, { timeoutMs: 25000 });
  const doc = xml.parse(t);
  const arts = doc?.PubmedArticleSet?.PubmedArticle || [];
  const recs = arts.map(parsePubmedArticle);
  // 요청한 PMID 순서(=검색 순위)를 유지
  const idx = new Map(pmids.map((p, i) => [String(p), i]));
  return recs.sort((a, b) => (idx.get(a.PMID) ?? 1e9) - (idx.get(b.PMID) ?? 1e9));
}

export async function pubmedSearch({ query, max = 10, yearFrom, yearTo, sort = "relevance", offset = 0 }) {
  const p = { db: "pubmed", term: query, retmax: Math.min(max, 100), retstart: offset, retmode: "json", sort: sort === "date" ? "pub_date" : "relevance", ...ncbiParams() };
  if (yearFrom || yearTo) {
    p.datetype = "pdat";
    p.mindate = String(yearFrom || 1800);
    p.maxdate = String(yearTo || 3000);
  }
  const j = await httpJson(`${EUTILS}/esearch.fcgi?` + qs(p));
  const r = j.esearchresult || {};
  if (r.ERROR) throw new SourceError(`PubMed 검색 오류: ${r.ERROR}`);
  const ids = r.idlist || [];
  const records = await pubmedFetch(ids);
  return { records, total: Number(r.count) || 0, 변환된검색식: r.querytranslation };
}

// ───────────────────────── Europe PMC ─────────────────────────
const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";

function parseEpmc(r) {
  const authors = r.authorList?.author?.map((a) => a.fullName || a.collectiveName).filter(Boolean) || (r.authorString ? r.authorString.replace(/\.$/, "").split(/,\s*/) : []);
  const urls = r.fullTextUrlList?.fullTextUrl || [];
  const pdf = urls.find((u) => u.documentStyle === "pdf" && u.availability !== "Subscription required");
  const isPpr = r.source === "PPR";
  return {
    제목: stripTags(r.title),
    저자: authors.slice(0, 10),
    저자수: authors.length,
    저널: r.journalInfo?.journal?.title || (isPpr ? r.bookOrReportDetails?.publisher || "Preprint" : null),
    발행일: r.firstPublicationDate || r.journalInfo?.printPublicationDate || null,
    연도: Number(r.pubYear) || null,
    DOI: normDoi(r.doi),
    PMID: r.pmid || (r.source === "MED" ? r.id : null),
    PMCID: r.pmcid || null,
    초록: r.abstractText ? stripTags(r.abstractText) : null,
    인용수: r.citedByCount ?? null,
    오픈액세스: r.isOpenAccess ? r.isOpenAccess === "Y" : null,
    PDF링크: pdf?.url || null,
    유형: [].concat(r.pubTypeList?.pubType || []),
    링크: `https://europepmc.org/article/${r.source}/${r.id}`,
    출처: [isPpr ? "preprint" : "europepmc"],
    출처별ID: { europepmc: `${r.source}:${r.id}` },
    프리프린트: isPpr || undefined,
    _links: [
      ...urls
        .filter((u) => u.availability !== "Subscription required")
        .map((u) => ({ 출처: "europepmc", 종류: u.documentStyle === "pdf" ? "pdf" : "landing", url: u.url, 접근: u.availability, 사이트: u.site })),
      ...(r.pmcid ? [{ 출처: "europepmc", 종류: "pdf", url: `https://europepmc.org/backend/ptpmcrender.fcgi?accid=${r.pmcid}&blobtype=pdf`, 접근: "Open access", 사이트: "Europe PMC render" }] : []),
    ],
  };
}

export async function epmcSearch({ query, max = 10, yearFrom, yearTo, sort = "relevance", preprint = false, server, openAccessOnly = false, offset = 0 }) {
  let q = `(${query})`;
  if (yearFrom || yearTo) q += ` AND (PUB_YEAR:[${yearFrom || 1800} TO ${yearTo || 3000}])`;
  if (preprint) {
    q += " AND SRC:PPR";
    if (server === "biorxiv") q += ' AND PUBLISHER:"bioRxiv"';
    else if (server === "medrxiv") q += ' AND PUBLISHER:"medRxiv"';
  } else {
    q += " AND NOT SRC:PPR";
  }
  if (openAccessOnly) q += " AND OPEN_ACCESS:y";
  const p = { query: q, format: "json", resultType: "core", pageSize: Math.min(max, 100) };
  if (sort === "cited") p.sort = "CITED desc";
  else if (sort === "date") p.sort = "P_PDATE_D desc";
  // Europe PMC는 page 파라미터로 오프셋 페이징(core 포함)이 가능하다
  if (offset) p.page = Math.floor(offset / Math.min(max, 100)) + 1;
  const j = await httpJson(`${EPMC}/search?` + qs(p), { timeoutMs: 25000 });
  if (j.error || j.errCode) throw new SourceError(`Europe PMC 오류: ${j.error || j.errMsg || j.errCode}`);
  const res = j.resultList?.result || [];
  return { records: res.map(parseEpmc), total: j.hitCount ?? 0 };
}

/** 식별자 하나로 Europe PMC 레코드를 가져온다 */
export async function epmcById({ pmid, pmcid, doi }) {
  const q = pmid ? `EXT_ID:${pmid} AND SRC:MED` : pmcid ? `PMCID:${pmcid}` : `DOI:"${doi}"`;
  const j = await httpJson(`${EPMC}/search?` + qs({ query: q, format: "json", resultType: "core", pageSize: 3 }));
  const r = j.resultList?.result?.[0];
  return r ? parseEpmc(r) : null;
}

// ───────────────────────── OpenAlex ─────────────────────────
const OA = "https://api.openalex.org";
const OA_SELECT = "id,doi,title,display_name,publication_year,publication_date,cited_by_count,open_access,best_oa_location,primary_location,locations,authorships,abstract_inverted_index,type,ids,biblio";

function oaAuth() {
  return env("OPENALEX_API_KEY") ? { api_key: env("OPENALEX_API_KEY") } : {};
}

function rebuildAbstract(inv) {
  if (!inv) return null;
  const pos = [];
  for (const [w, ps] of Object.entries(inv)) for (const p of ps) pos[p] = w;
  return pos.filter((x) => x !== undefined).join(" ") || null;
}

function parseOA(w) {
  const au = (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean);
  const ids = w.ids || {};
  const pmid = ids.pmid ? String(ids.pmid).replace(/\D+/g, "").replace(/^0+/, "") || null : null;
  const pmcid = ids.pmcid ? String(ids.pmcid).match(/PMC\d+/i)?.[0]?.toUpperCase() || null : null;
  return {
    제목: stripTags(w.title || w.display_name),
    저자: au.slice(0, 10),
    저자수: au.length,
    저널: w.primary_location?.source?.display_name || null,
    발행일: w.publication_date || null,
    연도: w.publication_year || null,
    DOI: normDoi(w.doi),
    PMID: pmid,
    PMCID: pmcid,
    초록: rebuildAbstract(w.abstract_inverted_index),
    인용수: w.cited_by_count ?? null,
    오픈액세스: w.open_access?.is_oa ?? null,
    PDF링크: w.best_oa_location?.pdf_url || null,
    유형: w.type ? [w.type] : [],
    링크: w.doi || w.id,
    출처: ["openalex"],
    출처별ID: { openalex: String(w.id || "").replace("https://openalex.org/", "") },
    _links: (w.locations || [])
      .filter((l) => l.is_oa && (l.pdf_url || l.landing_page_url))
      .map((l) => ({ 출처: "openalex", 종류: l.pdf_url ? "pdf" : "landing", url: l.pdf_url || l.landing_page_url, 버전: l.version, 라이선스: l.license, 호스트: l.source?.type || undefined })),
  };
}

export async function openalexSearch({ query, max = 10, yearFrom, yearTo, sort = "relevance", page = 1, scope = "title_abstract", openAccessOnly = false, type }) {
  const clean = String(query).replace(/,/g, " ");
  const filters = [`${scope === "fulltext" ? "fulltext.search" : "title_and_abstract.search"}:${clean}`];
  if (yearFrom && yearTo) filters.push(`publication_year:${yearFrom}-${yearTo}`);
  else if (yearFrom) filters.push(`publication_year:>${Number(yearFrom) - 1}`);
  else if (yearTo) filters.push(`publication_year:<${Number(yearTo) + 1}`);
  if (openAccessOnly) filters.push("is_oa:true");
  if (type) filters.push(`type:${type}`);
  const sortParam = sort === "cited" ? "cited_by_count:desc" : sort === "date" ? "publication_date:desc" : "relevance_score:desc";
  const p = { filter: filters.filter(Boolean).join(","), per_page: Math.min(max, 100), page, sort: sortParam, select: OA_SELECT, ...oaAuth() };
  const j = await httpJson(`${OA}/works?` + qs(p), { timeoutMs: 25000 });
  return { records: (j.results || []).map(parseOA), total: j.meta?.count ?? 0 };
}

export async function openalexById({ doi, pmid, pmcid, openalex }) {
  const key = openalex || (doi ? `doi:${doi}` : pmid ? `pmid:${pmid}` : pmcid ? `pmcid:${pmcid}` : null);
  if (!key) return null;
  try {
    const w = await httpJson(`${OA}/works/${encodeURIComponent(key).replace("%3A", ":")}?` + qs({ select: OA_SELECT, ...oaAuth() }));
    return parseOA(w);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** 인용/참고문헌 목록(OpenAlex). direction: citing(이 논문을 인용한 논문) | references(이 논문이 인용한 논문) */
export async function openalexRelated({ workId, direction, max = 20, sort = "cited", page = 1 }) {
  const f = direction === "references" ? `cited_by:${workId}` : `cites:${workId}`;
  const sortParam = sort === "date" ? "publication_date:desc" : "cited_by_count:desc";
  const j = await httpJson(`${OA}/works?` + qs({ filter: f, per_page: Math.min(max, 100), page, sort: sortParam, select: OA_SELECT, ...oaAuth() }), { timeoutMs: 25000 });
  return { records: (j.results || []).map(parseOA), total: j.meta?.count ?? 0 };
}

// ───────────────────────── Semantic Scholar ─────────────────────────
const S2 = "https://api.semanticscholar.org/graph/v1";
const S2_FIELDS = "title,year,venue,publicationDate,externalIds,abstract,citationCount,influentialCitationCount,isOpenAccess,openAccessPdf,authors,publicationTypes,fieldsOfStudy,tldr";

function s2Headers() {
  return env("S2_API_KEY") ? { "x-api-key": env("S2_API_KEY") } : {};
}

function parseS2(p) {
  const ex = p.externalIds || {};
  const au = (p.authors || []).map((a) => a.name).filter(Boolean);
  return {
    제목: stripTags(p.title),
    저자: au.slice(0, 10),
    저자수: au.length,
    저널: p.venue || null,
    발행일: p.publicationDate || null,
    연도: p.year || null,
    DOI: normDoi(ex.DOI),
    PMID: ex.PubMed ? String(ex.PubMed) : null,
    PMCID: ex.PubMedCentral ? `PMC${String(ex.PubMedCentral).replace(/^PMC/i, "")}` : null,
    초록: p.abstract || null,
    인용수: p.citationCount ?? null,
    영향력인용수: p.influentialCitationCount ?? undefined,
    오픈액세스: p.isOpenAccess ?? null,
    PDF링크: p.openAccessPdf?.url || null,
    유형: p.publicationTypes || [],
    분야: p.fieldsOfStudy || undefined,
    한줄요약: p.tldr?.text || undefined,
    링크: p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : null,
    출처: ["semanticscholar"],
    출처별ID: { semanticscholar: p.paperId },
    _links: p.openAccessPdf?.url ? [{ 출처: "semanticscholar", 종류: "pdf", url: p.openAccessPdf.url, 라이선스: p.openAccessPdf.license || undefined }] : [],
  };
}

export async function s2Search({ query, max = 10, yearFrom, yearTo, offset = 0, fieldsOfStudy, publicationTypes, openAccessOnly = false }) {
  const p = { query, limit: Math.min(max, 100), offset, fields: S2_FIELDS };
  if (yearFrom || yearTo) p.year = `${yearFrom || ""}-${yearTo || ""}`;
  if (fieldsOfStudy?.length) p.fieldsOfStudy = fieldsOfStudy.join(",");
  if (publicationTypes?.length) p.publicationTypes = publicationTypes.join(",");
  if (openAccessOnly) p.openAccessPdf = "";
  const url = `${S2}/paper/search?` + qs(p) + (openAccessOnly ? "&openAccessPdf" : "");
  const j = await httpJson(url, { headers: s2Headers(), timeoutMs: 25000, retries: env("S2_API_KEY") ? 2 : 1 });
  return { records: (j.data || []).map(parseS2), total: j.total ?? 0 };
}

export async function s2ById(idStr) {
  try {
    const p = await httpJson(`${S2}/paper/${encodeURIComponent(idStr).replace(/%3A/g, ":").replace(/%2F/g, "/")}?` + qs({ fields: S2_FIELDS }), { headers: s2Headers(), retries: 1 });
    return parseS2(p);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function s2Related({ idStr, direction, max = 20, offset = 0 }) {
  const edge = direction === "references" ? "references" : "citations";
  const j = await httpJson(
    `${S2}/paper/${encodeURIComponent(idStr).replace(/%3A/g, ":").replace(/%2F/g, "/")}/${edge}?` +
      qs({ fields: S2_FIELDS.split(",").map((f) => f).join(","), limit: Math.min(max, 100), offset }),
    { headers: s2Headers(), retries: 1, timeoutMs: 25000 }
  );
  const key = direction === "references" ? "citedPaper" : "citingPaper";
  return { records: (j.data || []).map((d) => d[key]).filter((p) => p && p.title).map(parseS2), next: j.next };
}

// ───────────────────────── bioRxiv / medRxiv API ─────────────────────────
const BIORXIV = "https://api.biorxiv.org";

function parseBiorxiv(c) {
  const server = String(c.server || "").toLowerCase().includes("med") ? "medrxiv" : "biorxiv";
  const authors = String(c.authors || "").split(/;\s*/).filter(Boolean);
  const base = `https://www.${server}.org/content/${c.doi}v${c.version}`;
  return {
    제목: stripTags(c.title),
    저자: authors.slice(0, 10),
    저자수: authors.length,
    저널: server === "medrxiv" ? "medRxiv (preprint)" : "bioRxiv (preprint)",
    발행일: c.date || null,
    연도: yearOf(c.date),
    DOI: normDoi(c.doi),
    PMID: null,
    PMCID: null,
    초록: c.abstract || null,
    인용수: null,
    오픈액세스: true,
    PDF링크: `${base}.full.pdf`,
    유형: [c.type || "preprint"],
    분야: c.category || undefined,
    버전: Number(c.version) || undefined,
    라이선스: c.license || undefined,
    출판된DOI: c.published && c.published !== "NA" ? normDoi(c.published) : undefined,
    링크: base,
    출처: ["biorxiv"],
    출처별ID: { biorxiv: c.doi },
    프리프린트: true,
    _links: [
      { 출처: "biorxiv", 종류: "pdf", url: `${base}.full.pdf`, 버전: "submittedVersion", 라이선스: c.license || undefined },
      { 출처: "biorxiv", 종류: "landing", url: base },
    ],
  };
}

/**
 * bioRxiv/medRxiv 기간별 목록. 서버 측 키워드 검색은 없으므로 기간·분야로 좁힌 뒤
 * (한 호출 30건) 제목·초록을 클라이언트에서 거른다.
 */
export async function biorxivRange({ server = "medrxiv", from, to, category, maxPages = 10, concurrency = 5 }) {
  const cat = category ? `?category=${encodeURIComponent(String(category).toLowerCase().replace(/\s+/g, "_"))}` : "";
  const first = await httpJson(`${BIORXIV}/details/${server}/${from}/${to}/0${cat}`, { timeoutMs: 25000 });
  const msg = first.messages?.[0] || {};
  if (msg.status && msg.status !== "ok") throw new SourceError(`bioRxiv API: ${msg.status}`);
  const total = Number(msg.total) || (first.collection || []).length;
  const pageSize = 30;
  const pagesNeeded = Math.ceil(total / pageSize);
  const pages = Math.min(pagesNeeded, maxPages);
  let coll = [...(first.collection || [])];
  const cursors = [];
  for (let i = 1; i < pages; i++) cursors.push(i * pageSize);
  for (let i = 0; i < cursors.length; i += concurrency) {
    const batch = await Promise.all(cursors.slice(i, i + concurrency).map((c) => httpJson(`${BIORXIV}/details/${server}/${from}/${to}/${c}${cat}`, { timeoutMs: 25000 }).then((j) => j.collection || [])));
    for (const b of batch) coll = coll.concat(b);
  }
  // 같은 DOI의 여러 버전은 최신 버전만
  const latest = new Map();
  for (const c of coll) {
    const cur = latest.get(c.doi);
    if (!cur || Number(c.version) > Number(cur.version)) latest.set(c.doi, c);
  }
  return { records: [...latest.values()].map(parseBiorxiv), total, 스캔건수: coll.length, 전체페이지수: pagesNeeded, 스캔페이지수: pages, 잘림: pages < pagesNeeded };
}

/** DOI 하나로 bioRxiv/medRxiv 상세(버전 목록·게재본 DOI). 10.1101/… 와 신규 접두사 모두 시도 */
export async function biorxivByDoi(doi) {
  for (const server of ["biorxiv", "medrxiv"]) {
    try {
      const j = await httpJson(`${BIORXIV}/details/${server}/${doi}/na/json`, { timeoutMs: 15000, retries: 1 });
      const c = (j.collection || []).slice(-1)[0];
      if (c) return parseBiorxiv(c);
    } catch {
      /* 다음 서버 */
    }
  }
  return null;
}

// ───────────────────────── Unpaywall ─────────────────────────
export async function unpaywall(doi) {
  const email = env("UNPAYWALL_EMAIL");
  if (!email) return { 설정안됨: true };
  try {
    const j = await httpJson(`https://api.unpaywall.org/v2/${encodeURIComponent(doi).replace(/%2F/g, "/")}?` + qs({ email }), { retries: 1 });
    const mk = (l) => ({ 출처: "unpaywall", 종류: l.url_for_pdf ? "pdf" : "landing", url: l.url_for_pdf || l.url, 버전: l.version, 라이선스: l.license, 호스트: l.host_type, 저장소: l.repository_institution || undefined });
    return { is_oa: j.is_oa, oa_status: j.oa_status, 위치: (j.oa_locations || []).map(mk), 제목: j.title, 게재지: j.journal_name };
  } catch (e) {
    if (e.status === 404) return { is_oa: null, 위치: [], 메모: "Unpaywall에 없는 DOI" };
    throw e;
  }
}

// ───────────────────────── 링크 검증(PDF 실재 여부) ─────────────────────────
export async function checkPdfLink(url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-1023", "User-Agent": "Mozilla/5.0 (compatible; scholar-mcp/1.0)" }, signal: ctrl.signal, redirect: "follow" });
    const ct = res.headers.get("content-type") || "";
    const buf = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
    const magic = String.fromCharCode(...buf.slice(0, 5));
    clearTimeout(timer);
    return { 상태: res.status, 콘텐츠유형: ct.split(";")[0], PDF시그니처: magic === "%PDF-", 최종URL: res.url !== url ? res.url : undefined };
  } catch (e) {
    clearTimeout(timer);
    return { 상태: null, 오류: e.name === "AbortError" ? "시간 초과" : e.message };
  }
}
