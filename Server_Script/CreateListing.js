/**
 * CreateListing (Cloud Code / UGS)
 *
 * 목적:
 * - 판매자가 보유 중인 아이템(itemInstanceId)을 거래소에 "등록"한다.
 * - 등록 시 아이템을 인벤토리(Private Custom Item)에서 제거하고,
 *   에스크로(Custom Item)에 보관한 뒤, 리스팅(Custom Item)을 생성한다.
 * - 동시에 조회/정렬을 위한 인덱스 키(Custom Item)도 생성한다.
 *
 * 데이터 저장 위치(기본값):
 * - 플레이어 인벤토리(Private Custom Items): customId = "inventory", key = "ITEM_<itemInstanceId>"
 * - 에스크로(Custom Items): customId = "market_escrow", key = "ESCROW_<listingId>"
 * - 리스팅(Custom Items): customId = "market_listings", key = "LISTING_<listingId>"
 * - 인덱스(Custom Items): customId = "market_indexes"
 *
 * 검증:
 * - item.market.tradable === true
 * - item.market.tradeLock.isLocked === false
 * - item.location.zone === "BAG" (없으면 폴백 처리 + Warning 로그)
 *
 * params (최대 10개):
 *  1) itemInstanceId: string (필수)
 *  2) price: number (필수, MT 기준)
 *  3) expiresInSeconds: number (선택, 기본 7일)
 *  4) sellerPlayerId: string (선택, 기본 context.playerId)
 *  5) inventoryCustomId: string (선택, 기본 "inventory")
 *  6) listingsCustomId: string (선택, 기본 "market_listings")
 *  7) escrowCustomId: string (선택, 기본 "market_escrow")
 *  8) indexesCustomId: string (선택, 기본 "market_indexes")
 *
 * return:
 * - listingId, listingKey, escrowKey, createdAt, expiresAt, price
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

module.exports = async function CreateListing(params, context, logger) {
  const {
    itemInstanceId,
    price,
    expiresInSeconds,
    sellerPlayerId,
    inventoryCustomId,
    listingsCustomId,
    escrowCustomId,
    indexesCustomId
  } = params || {};

  if (!itemInstanceId || typeof itemInstanceId !== "string") {
    throw new Error("CreateListing: itemInstanceId is required (string).");
  }
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw new Error("CreateListing: price is required (number > 0).");
  }

  const _sellerPlayerId = sellerPlayerId || context.playerId;
  const _inventoryCustomId = inventoryCustomId || "inventory";
  const _listingsCustomId = listingsCustomId || "market_listings";
  const _escrowCustomId = escrowCustomId || "market_escrow";
  const _indexesCustomId = indexesCustomId || "market_indexes";

  const _ttl = (typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0)
    ? Math.floor(expiresInSeconds)
    : 60 * 60 * 24 * 7; // 7 days

  const cloudSave = new DataApi({ accessToken: context.accessToken });
  const projectId = context.projectId;

  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + _ttl * 1000).toISOString();

  const listingId = `L${nowMs.toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`.toUpperCase();
  const itemKey = `ITEM_${itemInstanceId}`;
  const listingKey = `LISTING_${listingId}`;
  const escrowKey = `ESCROW_${listingId}`;

  // 1) 인벤에서 아이템 로드
  const invRes = await cloudSave.getPrivateCustomItems(projectId, _inventoryCustomId, [itemKey]);
  const invItems = (invRes?.data?.results || []);
  const invRow = invItems.find(r => r.key === itemKey);

  if (!invRow || typeof invRow.value !== "object" || invRow.value === null) {
    throw new Error(`CreateListing: item not found in inventory (customId=${_inventoryCustomId}, key=${itemKey}).`);
  }

  const item = invRow.value;

  // 2) 아이템 검증 + 폴백(경고 로그 필수)
  if (!item.market || typeof item.market !== "object") {
    logger.warn(`CreateListing fallback: item.market missing. itemInstanceId=${itemInstanceId}`);
    item.market = { tradable: false, tradeLock: { isLocked: true, reason: "INVALID_ITEM", until: null } };
  }
  if (item.market.tradable !== true) {
    throw new Error("CreateListing: item.market.tradable is false.");
  }

  if (!item.market.tradeLock || typeof item.market.tradeLock !== "object") {
    logger.warn(`CreateListing fallback: item.market.tradeLock missing. itemInstanceId=${itemInstanceId}`);
    item.market.tradeLock = { isLocked: false, reason: null, until: null };
  }
  if (item.market.tradeLock.isLocked === true) {
    throw new Error(`CreateListing: item is trade-locked. reason=${item.market.tradeLock.reason || "UNKNOWN"}`);
  }

  if (!item.location || typeof item.location !== "object") {
    logger.warn(`CreateListing fallback: item.location missing. Assume zone=BAG. itemInstanceId=${itemInstanceId}`);
    item.location = { zone: "BAG" };
  }
  if (item.location.zone !== "BAG") {
    throw new Error(`CreateListing: item.location.zone must be BAG. current=${item.location.zone}`);
  }

  // 3) 아이템을 에스크로 상태로 갱신(메타 포함)
  item.market.tradeLock = {
    isLocked: true,
    reason: "ESCROW",
    until: expiresAt
  };
  item.location = {
    zone: "MARKET_ESCROW",
    listingId
  };
  if (!item.lifecycle || typeof item.lifecycle !== "object") item.lifecycle = {};
  item.lifecycle.updatedAt = createdAt;

  // 4) 에스크로/리스팅/인덱스를 먼저 작성 (실패 시 인벤 삭제를 하지 않기 위해)
  const escrowValue = {
    schema: 1,
    status: "HELD",
    listingId,
    itemInstanceId,
    sellerPlayerId: _sellerPlayerId,
    createdAt,
    expiresAt,
    item
  };

  const listingValue = {
    schema: 1,
    listingId,
    status: "ACTIVE",
    sellerPlayerId: _sellerPlayerId,
    itemInstanceId,
    price,
    createdAt,
    expiresAt
  };

  // 인덱스 키는 "키 자체"로 정렬/필터에 쓰는 방식(프로젝트 규칙에 맞춰 조정)
  const ymd = createdAt.slice(0, 10).replace(/-/g, "");
  const priceBucket = Math.floor(price).toString().padStart(12, "0");

  const idxStatusCreatedKey = `IDX_STATUS_CREATEDAT_ACTIVE_${ymd}_${listingId}`;
  const idxStatusPriceKey = `IDX_STATUS_PRICE_ACTIVE_${priceBucket}_${listingId}`;
  const idxSellerStatusKey = `IDX_SELLER_STATUS_${_sellerPlayerId}_ACTIVE_${listingId}`;

  // 에스크로 생성
  await cloudSave.setCustomItem(projectId, _escrowCustomId, { key: escrowKey, value: escrowValue });

  // 리스팅 생성
  await cloudSave.setCustomItem(projectId, _listingsCustomId, { key: listingKey, value: listingValue });

  // 인덱스 생성(값은 최소화)
  await cloudSave.setCustomItem(projectId, _indexesCustomId, { key: idxStatusCreatedKey, value: { listingId, listingKey } });
  await cloudSave.setCustomItem(projectId, _indexesCustomId, { key: idxStatusPriceKey, value: { listingId, listingKey, price } });
  await cloudSave.setCustomItem(projectId, _indexesCustomId, { key: idxSellerStatusKey, value: { listingId, listingKey } });

  // 5) 인벤에서 아이템 제거(실질적인 "이동")
  await cloudSave.deletePrivateCustomItem(itemKey, projectId, _inventoryCustomId);

  return {
    listingId,
    listingKey,
    escrowKey,
    createdAt,
    expiresAt,
    price
  };
};