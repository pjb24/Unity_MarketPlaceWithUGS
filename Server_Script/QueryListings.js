/**
 * QueryListings (Cloud Code / UGS)
 *
 * 목적:
 * - 거래소 리스팅을 페이지 단위로 조회한다.
 * - Cloud Save Custom Item은 "쿼리" API가 없으므로, CreateListing에서 만든 인덱스(Custom Item key)를 이용한다.
 * - 인덱스 키를 정렬 순서대로 읽고, 해당 listingId를 추출해 리스팅(Custom Item)을 배치로 조회한다.
 * - 데이터 불일치(인덱스는 있는데 리스팅이 없는 등)는 무음 폴백 금지:
 *   Warning 로그를 남기고 해당 항목은 결과에서 제외한다(=부분 성공).
 *
 * 데이터 저장 위치(기본값):
 * - 인덱스(Custom Items): customId = "market_indexes"
 *   - 최신순: IDX_STATUS_CREATEDAT_ACTIVE_<yyyymmdd>_<listingId>
 *   - 가격순: IDX_STATUS_PRICE_ACTIVE_<priceBucket12>_<listingId>
 * - 리스팅(Custom Items): customId = "market_listings", key = "LISTING_<listingId>"
 *
 * 구현 메모:
 * - listCustomItems는 페이지네이션(nextPageToken) 지원. keyPrefix로 범위를 좁힌다.
 * - createdAt 최신순은 key만으로는 "오름차순"이므로,
 *   최신순을 원하면 인덱스를 "역정렬용 키"로 설계해야 한다.
 *   현재 규칙(yyyymmdd)만으로는 일 단위 정렬만 보장되고, 시/분/초는 보장 불가.
 *   => 폴백이 아니므로 Warning은 남기지 않는다. (설계 제약)
 *
 * params (최대 10개):
 *  1) status: "ACTIVE" | "SOLD" | "CANCELED" (선택, 기본 "ACTIVE")  // 현재는 ACTIVE 인덱스만 지원
 *  2) sort: "CREATED_AT" | "PRICE" (선택, 기본 "CREATED_AT")
 *  3) order: "ASC" | "DESC" (선택, 기본 "ASC") // DESC는 인덱스 설계상 완전 보장 불가(위 메모 참조)
 *  4) pageSize: number (선택, 기본 20, 최대 50)
 *  5) pageToken: string (선택) // Cloud Save nextPageToken 그대로
 *  6) indexesCustomId: string (선택, 기본 "market_indexes")
 *  7) listingsCustomId: string (선택, 기본 "market_listings")
 *
 * return:
 * - items: listing[] (조회된 listing.value 배열)
 * - nextPageToken: string | null
 * - skipped: number (불일치로 제외된 개수)
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

module.exports = async function QueryListings(params, context, logger) {
  const {
    status,
    sort,
    order,
    pageSize,
    pageToken,
    indexesCustomId,
    listingsCustomId
  } = params || {};

  const _status = status || "ACTIVE";
  const _sort = sort || "CREATED_AT";
  const _order = order || "ASC";

  if (_status !== "ACTIVE") {
    throw new Error("QueryListings: only status=ACTIVE is supported by current index design.");
  }
  if (_sort !== "CREATED_AT" && _sort !== "PRICE") {
    throw new Error("QueryListings: sort must be CREATED_AT or PRICE.");
  }
  if (_order !== "ASC" && _order !== "DESC") {
    throw new Error("QueryListings: order must be ASC or DESC.");
  }

  const _pageSizeRaw = (typeof pageSize === "number" && Number.isFinite(pageSize)) ? Math.floor(pageSize) : 20;
  const _pageSize = Math.max(1, Math.min(_pageSizeRaw, 50));

  const _indexesCustomId = indexesCustomId || "market_indexes";
  const _listingsCustomId = listingsCustomId || "market_listings";

  const cloudSave = new DataApi(context);
  const projectId = context.projectId;

  // 인덱스 prefix 결정
  // - CREATED_AT: 날짜 단위 prefix까지만 가능(yyyymmdd는 key 내부라 prefix로 전체를 못 잡음) => "IDX_STATUS_CREATEDAT_ACTIVE_"
  // - PRICE: "IDX_STATUS_PRICE_ACTIVE_"
  const keyPrefix = (_sort === "PRICE") ?
    "IDX_STATUS_PRICE_ACTIVE_" :
    "IDX_STATUS_CREATEDAT_ACTIVE_";

  if (_order === "DESC") {
    // 현재 키 설계상 listCustomItems는 기본 오름차순 조회이며, 서버에서 역순 조회가 안 된다.
    // order=DESC를 받되, 실제 반환은 ASC 기반이 될 수 있음을 Warning으로 알린다(무음 금지).
    logger.warning("QueryListings fallback: order=DESC requested but Cloud Save listCustomItems does not support reverse order. Returning ASC-based page.");
  }

  // 1) 인덱스 페이지 조회
  const listReq = {
    projectId,
    customId: _indexesCustomId,
    limit: _pageSize,
    keyPrefix
  };
  if (pageToken && typeof pageToken === "string") {
    listReq.after = pageToken; // 일부 런타임에서 pageToken 필드명이 after로 노출되는 케이스 대비
    listReq.pageToken = pageToken; // 런타임/SDK 차이 대비 (둘 중 하나만 먹힘)
  }

  let indexRows = [];
  let nextPageToken = null;

  try {
    // SDK 시그니처 차이를 흡수하기 위해, 반환값 구조를 방어적으로 처리
    const indexRes = await cloudSave.listCustomItems(projectId, _indexesCustomId, {
      limit: _pageSize,
      keyPrefix,
      pageToken: (pageToken && typeof pageToken === "string") ? pageToken : undefined
    });

    indexRows = (indexRes?.data?.results || []);
    nextPageToken = indexRes?.data?.nextPageToken || null;
  } catch (e) {
    // listCustomItems 미지원/시그니처 불일치 등은 즉시 실패가 맞다.
    throw new Error(`QueryListings: failed to list index items. err=${e?.message || e}`);
  }

  // 2) listingId 추출
  const listingIds = [];
  for (const row of indexRows) {
    const k = row?.key;
    if (typeof k !== "string") continue;

    // key 끝의 _<listingId> 추출
    const lastUnderscore = k.lastIndexOf("_");
    if (lastUnderscore <= 0 || lastUnderscore === k.length - 1) {
      logger.warning(`QueryListings fallback: malformed index key. key=${k}`);
      continue;
    }
    const id = k.substring(lastUnderscore + 1);
    if (!id) {
      logger.warning(`QueryListings fallback: failed to parse listingId. key=${k}`);
      continue;
    }
    listingIds.push(id);
  }

  // 3) 리스팅 배치 조회
  const listingKeys = listingIds.map(id => `LISTING_${id}`);

  let listingRows = [];
  if (listingKeys.length > 0) {
    const listingRes = await cloudSave.getCustomItems(projectId, _listingsCustomId, listingKeys);
    listingRows = (listingRes?.data?.results || []);
  }

  const listingMap = new Map();
  for (const r of listingRows) {
    if (r && typeof r.key === "string") listingMap.set(r.key, r.value);
  }

  // 4) 결과 구성(인덱스 순서 유지)
  const items = [];
  let skipped = 0;

  for (const id of listingIds) {
    const lk = `LISTING_${id}`;
    const v = listingMap.get(lk);

    if (!v || typeof v !== "object") {
      skipped += 1;
      logger.warning(`QueryListings fallback: listing missing for index. listingKey=${lk}`);
      continue;
    }

    // ACTIVE 인덱스 기반이므로, ACTIVE가 아니면 불일치로 제외 + Warning
    if (v.status !== "ACTIVE") {
      skipped += 1;
      logger.warning(`QueryListings fallback: listing status mismatch for ACTIVE index. listingId=${id}, status=${v.status}`);
      continue;
    }

    items.push(v);
  }

  return {
    items,
    nextPageToken,
    skipped
  };
};