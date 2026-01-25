/**
 * GetMyListings (Cloud Code / UGS)
 *
 * 목적:
 * - 내(판매자) 리스팅을 페이지 단위로 조회한다.
 * - Cloud Save Custom Item은 서버 쿼리가 없으므로, CreateListing에서 만든 판매자 인덱스 키를 사용한다.
 *   - IDX_SELLER_STATUS_<sellerPlayerId>_ACTIVE_<listingId>
 * - 인덱스 페이지를 읽고 listingId를 추출한 뒤, 리스팅(Custom Item)을 배치로 조회한다.
 * - 인덱스/리스팅 불일치(인덱스는 있는데 리스팅이 없거나 status가 다름)는 무음 폴백 금지:
 *   Warning 로그를 남기고 해당 항목은 결과에서 제외한다(=부분 성공).
 *
 * 데이터 저장 위치(기본값):
 * - 인덱스(Custom Items): customId = "market_indexes"
 * - 리스팅(Custom Items): customId = "market_listings", key = "LISTING_<listingId>"
 *
 * params (최대 10개):
 *  1) sellerPlayerId: string (선택, 기본 context.playerId)
 *  2) status: "ACTIVE" (선택, 기본 "ACTIVE") // 현재 인덱스는 ACTIVE만 지원
 *  3) pageSize: number (선택, 기본 20, 최대 50)
 *  4) pageToken: string (선택) // Cloud Save nextPageToken 그대로
 *  5) indexesCustomId: string (선택, 기본 "market_indexes")
 *  6) listingsCustomId: string (선택, 기본 "market_listings")
 *
 * return:
 * - sellerPlayerId, status, items: listing[], nextPageToken, skipped
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

module.exports = async function GetMyListings(params, context, logger) {
  const {
    sellerPlayerId,
    status,
    pageSize,
    pageToken,
    indexesCustomId,
    listingsCustomId
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

  const cloudSave = new DataApi(context);
  const projectId = context.projectId;

  const keyPrefix = `IDX_SELLER_STATUS_${_sellerPlayerId}_ACTIVE_`;

  // 1) 판매자 인덱스 페이지 조회
  let indexRows = [];
  let nextPageToken = null;

  try {
    const indexRes = await cloudSave.listCustomItems(projectId, _indexesCustomId, {
      limit: _pageSize,
      keyPrefix,
      pageToken: (pageToken && typeof pageToken === "string") ? pageToken : undefined
    });

    indexRows = (indexRes?.data?.results || []);
    nextPageToken = indexRes?.data?.nextPageToken || null;
  } catch (e) {
    throw new Error(`GetMyListings: failed to list seller index items. err=${e?.message || e}`);
  }

  // 2) listingId 추출
  const listingIds = [];
  for (const row of indexRows) {
    const k = row?.key;
    if (typeof k !== "string") continue;

    const lastUnderscore = k.lastIndexOf("_");
    if (lastUnderscore <= 0 || lastUnderscore === k.length - 1) {
      logger.warning(`GetMyListings fallback: malformed index key. key=${k}`);
      continue;
    }

    const id = k.substring(lastUnderscore + 1);
    if (!id) {
      logger.warning(`GetMyListings fallback: failed to parse listingId. key=${k}`);
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
      logger.warning(`GetMyListings fallback: listing missing for index. listingKey=${lk}`);
      continue;
    }

    // ACTIVE 인덱스 기반이므로, ACTIVE가 아니면 불일치로 제외 + Warning
    if (v.status !== "ACTIVE") {
      skipped += 1;
      logger.warning(`GetMyListings fallback: listing status mismatch for ACTIVE index. listingId=${id}, status=${v.status}`);
      continue;
    }

    // 판매자 불일치도 제외 + Warning
    if (v.sellerPlayerId !== _sellerPlayerId) {
      skipped += 1;
      logger.warning(`GetMyListings fallback: listing seller mismatch. listingId=${id}, seller=${v.sellerPlayerId}, expected=${_sellerPlayerId}`);
      continue;
    }

    items.push(v);
  }

  return {
    sellerPlayerId: _sellerPlayerId,
    status: _status,
    items,
    nextPageToken,
    skipped
  };
};