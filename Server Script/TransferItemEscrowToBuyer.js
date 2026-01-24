/**
 * TransferItemEscrowToBuyer
 *
 * 목적:
 * - 마켓 전용 저장소(Custom Item)에서 HELD 에스크로를 읽고,
 *   구매자 인벤(단건 키)로 이전한다.
 * - 에스크로는 삭제하지 않고 status=SOLD + item=null tombstone 처리.
 *
 * params (총 10개):
 *  1) itemInstanceId: string (필수)
 *  2) listingId: string (필수 권장)  // escrowKey 구성에 사용
 *  3) buyerPlayerId: string (필수)
 *  4) buyerZone: "BAG" | "STORAGE" (선택, 기본 "BAG")
 *  5) marketOwnerPlayerId: string (선택, 기본 "MARKET")
 *  6) inventoryCustomId: string (선택, 기본 "inventory")
 *  7) escrowCustomId: string (선택, 기본 "market_escrow")
 *  8) expectedEscrowStatus: "HELD" (선택, 기본 "HELD")
 *  9) allowOverwriteBuyerInventory: boolean (선택, 기본 false)
 * 10) clearLockReasonPrefix: string|null (선택, 기본 "ESCROW")
 *
 * 고정 규칙:
 * - 구매자 인벤 단건 키 저장 방식만 지원: inventoryKey = itemInstanceId
 * - escrowKey = `ESCROW_LISTING_${listingId}` (listingId 없으면 경고 + item 기반 키로 폴백)
 *
 * return:
 *  - { ok: true, transferred: boolean, escrowKey: string|null, item: object|null, details: object }
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

const E_EscrowTransferFail = Object.freeze({
  ESCROW_NOT_FOUND: "ESCROW_NOT_FOUND",
  ESCROW_INVALID_SCHEMA: "ESCROW_INVALID_SCHEMA",
  ESCROW_STATUS_INVALID: "ESCROW_STATUS_INVALID",
  ESCROW_ITEM_MISMATCH: "ESCROW_ITEM_MISMATCH",

  INVALID_ITEM_SCHEMA: "INVALID_ITEM_SCHEMA",
  MALFORMED_MARKET: "MALFORMED_MARKET",
  LOCK_NOT_PRESENT: "LOCK_NOT_PRESENT",
  LOCK_REASON_MISMATCH: "LOCK_REASON_MISMATCH",

  BUYER_INVENTORY_CONFLICT: "BUYER_INVENTORY_CONFLICT",
  BUYER_INVENTORY_WRITE_FAILED: "BUYER_INVENTORY_WRITE_FAILED",
  ESCROW_TOMBSTONE_FAILED: "ESCROW_TOMBSTONE_FAILED",

  VERIFY_FAILED: "VERIFY_FAILED",
});

function _nowIso() {
  return new Date().toISOString();
}

function _clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function _startsWithSafe(s, prefix) {
  if (!prefix) return true;
  if (typeof s !== "string") return false;
  return s.startsWith(prefix);
}

module.exports = async ({ params, context, logger }) => {
  // ---- params (<=10) ----
  const itemInstanceId = params.itemInstanceId;
  const listingId = params.listingId;
  const buyerPlayerId = params.buyerPlayerId;

  const buyerZone = params.buyerZone ?? "BAG";

  const marketOwnerPlayerId = params.marketOwnerPlayerId ?? "MARKET";
  const inventoryCustomId = params.inventoryCustomId ?? "inventory";
  const escrowCustomId = params.escrowCustomId ?? "market_escrow";

  const expectedEscrowStatus = params.expectedEscrowStatus ?? "HELD";
  const allowOverwriteBuyerInventory = params.allowOverwriteBuyerInventory === true;

  const clearLockReasonPrefix =
    (params.clearLockReasonPrefix === undefined) ? "ESCROW" : params.clearLockReasonPrefix;

  if (!buyerPlayerId) throw new Error("buyerPlayerId is required.");
  if (!itemInstanceId) throw new Error("itemInstanceId is required.");

  const nowIso = _nowIso();
  const dataApi = new DataApi(context);

  // ---- escrowKey 규칙 ----
  let escrowKey = null;
  if (listingId) {
    escrowKey = `ESCROW_LISTING_${listingId}`;
  } else {
    escrowKey = `ESCROW_ITEM_${itemInstanceId}`;
    logger?.warn?.(
      `[TransferItemEscrowToBuyer] listingId missing. fallback escrowKey=item-based. itemInstanceId=${itemInstanceId}, escrowKey=${escrowKey}`
    );
  }

  // ---------- 1) 에스크로 로드 ----------
  let escrow = null;
  try {
    const res = await dataApi.getCustomItems(marketOwnerPlayerId, escrowCustomId, escrowKey);
    escrow = res?.data?.value ?? null;
  } catch (e) {
    logger?.warn?.(
      `[TransferItemEscrowToBuyer] escrow load failed. marketOwnerPlayerId=${marketOwnerPlayerId}, customId=${escrowCustomId}, key=${escrowKey}, err=${e?.message ?? e}`
    );
  }

  if (!escrow) {
    return {
      ok: true,
      transferred: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowTransferFail.ESCROW_NOT_FOUND, buyerPlayerId, itemInstanceId, listingId: listingId ?? null, nowIso },
    };
  }

  // ---------- 2) 에스크로 검증 ----------
  const status = escrow.status;
  const escrowItemId = escrow.itemInstanceId;
  const sellerPlayerId = escrow.sellerPlayerId ?? null;
  const escrowItem = escrow.item;

  if (status !== expectedEscrowStatus) {
    return {
      ok: true,
      transferred: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowTransferFail.ESCROW_STATUS_INVALID, buyerPlayerId, itemInstanceId, listingId: listingId ?? null, nowIso, status, expectedEscrowStatus },
    };
  }

  if (escrowItemId !== itemInstanceId) {
    return {
      ok: true,
      transferred: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowTransferFail.ESCROW_ITEM_MISMATCH, buyerPlayerId, itemInstanceId, escrowItemId, listingId: listingId ?? null, nowIso },
    };
  }

  if (!escrowItem || typeof escrowItem !== "object") {
    return {
      ok: true,
      transferred: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowTransferFail.ESCROW_INVALID_SCHEMA, buyerPlayerId, itemInstanceId, nowIso, message: "escrow.item missing" },
    };
  }

  // ---------- 3) 아이템 락/마켓 필드 검증 ----------
  const kind = escrowItem.kind;
  if (!kind || typeof kind !== "string") {
    return {
      ok: true,
      transferred: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowTransferFail.INVALID_ITEM_SCHEMA, buyerPlayerId, itemInstanceId, nowIso, hint: "missing item.kind" },
    };
  }

  const market = escrowItem.market;
  if (!market || typeof market !== "object") {
    return {
      ok: true,
      transferred: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowTransferFail.MALFORMED_MARKET, buyerPlayerId, itemInstanceId, nowIso },
    };
  }

  const tradeLock = market.tradeLock ?? { isLocked: false, reason: null, until: null };
  if (tradeLock.isLocked !== true) {
    return {
      ok: true,
      transferred: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowTransferFail.LOCK_NOT_PRESENT, buyerPlayerId, itemInstanceId, nowIso, tradeLock },
    };
  }

  if (!_startsWithSafe(tradeLock.reason, clearLockReasonPrefix)) {
    return {
      ok: true,
      transferred: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowTransferFail.LOCK_REASON_MISMATCH, buyerPlayerId, itemInstanceId, nowIso, tradeLock, clearLockReasonPrefix },
    };
  }

  // ---------- 4) 구매자 인벤 충돌 체크 ----------
  const buyerInventoryKey = itemInstanceId;

  if (!allowOverwriteBuyerInventory) {
    try {
      const exist = await dataApi.getPrivateCustomItems(buyerPlayerId, inventoryCustomId, buyerInventoryKey);
      const existVal = exist?.data?.value ?? null;
      if (existVal) {
        return {
          ok: true,
          transferred: false,
          escrowKey,
          item: null,
          details: {
            failCode: E_EscrowTransferFail.BUYER_INVENTORY_CONFLICT,
            buyerPlayerId,
            itemInstanceId,
            inventoryCustomId,
            inventoryKey: buyerInventoryKey,
            nowIso,
          },
        };
      }
    } catch (e) {
      // 404일 수 있음. 폴백이므로 Warning 로그.
      logger?.warn?.(
        `[TransferItemEscrowToBuyer] buyer inventory pre-check fallback path used. buyerPlayerId=${buyerPlayerId}, customId=${inventoryCustomId}, key=${buyerInventoryKey}, err=${e?.message ?? e}`
      );
    }
  }

  // ---------- 5) 구매자 인벤에 쓸 아이템 구성(락 해제 + buyerZone) ----------
  const nextItem = _clone(escrowItem);

  nextItem.location = nextItem.location && typeof nextItem.location === "object" ? nextItem.location : {};
  nextItem.location.zone = buyerZone;
  nextItem.location.updatedAt = nowIso;

  nextItem.market = nextItem.market && typeof nextItem.market === "object" ? nextItem.market : {};
  nextItem.market.tradeLock = { isLocked: false, reason: null, until: null };

  nextItem.lifecycle = nextItem.lifecycle && typeof nextItem.lifecycle === "object" ? nextItem.lifecycle : {};
  nextItem.lifecycle.updatedAt = nowIso;

  // 구매자 정보 기록(옵션이지만 추적에 유용)
  nextItem.lifecycle = nextItem.lifecycle || {};
  nextItem.lifecycle.transferredAt = nowIso;
  nextItem.lifecycle.transferredTo = buyerPlayerId;

  // ---------- 6) 저장 순서: (A) 구매자 인벤 write → (B) escrow tombstone ----------
  try {
    await dataApi.setPrivateCustomItem(buyerPlayerId, inventoryCustomId, buyerInventoryKey, nextItem);
  } catch (e) {
    logger?.warn?.(
      `[TransferItemEscrowToBuyer] buyer inventory write failed. buyerPlayerId=${buyerPlayerId}, customId=${inventoryCustomId}, key=${buyerInventoryKey}, err=${e?.message ?? e}`
    );
    return {
      ok: true,
      transferred: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowTransferFail.BUYER_INVENTORY_WRITE_FAILED, buyerPlayerId, itemInstanceId, nowIso, error: e?.message ?? String(e) },
    };
  }

  try {
    const nextEscrow = _clone(escrow);
    nextEscrow.status = "SOLD";
    nextEscrow.soldAt = nowIso;
    nextEscrow.buyerPlayerId = buyerPlayerId;
    nextEscrow.item = null; // tombstone
    await dataApi.setCustomItem(marketOwnerPlayerId, escrowCustomId, escrowKey, nextEscrow);
  } catch (e) {
    // 구매자는 이미 받음. 무조건 Warning.
    logger?.warn?.(
      `[TransferItemEscrowToBuyer] escrow tombstone write failed (non-fatal). marketOwnerPlayerId=${marketOwnerPlayerId}, key=${escrowKey}, err=${e?.message ?? e}`
    );
  }

  // ---------- 7) 재조회 검증(구매자 인벤) ----------
  try {
    const vr = await dataApi.getPrivateCustomItems(buyerPlayerId, inventoryCustomId, buyerInventoryKey);
    const v = vr?.data?.value ?? null;

    const vz = v?.location?.zone ?? null;
    const locked = v?.market?.tradeLock?.isLocked === true;

    if (!v || vz !== buyerZone || locked) {
      logger?.warn?.(
        `[TransferItemEscrowToBuyer] verify failed. buyerPlayerId=${buyerPlayerId}, itemInstanceId=${itemInstanceId}, zone=${vz}, expected=${buyerZone}, locked=${locked}`
      );
      return {
        ok: true,
        transferred: false,
        escrowKey,
        item: null,
        details: { failCode: E_EscrowTransferFail.VERIFY_FAILED, buyerPlayerId, itemInstanceId, nowIso, zone: vz, expectedZone: buyerZone, locked },
      };
    }

    return {
      ok: true,
      transferred: true,
      escrowKey,
      item: v,
      details: {
        buyerPlayerId,
        sellerPlayerId,
        itemInstanceId,
        listingId: listingId ?? null,
        nowIso,
        buyerZone,
        escrow: { marketOwnerPlayerId, escrowCustomId, escrowKey },
      },
    };
  } catch (e) {
    logger?.warn?.(
      `[TransferItemEscrowToBuyer] verify read failed. buyerPlayerId=${buyerPlayerId}, itemInstanceId=${itemInstanceId}, err=${e?.message ?? e}`
    );
    return {
      ok: true,
      transferred: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowTransferFail.VERIFY_FAILED, buyerPlayerId, itemInstanceId, nowIso, error: e?.message ?? String(e) },
    };
  }
};