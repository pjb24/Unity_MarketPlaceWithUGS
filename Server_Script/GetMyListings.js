/**
 * GetMyListings (Cloud Code / UGS, Cloud Save v1.4 DataApi)
 *
 * 목적:
 * - 내(판매자) 리스팅을 페이지 단위로 조회한다.
 * - Cloud Save Custom Item은 “prefix로 서버 필터링된 목록”을 제공하지 않으므로,
 *   DataApi.getCustomKeys()로 customId 전체 키(알파벳 ASC, 100개 단위)를 받아오고
 *   서버에서 keyPrefix로 필터링하여 판매자 인덱스 키만 모은다.
 *   - IDX_SELLER_STATUS_<sellerPlayerId>_ACTIVE_<listingId>
 * - 인덱스 키에서 listingId를 추출한 뒤,
 *   DataApi.getCustomItems()로 market_listings의 LISTING_<listingId>들을 배치 조회한다.
 * - 리스팅에 연결된 “경매장 등록 아이템”은 customId="escrow"에 존재해야 한다.
 *   - 아이템 id에 prefix를 붙이지 않는다.
 *   - 아이템 이동은 customId 변경으로 처리한다(escrow <-> inventory customId).
 * - 데이터 불일치(인덱스만 존재/리스팅 누락/리스팅 상태 불일치/escrow 아이템 누락)는
 *   무음 폴백 금지: Warning 로그를 남기고 해당 항목은 결과에서 제외한다(=부분 성공).
 *
 * 데이터 저장 위치(기본값):
 * - 판매자 인덱스(Custom Items): customId = "market_indexes"
 *   - IDX_SELLER_STATUS_<sellerPlayerId>_ACTIVE_<listingId>
 * - 리스팅(Custom Items): customId = "market_listings", key = "LISTING_<listingId>"
 * - 에스크로 아이템(Custom Items): customId = "escrow", key = "<itemInstanceId>"  // prefix 없음
 *
 * 페이지네이션 제약 (DataApi 기준):
 * - getCustomKeys는 customId 전체 키를 알파벳 ASC로만 제공(100개 단위).
 * - 서버 prefix 필터가 없으므로, 원하는 prefix를 모을 때까지 여러 페이지를 스캔해야 한다.
 *
 * params (최대 10개):
 *  1) sellerPlayerId: string (선택, 기본 context.playerId)
 *  2) status: "ACTIVE" (선택, 기본 "ACTIVE") // 현재 인덱스는 ACTIVE만 지원
 *  3) pageSize: number (선택, 기본 20, 최대 50)
 *  4) pageToken: string (선택) // getCustomKeys(after)에 그대로 넣는 “after 키”
 *  5) indexesCustomId: string (선택, 기본 "market_indexes")
 *  6) listingsCustomId: string (선택, 기본 "market_listings")
 *  7) escrowCustomId: string (선택, 기본 "escrow")
 *
 * return:
 * - sellerPlayerId, status, items: listing[], nextPageToken, skipped
 *   (각 listing에 escrowItem 필드를 붙여 반환)
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

module.exports = async function GetMyListings({ params, context, logger }) {
  const {
    sellerPlayerId,
    status,
    pageSize,
    pageToken,
    indexesCustomId,
    listingsCustomId,
    escrowCustomId
  } = params || {};

  const _sellerPlayerId = sellerPlayerId || context.playerId;
  const _status = status || "ACTIVE";

  if (_status !== "ACTIVE") {
    throw new Error("GetMyListings: only status=ACTIVE is supported by current index design.");
  }

  const _pageSizeRaw = (typeof pageSize === "number" && Number.isFinite(pageSize)) ? Math.floor(pageSize) : 20;
  const _pageSize = Math.max(1, Math.min(_pageSizeRaw, 50));

  const _indexesCustomId = indexesCustomId || "market_indexes";
  const _listingsCustomId = listingsCustomId || "market_listings";
  const _escrowCustomId = escrowCustomId || "escrow";

  const cloudSave = new DataApi({ accessToken: context.accessToken });
  const projectId = context.projectId;

  const keyPrefix = `IDX_SELLER_STATUS_${_sellerPlayerId}_ACTIVE_`;

  // 1) 판매자 인덱스 키 수집 (getCustomKeys는 서버 prefix 필터 없음 -> 스캔)
  const matchedIndexKeys = [];
  let skipped = 0;

  let after = (typeof pageToken === "string" && pageToken.length > 0) ? pageToken : undefined;
  let nextPageToken = null;

  // 무한 스캔 방지 상한
  const MAX_KEY_PAGES_TO_SCAN = 20; // 20 * 100 = 2000 keys
  let scannedPages = 0;

  while (matchedIndexKeys.length < _pageSize && scannedPages < MAX_KEY_PAGES_TO_SCAN) {
    scannedPages += 1;

    let keysRes;
    try {
      keysRes = await cloudSave.getCustomKeys(projectId, _indexesCustomId, after);
    } catch (e) {
      throw new Error(`GetMyListings: failed to getCustomKeys for seller index. err=${e?.message || e}`);
    }

    const rows = (keysRes?.data?.results || []);
    if (rows.length === 0) {
      nextPageToken = null;
      break;
    }

    const lastKey = rows[rows.length - 1]?.key;
    if (typeof lastKey === "string" && lastKey.length > 0) {
      nextPageToken = lastKey;
    }

    for (const r of rows) {
      const k = r?.key;
      if (typeof k !== "string") continue;

      if (k.startsWith(keyPrefix)) {
        matchedIndexKeys.push(k);
        if (matchedIndexKeys.length >= _pageSize) break;
      }
    }

    after = (typeof lastKey === "string" && lastKey.length > 0) ? lastKey : undefined;
  }

  if (scannedPages >= MAX_KEY_PAGES_TO_SCAN && matchedIndexKeys.length < _pageSize) {
    logger.warning(`GetMyListings fallback: scanned too many key pages without collecting enough index keys. scannedPages=${scannedPages}, collected=${matchedIndexKeys.length}`);
  }

  // 2) listingId 추출
  const listingIds = [];
  for (const k of matchedIndexKeys) {
    const lastUnderscore = k.lastIndexOf("_");
    if (lastUnderscore <= 0 || lastUnderscore === k.length - 1) {
      skipped += 1;
      logger.warning(`GetMyListings fallback: malformed index key. key=${k}`);
      continue;
    }

    const id = k.substring(lastUnderscore + 1);
    if (!id) {
      skipped += 1;
      logger.warning(`GetMyListings fallback: failed to parse listingId. key=${k}`);
      continue;
    }

    listingIds.push(id);
  }

  // 3) 리스팅 배치 조회 (getCustomItems 20개 단위)
  const listingKeys = listingIds.map(id => `LISTING_${id}`);
  const listingMap = new Map();

  const CHUNK = 20;
  for (let i = 0; i < listingKeys.length; i += CHUNK) {
    const chunkKeys = listingKeys.slice(i, i + CHUNK);

    let res;
    try {
      res = await cloudSave.getCustomItems(projectId, _listingsCustomId, chunkKeys);
    } catch (e) {
      throw new Error(`GetMyListings: failed to getCustomItems for listings. err=${e?.message || e}`);
    }

    const rows = (res?.data?.results || []);
    for (const r of rows) {
      if (r && typeof r.key === "string") listingMap.set(r.key, r.value);
    }
  }

  // 4) escrow 아이템 배치 조회 (아이템 id prefix 없음)
  const listingById = new Map();
  const escrowItemIdSet = new Set();

  for (const id of listingIds) {
    const v = listingMap.get(`LISTING_${id}`);
    if (!v || typeof v !== "object") continue;

    listingById.set(id, v);

    const itemInstanceId = v.itemInstanceId; // 계약: listing.value에 itemInstanceId가 있어야 함
    if (typeof itemInstanceId === "string" && itemInstanceId.length > 0) {
      escrowItemIdSet.add(itemInstanceId);
    }
  }

  const escrowItemIds = Array.from(escrowItemIdSet);
  const escrowMap = new Map();

  for (let i = 0; i < escrowItemIds.length; i += CHUNK) {
    const chunkKeys = escrowItemIds.slice(i, i + CHUNK);

    let res;
    try {
      res = await cloudSave.getCustomItems(projectId, _escrowCustomId, chunkKeys);
    } catch (e) {
      throw new Error(`GetMyListings: failed to getCustomItems for escrow. err=${e?.message || e}`);
    }

    const rows = (res?.data?.results || []);
    for (const r of rows) {
      if (r && typeof r.key === "string") escrowMap.set(r.key, r.value);
    }
  }

  // 5) 결과 구성(인덱스 순서 유지) + 정합성 검증
  const items = [];

  for (const id of listingIds) {
    const v = listingById.get(id);

    if (!v || typeof v !== "object") {
      skipped += 1;
      logger.warning(`GetMyListings fallback: listing missing for index. listingKey=LISTING_${id}`);
      continue;
    }

    if (v.status !== "ACTIVE") {
      skipped += 1;
      logger.warning(`GetMyListings fallback: listing status mismatch for ACTIVE index. listingId=${id}, status=${v.status}`);
      continue;
    }

    if (v.sellerPlayerId !== _sellerPlayerId) {
      skipped += 1;
      logger.warning(`GetMyListings fallback: listing seller mismatch. listingId=${id}, seller=${v.sellerPlayerId}, expected=${_sellerPlayerId}`);
      continue;
    }

    const itemInstanceId = v.itemInstanceId;
    if (typeof itemInstanceId !== "string" || itemInstanceId.length === 0) {
      skipped += 1;
      logger.warning(`GetMyListings fallback: listing missing itemInstanceId. listingId=${id}`);
      continue;
    }

    const escrowItem = escrowMap.get(itemInstanceId);
    if (!escrowItem || typeof escrowItem !== "object") {
      skipped += 1;
      logger.warning(`GetMyListings fallback: escrow item missing for listing. listingId=${id}, itemInstanceId=${itemInstanceId}, escrowCustomId=${_escrowCustomId}`);
      continue;
    }

    items.push({
      ...v,
      escrowItem
    });
  }

  return {
    sellerPlayerId: _sellerPlayerId,
    status: _status,
    items,
    nextPageToken: nextPageToken || null,
    skipped
  };
};