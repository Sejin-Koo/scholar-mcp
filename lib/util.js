// 공통 유틸: HTTP 호출(재시도·타임아웃), 입력 정규화, 레코드 병합
import { z } from "zod";

const UA = "scholar-mcp/1.0 (+https://github.com/Sejin-Koo/scholar-mcp)";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 소스 호출 오류. status가 있으면 HTTP 상태, retryAfter(초)가 있으면 429 대기 안내 */
export class SourceError extends Error {
  constructor(msg, { status, retryAfter, url } = {}) {
    super(msg);
    this.status = status;
    this.retryAfter = retryAfter;
    this.url = url;
  }
}

/** 키가 들어간 URL을 로그·오류에 그대로 남기지 않도록 마스킹 */
export function redact(url) {
  return String(url).replace(/([?&](?:api_key|apikey|serviceKey|email)=)[^&]*/gi, "$1***");
}

/**
 * fetch + 타임아웃 + 429/5xx 재시도(최대 retries회). 본문 텍스트를 돌려준다.
 * 429는 Retry-After(초)를 존중하되 한 번 대기는 maxWaitMs로 제한한다.
 */
export async function httpText(url, { headers = {}, timeoutMs = 20000, retries = 2, maxWaitMs = 4000, method = "GET" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers: { "User-Agent": UA, ...headers }, signal: ctrl.signal, redirect: "follow" });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        lastErr = new SourceError(`HTTP ${res.status}`, { status: res.status, retryAfter: Number.isFinite(ra) ? ra : undefined, url: redact(url) });
        if (attempt < retries) {
          const wait = Math.min(maxWaitMs, (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 800 * 2 ** attempt));
          await sleep(wait);
          continue;
        }
        throw lastErr;
      }
      const text = await res.text();
      if (!res.ok) throw new SourceError(`HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`, { status: res.status, url: redact(url) });
      return text;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof SourceError) throw e;
      lastErr = new SourceError(e.name === "AbortError" ? `시간 초과(${timeoutMs}ms)` : `네트워크 오류: ${e.message}`, { url: redact(url) });
      if (attempt < retries) {
        await sleep(600 * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

export async function httpJson(url, opts) {
  const t = await httpText(url, { ...opts, headers: { Accept: "application/json", ...(opts?.headers || {}) } });
  try {
    return JSON.parse(t);
  } catch {
    throw new SourceError(`JSON 파싱 실패: ${t.slice(0, 120).replace(/\s+/g, " ")}`, { url: redact(url) });
  }
}

export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

// ── 입력 스키마 보조: MCP 클라이언트가 숫자·불리언·배열을 문자열로 보내는 경우를 흡수 ──
export const zInt = (min, max, def) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v), z.number().int().min(min).max(max).optional()).describe(def !== undefined ? `기본 ${def}` : "").transform((v) => v ?? def);

export const zBool = (def = false) =>
  z.preprocess((v) => (typeof v === "string" ? ["true", "1", "yes", "y"].includes(v.trim().toLowerCase()) : v), z.boolean().optional()).transform((v) => v ?? def);

export const zList = (itemSchema) =>
  z.preprocess((v) => {
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return undefined;
      if (s.startsWith("[")) {
        try {
          return JSON.parse(s);
        } catch {
          /* 아래로 */
        }
      }
      return s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    }
    return v;
  }, z.array(itemSchema).optional());

// ── 식별자 정규화 ──
export function normDoi(d) {
  if (!d) return null;
  const s = String(d).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  return s ? s.toLowerCase() : null;
}

export function normTitle(t) {
  return String(t || "").toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

export function stripTags(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** 입력 식별자를 {type, value}로 판정: PMID / PMCID / DOI / OpenAlex / S2 / ArXiv */
export function parseId(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(?:pmid:?\s*)?(\d{4,9})$/i))) return { type: "pmid", value: m[1] };
  if ((m = s.match(/^(PMC\d+)$/i))) return { type: "pmcid", value: m[1].toUpperCase() };
  if ((m = s.match(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i))) return { type: "doi", value: normDoi(m[1]) };
  if ((m = s.match(/(?:openalex\.org\/)?(W\d{4,})$/i))) return { type: "openalex", value: m[1].toUpperCase() };
  if ((m = s.match(/^(?:S2:|CorpusId:)?([0-9a-f]{40})$/i))) return { type: "s2", value: m[1].toLowerCase() };
  if ((m = s.match(/(?:arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?$/i))) return { type: "arxiv", value: m[1] };
  if ((m = s.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i))) return { type: "pmid", value: m[1] };
  return null;
}

// ── 레코드 병합 ──
const SOURCE_PRIORITY = ["pubmed", "europepmc", "openalex", "semanticscholar", "biorxiv"];

export function recordKey(r) {
  if (r.DOI) return `doi:${r.DOI}`;
  if (r.PMID) return `pmid:${r.PMID}`;
  return `t:${normTitle(r.제목)}`;
}

/** 동일 논문 레코드를 DOI→PMID→제목 순으로 묶고 필드를 병합한다. */
export function mergeRecords(lists) {
  const byKey = new Map();
  const aliasIdx = new Map(); // 보조 키 → 대표 키
  const order = [];
  for (const rec of lists.flat()) {
    const keys = [rec.DOI && `doi:${rec.DOI}`, rec.PMID && `pmid:${rec.PMID}`, rec.제목 && `t:${normTitle(rec.제목)}`].filter(Boolean);
    let main = keys.map((k) => aliasIdx.get(k)).find(Boolean);
    if (!main) {
      main = keys[0] || `x:${order.length}`;
      byKey.set(main, { ...rec, 출처: [...rec.출처] });
      order.push(main);
    } else {
      const cur = byKey.get(main);
      for (const [k, v] of Object.entries(rec)) {
        if (k === "출처") {
          for (const s of v) if (!cur.출처.includes(s)) cur.출처.push(s);
          continue;
        }
        if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
        if (k === "인용수") {
          cur.인용수 = Math.max(cur.인용수 ?? 0, v);
          continue;
        }
        if (cur[k] === null || cur[k] === undefined || cur[k] === "" || (Array.isArray(cur[k]) && !cur[k].length)) cur[k] = v;
        else if (k === "초록" && String(v).length > String(cur[k]).length) cur[k] = v;
      }
    }
    for (const k of keys) aliasIdx.set(k, main);
  }
  return order.map((k) => {
    const r = byKey.get(k);
    r.출처.sort((a, b) => SOURCE_PRIORITY.indexOf(a) - SOURCE_PRIORITY.indexOf(b));
    return r;
  });
}

export function clip(s, n) {
  if (s == null) return s;
  const t = String(s);
  return n > 0 && t.length > n ? t.slice(0, n) + "…" : t;
}

export function yearOf(d) {
  const m = String(d || "").match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}
