/**
 * CancelListing (Cloud Code / UGS)
 *
 * 목적:
 * - 판매자가 ACTIVE 상태의 리스팅을 취소한다.
 * - 에스크로(Custom Item)에 보관된 아이템을 판매자 인벤(Private Custom Item)으로 되돌리고,
 *   tradeLock(ESCROW)을 해제한 뒤 location을 지정 존으로 복구한다.
 * - 리스팅(Custom Item)은 status=CANCELED 로 업데이트하고,
 *   ACTIVE 조회용 인덱스(Custom Item)는 삭제한다.
 * - 에스크로는 삭제하지 않고 status=CANCELED + item=null tombstone 처리(감사용).
 *
 * 데이터 저장 위치(기본값):
 * - 플레이어 인벤토리(Private Custom Items): customId = "inventory", key = "ITEM_<itemInstanceId>"
 * - 에스크로(Custom Items): customId = "market_escrow", key = "ESCROW_<listingId>"
 * - 리스팅(Custom Items): customId = "market_listings", key = "LISTING_<listingId>"
 * - 인덱스(Custom Items): customId = "market_indexes"
 *
 * 인덱스 키 규칙(CreateListing과 동일):
 * - IDX_STATUS_CREATEDAT_ACTIVE_<yyyymmdd>_<listingId>
 * - IDX_STATUS_PRICE_ACTIVE_<priceBucket12>_<listingId>
 * - IDX_SELLER_STATUS_<sellerPlayerId>_ACTIVE_<listingId>
 *
 * params (최대 10개):
 *  1) listingId: string (필수)
 *  2) sellerPlayerId: string (선택, 기본 context.playerId)
 *  3) returnZone: "BAG" | "STORAGE" (선택, 기본 "BAG")
 *  4) inventoryCustomId: string (선택, 기본 "inventory")
 *  5) listingsCustomId: string (선택, 기본 "market_listings")
 *  6) escrowCustomId: string (선택, 기본 "market_escrow")
 *  7) indexesCustomId: string (선택, 기본 "market_indexes")
 *
 * return:
 * - listingId, listingKey, escrowKey, status, canceledAt, restoredItemInstanceId
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

module.exports = async function CancelListing(params, context, logger) {
  const {
    listingId,
    sellerPlayerId,
    returnZone,
    inventoryCustomId,
    listingsCustomId,
    escrowCustomId,
    indexesCustomId
  } = params || {};

  if (!listingId || typeof listingId !== "string") {
    throw new Error("CancelListing: listingId is required (string).");
  }

  const _sellerPlayerId = sellerPlayerId || context.playerId;
  const _returnZone = returnZone || "BAG";

  const _inventoryCustomId = inventoryCustomId || "inventory";
  const _listingsCustomId = listingsCustomId || "market_listings";
  const _escrowCustomId = escrowCustomId || "market_escrow";
  const _indexesCustomId = indexesCustomId || "market_indexes";

  const cloudSave = new DataApi(context);
  const projectId = context.projectId;

  const listingKey = `LISTING_${listingId}`;
  const escrowKey = `ESCROW_${listingId}`;

  const nowIso = new Date(Date.now()).toISOString();

  // 1) 리스팅 로드 + 검증
  const listingRes = await cloudSave.getCustomItems(projectId, _listingsCustomId, [listingKey]);
  const listingRows = (listingRes?.data?.results || []);
  const listingRow = listingRows.find(r => r.key === listingKey);

  if (!listingRow || typeof listingRow.value !== "object" || listingRow.value === null) {
    throw new Error(`CancelListing: listing not found (customId=${_listingsCustomId}, key=${listingKey}).`);
  }

  const listing = listingRow.value;

  if (listing.status !== "ACTIVE") {
    throw new Error(`CancelListing: listing is not ACTIVE. current=${listing.status}`);
  }
  if (listing.sellerPlayerId !== _sellerPlayerId) {
    throw new Error("CancelListing: not listing owner.");
  }

  const createdAt = listing.createdAt;
  const price = listing.price;
  const itemInstanceId = listing.itemInstanceId;

  if (typeof createdAt !== "string" || createdAt.length < 10) {
    logger.warn(`CancelListing fallback: listing.createdAt invalid. listingId=${listingId}`);
  }
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    logger.warn(`CancelListing fallback: listing.price invalid. listingId=${listingId}`);
  }
  if (!itemInstanceId || typeof itemInstanceId !== "string") {
    throw new Error("CancelListing: listing.itemInstanceId missing.");
  }

  // 2) 에스크로 로드 (없으면 폴백 처리 + Warning)
  let escrow = null;
  try {
    const escrowRes = await cloudSave.getCustomItems(projectId, _escrowCustomId, [escrowKey]);
    const escrowRows = (escrowRes?.data?.results || []);
    const escrowRow = escrowRows.find(r => r.key === escrowKey);
    if (escrowRow && typeof escrowRow.value === "object" && escrowRow.value !== null) {
      escrow = escrowRow.value;
    }
  } catch (e) {
    logger.warn(`CancelListing fallback: failed to load escrow. listingId=${listingId}. err=${e?.message || e}`);
  }

  if (!escrow) {
    logger.warn(`CancelListing fallback: escrow missing. listingId=${listingId} (cannot restore item).`);
  }

  // 3) 아이템 복구(가능한 경우)
  let restoredItemInstanceId = null;

  if (escrow && escrow.item && typeof escrow.item === "object") {
    const item = escrow.item;

    // tradeLock / location 복구 + 폴백(Warning)
    if (!item.market || typeof item.market !== "object") {
      logger.warn(`CancelListing fallback: item.market missing in escrow. listingId=${listingId}`);
      item.market = { tradable: true, tradeLock: { isLocked: true, reason: "ESCROW", until: null } };
    }
    if (!item.market.tradeLock || typeof item.market.tradeLock !== "object") {
      logger.warn(`CancelListing fallback: item.market.tradeLock missing in escrow. listingId=${listingId}`);
      item.market.tradeLock = { isLocked: true, reason: "ESCROW", until: null };
    }

    // ESCROW 락 해제
    item.market.tradeLock = { isLocked: false, reason: null, until: null };

    // location 복구
    item.location = { zone: _returnZone };

    if (!item.lifecycle || typeof item.lifecycle !== "object") item.lifecycle = {};
    item.lifecycle.updatedAt = nowIso;

    const itemKey = `ITEM_${itemInstanceId}`;

    // 인벤에 복원(덮어쓰기 방지용 검증: 기존 키 존재 시 경고 후 덮어쓰기)
    try {
      const existingRes = await cloudSave.getPrivateCustomItems(projectId, _inventoryCustomId, [itemKey]);
      const existingRows = (existingRes?.data?.results || []);
      if (existingRows.find(r => r.key === itemKey)) {
        logger.warn(`CancelListing fallback: inventory already has key. overwrite. key=${itemKey}`);
      }
    } catch (e) {
      logger.warn(`CancelListing fallback: failed to pre-check inventory key. key=${itemKey}. err=${e?.message || e}`);
    }

    await cloudSave.setPrivateCustomItem(projectId, _inventoryCustomId, { key: itemKey, value: item });

    restoredItemInstanceId = itemInstanceId;

    // 에스크로 tombstone 처리(삭제 대신)
    const escrowTombstone = {
      ...(typeof escrow === "object" ? escrow : {}),
      status: "CANCELED",
      canceledAt: nowIso,
      item: null
    };
    await cloudSave.setCustomItem(projectId, _escrowCustomId, { key: escrowKey, value: escrowTombstone });
  } else {
    // 에스크로가 없으면 리스팅만 취소 처리하고 인덱스 정리
    logger.warn(`CancelListing fallback: skip item restore. listingId=${listingId}`);
    // 에스크로 tombstone도 시도(없는 키면 생성됨)
    await cloudSave.setCustomItem(projectId, _escrowCustomId, {
      key: escrowKey,
      value: {
        schema: 1,
        status: "CANCELED",
        listingId,
        itemInstanceId,
        sellerPlayerId: _sellerPlayerId,
        canceledAt: nowIso,
        item: null
      }
    });
  }

  // 4) 리스팅 상태 업데이트
  const canceledListing = {
    ...listing,
    status: "CANCELED",
    canceledAt: nowIso
  };
  await cloudSave.setCustomItem(projectId, _listingsCustomId, { key: listingKey, value: canceledListing });

  // 5) ACTIVE 인덱스 삭제(실패 시 Warning)
  try {
    const ymd = (typeof createdAt === "string" && createdAt.length >= 10) ?
      createdAt.slice(0, 10).replace(/-/g, "") :
      "00000000";

    const priceBucket = (typeof price === "number" && Number.isFinite(price)) ?
      Math.floor(price).toString().padStart(12, "0") :
      "000000000000";

    const idxStatusCreatedKey = `IDX_STATUS_CREATEDAT_ACTIVE_${ymd}_${listingId}`;
    const idxStatusPriceKey = `IDX_STATUS_PRICE_ACTIVE_${priceBucket}_${listingId}`;
    const idxSellerStatusKey = `IDX_SELLER_STATUS_${_sellerPlayerId}_ACTIVE_${listingId}`;

    await cloudSave.deleteCustomItem(idxStatusCreatedKey, projectId, _indexesCustomId);
    await cloudSave.deleteCustomItem(idxStatusPriceKey, projectId, _indexesCustomId);
    await cloudSave.deleteCustomItem(idxSellerStatusKey, projectId, _indexesCustomId);
  } catch (e) {
    logger.warn(`CancelListing fallback: failed to delete index keys. listingId=${listingId}. err=${e?.message || e}`);
  }

  return {
    listingId,
    listingKey,
    escrowKey,
    status: "CANCELED",
    canceledAt: nowIso,
    restoredItemInstanceId
  };
};