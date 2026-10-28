# scholar-mcp

논문 검색 MCP 서버. PubMed · Europe PMC · bioRxiv/medRxiv · OpenAlex · Semantic Scholar · Unpaywall을
하나의 도구 집합으로 조회하고, 합법적인 무료(OA) 전문 PDF **링크**를 돌려준다(1단계: 링크 반환, 파일 저장은 하지 않음).

## 도구

| 도구 | 용도 |
|---|---|
| `scholar_search` | 여러 소스 병렬 검색 + DOI 기준 중복 병합. 소스별 건수·전체 히트·오류를 함께 보고 |
| `scholar_get_paper` | PMID/PMCID/DOI/OpenAlex/S2 ID 하나로 상세(초록 전문)·식별자 상호변환·프리프린트 게재본 확인 |
| `scholar_preprints_recent` | bioRxiv/medRxiv 기간·분야별 목록(서버 측 키워드 검색이 없어 기간·분야로 좁힌 뒤 클라이언트에서 키워드 필터, 잘림 표시) |
| `scholar_citations` | 인용한 논문(citing) / 참고문헌(references) |
| `scholar_find_pdf` | 무료 전문 링크 수집·정렬(출판본>수락본>제출본), 선택적 실제 PDF 검증 |
| `scholar_api_status` | 키 설정 여부(값 비노출)와 소스별 실호출 점검 |

## 환경변수 (값은 저장소에 넣지 말고 Vercel 환경변수로만 설정)

| 이름 | 필수 | 효과 |
|---|---|---|
| `NCBI_API_KEY` | 선택 | PubMed 초당 3→10회 |
| `OPENALEX_API_KEY` | 권장 | OpenAlex 일일 예산 10배·초당 30회 |
| `S2_API_KEY` | 권장 | Semantic Scholar 전용 한도(없으면 공용 풀이라 429 잦음) |
| `UNPAYWALL_EMAIL` | 선택 | 없으면 Unpaywall을 건너뜀(나머지 소스로 OA 링크 탐색) |
| `MCP_GATE_KEYS` / `MCP_GATE_MODE` | 운영 | 접근 게이트(`?k=`), `enforce`면 키 없는 호출 401 |

## 배포·호출

Vercel(서버리스 함수 `api/mcp.js`, stateless Streamable HTTP). 엔드포인트: `https://<도메인>/api/mcp?k=<게이트키>`

## 테스트

```
NCBI_API_KEY=... OPENALEX_API_KEY=... node smoke.mjs
```

MCP 프로토콜(인메모리 전송)로 모든 도구를 실제 API에 호출한다. 연도·정렬·페이지·OA 필터가 실제로 결과에 반영되는지(극단값) 검증한다.

## 알려진 한계

- bioRxiv/medRxiv API는 키워드 검색이 없다 → 키워드 검색은 `scholar_search`의 `sources=preprint`(Europe PMC 색인)를 쓴다.
- 인용수는 소스마다 집계 기준이 달라 병합 시 최댓값을 쓴다.
- `verify_links`의 PDF시그니처=false는 서버가 자동 요청을 막는 경우가 많아 링크 불량을 뜻하지 않는다.
- 유료 논문을 우회해 받는 경로는 제공하지 않는다.
