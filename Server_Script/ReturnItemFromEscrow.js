/**
 * ReturnItemFromEscrow
 *
 * 목적:
 * - 마켓 전용 저장소(Public Custom Item)에서 HELD 에스크로를 읽고,
 *   판매자 인벤(단건 키)로 되돌린 뒤 tradeLock을 해제한다.
 * - 에스크로는 삭제하지 않고 status=RETURNED + item=null tombstone 처리.
 *
 * params (총 10개):
 *  1) itemInstanceId: string (필수)
 *  2) listingId: string (필수 권장)  // escrowKey 구성에 사용
 *  3) returnZone: "BAG" | "STORAGE" (선택, 기본 "BAG")
 *  4) sellerPlayerId: string (선택, 기본 context.playerId)
 *  5) marketOwnerPlayerId: string (선택, 기본 "MARKET")
 *  6) inventoryCustomId: string (선택, 기본 "inventory")
 *  7) escrowCustomId: string (선택, 기본 "market_escrow")
 *  8) clearLockReasonPrefix: string|null (선택, 기본 "ESCROW")
 *  9) expectedEscrowStatus: "HELD" (선택, 기본 "HELD")  // 운영 확장 대비
 * 10) allowOverwriteInventory: boolean (선택, 기본 false)
 *
 * 고정 규칙:
 * - 인벤 단건 키 저장 방식만 지원: inventoryKey = itemInstanceId
 * - escrowKey = `ESCROW_LISTING_${listingId}` (listingId 없으면 경고 + item 기반 키로 폴백)
 *
 * return:
 *  - { ok: true, returned: boolean, escrowKey: string|null, item: object|null, details: object }
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

const E_EscrowReturnFail = Object.freeze({
  ESCROW_NOT_FOUND: "ESCROW_NOT_FOUND",
  ESCROW_INVALID_SCHEMA: "ESCROW_INVALID_SCHEMA",
  ESCROW_STATUS_INVALID: "ESCROW_STATUS_INVALID",
  ESCROW_SELLER_MISMATCH: "ESCROW_SELLER_MISMATCH",
  ESCROW_ITEM_MISMATCH: "ESCROW_ITEM_MISMATCH",

  INVALID_ITEM_SCHEMA: "INVALID_ITEM_SCHEMA",
  MALFORMED_MARKET: "MALFORMED_MARKET",
  LOCK_NOT_PRESENT: "LOCK_NOT_PRESENT",
  LOCK_REASON_MISMATCH: "LOCK_REASON_MISMATCH",

  INVENTORY_CONFLICT: "INVENTORY_CONFLICT",
  INVENTORY_WRITE_FAILED: "INVENTORY_WRITE_FAILED",
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

  const returnZone = params.returnZone ?? "BAG";

  const sellerPlayerId = params.sellerPlayerId ?? context.playerId;
  const marketOwnerPlayerId = params.marketOwnerPlayerId ?? "MARKET";

  const inventoryCustomId = params.inventoryCustomId ?? "inventory";
  const escrowCustomId = params.escrowCustomId ?? "market_escrow";

  const clearLockReasonPrefix =
    (params.clearLockReasonPrefix === undefined) ? "ESCROW" : params.clearLockReasonPrefix;

  const expectedEscrowStatus = params.expectedEscrowStatus ?? "HELD";
  const allowOverwriteInventory = params.allowOverwriteInventory === true;

  if (!sellerPlayerId) throw new Error("sellerPlayerId is required (params.sellerPlayerId or context.playerId).");
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
      `[ReturnItemFromEscrow] listingId missing. fallback escrowKey=item-based. sellerPlayerId=${sellerPlayerId}, itemInstanceId=${itemInstanceId}, escrowKey=${escrowKey}`
    );
  }

  // ---------- 1) 에스크로 로드 ----------
  let escrow = null;
  try {
    const res = await dataApi.getCustomItems(marketOwnerPlayerId, escrowCustomId, escrowKey);
    escrow = res?.data?.value ?? null;
  } catch (e) {
    logger?.warn?.(
      `[ReturnItemFromEscrow] escrow load failed. marketOwnerPlayerId=${marketOwnerPlayerId}, customId=${escrowCustomId}, key=${escrowKey}, err=${e?.message ?? e}`
    );
  }

  if (!escrow) {
    return {
      ok: true,
      returned: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowReturnFail.ESCROW_NOT_FOUND, sellerPlayerId, itemInstanceId, listingId: listingId ?? null, nowIso },
    };
  }

  // ---------- 2) 에스크로 검증 ----------
  const status = escrow.status;
  const escrowSeller = escrow.sellerPlayerId;
  const escrowItemId = escrow.itemInstanceId;
  const escrowItem = escrow.item;

  if (status !== expectedEscrowStatus) {
    return {
      ok: true,
      returned: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowReturnFail.ESCROW_STATUS_INVALID, sellerPlayerId, itemInstanceId, listingId: listingId ?? null, nowIso, status, expectedEscrowStatus },
    };
  }

  if (escrowSeller !== sellerPlayerId) {
    return {
      ok: true,
      returned: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowReturnFail.ESCROW_SELLER_MISMATCH, sellerPlayerId, escrowSeller, itemInstanceId, listingId: listingId ?? null, nowIso },
    };
  }

  if (escrowItemId !== itemInstanceId) {
    return {
      ok: true,
      returned: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowReturnFail.ESCROW_ITEM_MISMATCH, sellerPlayerId, itemInstanceId, escrowItemId, listingId: listingId ?? null, nowIso },
    };
  }

  if (!escrowItem || typeof escrowItem !== "object") {
    return {
      ok: true,
      returned: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowReturnFail.ESCROW_INVALID_SCHEMA, sellerPlayerId, itemInstanceId, listingId: listingId ?? null, nowIso, message: "escrow.item missing" },
    };
  }

  // ---------- 3) 아이템 락/마켓 필드 검증 ----------
  const kind = escrowItem.kind;
  if (!kind || typeof kind !== "string") {
    return {
      ok: true,
      returned: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowReturnFail.INVALID_ITEM_SCHEMA, sellerPlayerId, itemInstanceId, nowIso, hint: "missing item.kind" },
    };
  }

  const market = escrowItem.market;
  if (!market || typeof market !== "object") {
    return {
      ok: true,
      returned: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowReturnFail.MALFORMED_MARKET, sellerPlayerId, itemInstanceId, nowIso },
    };
  }

  const tradeLock = market.tradeLock ?? { isLocked: false, reason: null, until: null };
  if (tradeLock.isLocked !== true) {
    return {
      ok: true,
      returned: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowReturnFail.LOCK_NOT_PRESENT, sellerPlayerId, itemInstanceId, nowIso, tradeLock },
    };
  }

  if (!_startsWithSafe(tradeLock.reason, clearLockReasonPrefix)) {
    return {
      ok: true,
      returned: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowReturnFail.LOCK_REASON_MISMATCH, sellerPlayerId, itemInstanceId, nowIso, tradeLock, clearLockReasonPrefix },
    };
  }

  // ---------- 4) 인벤 충돌 체크 ----------
  const inventoryKey = itemInstanceId;

  if (!allowOverwriteInventory) {
    try {
      const exist = await dataApi.getPrivateCustomItems(sellerPlayerId, inventoryCustomId, inventoryKey);
      const existVal = exist?.data?.value ?? null;
      if (existVal) {
        return {
          ok: true,
          returned: false,
          escrowKey,
          item: null,
          details: { failCode: E_EscrowReturnFail.INVENTORY_CONFLICT, sellerPlayerId, itemInstanceId, inventoryCustomId, inventoryKey, nowIso },
        };
      }
    } catch (e) {
      // 404일 수 있음. 메시지로 구분 불가하니 Warning 로그.
      logger?.warn?.(
        `[ReturnItemFromEscrow] inventory pre-check fallback path used. sellerPlayerId=${sellerPlayerId}, customId=${inventoryCustomId}, key=${inventoryKey}, err=${e?.message ?? e}`
      );
    }
  }

  // ---------- 5) 인벤에 쓸 아이템 구성(락 해제 + returnZone) ----------
  const nextItem = _clone(escrowItem);

  nextItem.location = nextItem.location && typeof nextItem.location === "object" ? nextItem.location : {};
  nextItem.location.zone = returnZone;
  nextItem.location.updatedAt = nowIso;

  nextItem.market = nextItem.market && typeof nextItem.market === "object" ? nextItem.market : {};
  nextItem.market.tradeLock = { isLocked: false, reason: null, until: null };

  nextItem.lifecycle = nextItem.lifecycle && typeof nextItem.lifecycle === "object" ? nextItem.lifecycle : {};
  nextItem.lifecycle.updatedAt = nowIso;

  // ---------- 6) 저장 순서: (A) 인벤 write → (B) escrow tombstone ----------
  try {
    await dataApi.setPrivateCustomItem(sellerPlayerId, inventoryCustomId, inventoryKey, nextItem);
  } catch (e) {
    logger?.warn?.(
      `[ReturnItemFromEscrow] inventory write failed. sellerPlayerId=${sellerPlayerId}, customId=${inventoryCustomId}, key=${inventoryKey}, err=${e?.message ?? e}`
    );
    return {
      ok: true,
      returned: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowReturnFail.INVENTORY_WRITE_FAILED, sellerPlayerId, itemInstanceId, nowIso, error: e?.message ?? String(e) },
    };
  }

  // 에스크로 tombstone(삭제 대신)
  try {
    const nextEscrow = _clone(escrow);
    nextEscrow.status = "RETURNED";
    nextEscrow.returnedAt = nowIso;
    nextEscrow.item = null;
    await dataApi.setCustomItem(marketOwnerPlayerId, escrowCustomId, escrowKey, nextEscrow);
  } catch (e) {
    // 아이템은 이미 복구됨. 무조건 Warning.
    logger?.warn?.(
      `[ReturnItemFromEscrow] escrow tombstone write failed (non-fatal). marketOwnerPlayerId=${marketOwnerPlayerId}, key=${escrowKey}, err=${e?.message ?? e}`
    );
    // 반환 성공은 유지하되, details로 명시.
  }

  // ---------- 7) 재조회 검증(인벤) ----------
  try {
    const vr = await dataApi.getPrivateCustomItems(sellerPlayerId, inventoryCustomId, inventoryKey);
    const v = vr?.data?.value ?? null;

    const vz = v?.location?.zone ?? null;
    const locked = v?.market?.tradeLock?.isLocked === true;

    if (!v || vz !== returnZone || locked) {
      logger?.warn?.(
        `[ReturnItemFromEscrow] verify failed. sellerPlayerId=${sellerPlayerId}, itemInstanceId=${itemInstanceId}, zone=${vz}, expected=${returnZone}, locked=${locked}`
      );
      return {
        ok: true,
        returned: false,
        escrowKey,
        item: null,
        details: { failCode: E_EscrowReturnFail.VERIFY_FAILED, sellerPlayerId, itemInstanceId, nowIso, zone: vz, expectedZone: returnZone, locked },
      };
    }

    return {
      ok: true,
      returned: true,
      escrowKey,
      item: v,
      details: {
        sellerPlayerId,
        itemInstanceId,
        listingId: listingId ?? null,
        nowIso,
        returnZone,
        escrow: { marketOwnerPlayerId, escrowCustomId, escrowKey },
      },
    };
  } catch (e) {
    logger?.warn?.(
      `[ReturnItemFromEscrow] verify read failed. sellerPlayerId=${sellerPlayerId}, itemInstanceId=${itemInstanceId}, err=${e?.message ?? e}`
    );
    return {
      ok: true,
      returned: false,
      escrowKey,
      item: null,
      details: { failCode: E_EscrowReturnFail.VERIFY_FAILED, sellerPlayerId, itemInstanceId, nowIso, error: e?.message ?? String(e) },
    };
  }
};