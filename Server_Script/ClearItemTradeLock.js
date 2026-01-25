/**
 * ClearItemTradeLock
 *
 * 목적:
 * - 인벤(Private Custom Item, 단건 키=itemInstanceId)에 저장된 아이템(FRAG/EQ)의
 *   market.tradeLock 을 "해제"한다.
 * - writeLock 기반 충돌 체크(경합 방지).
 * - 무음(silent) 클리어 금지: "이미 풀려있음" 같은 폴백 상황도 반드시 warn 로그.
 *
 * 저장 위치(기본):
 * - getPrivateCustomItems / setPrivateCustomItem 사용
 *
 * params:
 *  - itemInstanceId: string (필수)
 *  - expectedReason: string | null (선택)
 *      - 지정 시: 현재 reason이 expectedReason과 다르면 해제하지 않고 warn 후 반환
 *  - force: boolean (선택, 기본 false)
 *      - true면 expectedReason 불일치여도 해제
 *  - note: string | null (선택. location.note에 운영/디버그 메모 기록)
 *  - ownerPlayerId: string (선택, 기본 context.playerId)
 *  - inventoryCustomId: string (선택, 기본 "inventory")
 *
 * return:
 *  - itemInstanceId, ownerPlayerId, cleared, previousTradeLock, tradeLock, writeLock
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

function _assertNonEmptyString(name, v) {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
}

function _assertCustomId(customId) {
  // Cloud Save: 1~50, [A-Za-z0-9_-] 만 허용
  if (typeof customId !== "string" || customId.length < 1 || customId.length > 50) {
    throw new Error("inventoryCustomId length must be 1..50");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(customId)) {
    throw new Error("inventoryCustomId allows only [A-Za-z0-9_-]");
  }
}

module.exports = async ({ params, context, logger }) => {
  const {
    itemInstanceId,
    expectedReason = null,
    force = false,
    note = null,
    ownerPlayerId = context.playerId,
    inventoryCustomId = "inventory",
  } = params ?? {};

  _assertNonEmptyString("itemInstanceId", itemInstanceId);
  _assertNonEmptyString("ownerPlayerId", ownerPlayerId);
  _assertCustomId(inventoryCustomId);

  if (expectedReason != null && (typeof expectedReason !== "string" || expectedReason.trim().length === 0)) {
    throw new Error("expectedReason must be string or null");
  }
  if (typeof force !== "boolean") {
    throw new Error("force must be boolean");
  }

  // Cloud Code server-to-service auth
  const cloudSave = new DataApi(context);
  const projectId = context.projectId;

  // 1) read with writeLock
  const getRes = await cloudSave.getPrivateCustomItems(projectId, inventoryCustomId, [itemInstanceId]);
  const items = getRes?.data?.results ?? [];

  if (items.length === 0) {
    throw new Error(`item not found in inventory. customId=${inventoryCustomId}, key=${itemInstanceId}`);
  }

  const row = items[0];
  const currentWriteLock = row?.writeLock;
  const item = row?.value;

  if (!item || typeof item !== "object") {
    throw new Error("stored item value is invalid (not object)");
  }

  // schema 기대 필드 보정(무음 보정 금지: 반드시 warn)
  if (!item.market || typeof item.market !== "object") {
    logger.warning(`[ClearItemTradeLock] market missing. Creating market object. item=${itemInstanceId}`);
    item.market = {};
  }
  if (!item.market.tradeLock || typeof item.market.tradeLock !== "object") {
    logger.warning(`[ClearItemTradeLock] market.tradeLock missing. Creating tradeLock object. item=${itemInstanceId}`);
    item.market.tradeLock = { isLocked: false, reason: null, until: null };
  }

  const prev = {
    isLocked: !!item.market.tradeLock.isLocked,
    reason: item.market.tradeLock.reason ?? null,
    until: item.market.tradeLock.until ?? null,
  };

  // 이미 풀려있음 = 폴백. 무조건 warn.
  if (!prev.isLocked) {
    logger.warning(
      `[ClearItemTradeLock] fallback: already unlocked. item=${itemInstanceId}, reason=${String(prev.reason)}`
    );
    return {
      itemInstanceId,
      ownerPlayerId,
      cleared: false,
      previousTradeLock: prev,
      tradeLock: prev,
      writeLock: currentWriteLock ?? null,
    };
  }

  // expectedReason 불일치 처리
  const hasExpected = expectedReason != null;
  const reasonMismatch = hasExpected && String(prev.reason) !== String(expectedReason);

  if (reasonMismatch && !force) {
    logger.warning(
      `[ClearItemTradeLock] fallback: reason mismatch. item=${itemInstanceId}, expected=${expectedReason}, actual=${String(
        prev.reason
      )}`
    );
    return {
      itemInstanceId,
      ownerPlayerId,
      cleared: false,
      previousTradeLock: prev,
      tradeLock: prev,
      writeLock: currentWriteLock ?? null,
    };
  }

  if (reasonMismatch && force) {
    logger.warning(
      `[ClearItemTradeLock] force clear despite reason mismatch. item=${itemInstanceId}, expected=${expectedReason}, actual=${String(
        prev.reason
      )}`
    );
  }

  // 2) mutate unlock
  item.market.tradeLock.isLocked = false;
  item.market.tradeLock.reason = null;
  item.market.tradeLock.until = null;

  if (note != null) {
    if (!item.location || typeof item.location !== "object") {
      logger.warning(`[ClearItemTradeLock] location missing. Creating location object. item=${itemInstanceId}`);
      item.location = { zone: "BAG", note: null };
    }
    item.location.note = String(note);
  }

  // 3) write with conflict check
  const setBody = {
    key: itemInstanceId,
    value: item,
    writeLock: currentWriteLock, // omit 하면 경합 무시됨. 반드시 넣는다.
  };

  const setRes = await cloudSave.setPrivateCustomItem(projectId, inventoryCustomId, setBody);
  const newWriteLock = setRes?.data?.writeLock ?? null;

  return {
    itemInstanceId,
    ownerPlayerId,
    cleared: true,
    previousTradeLock: prev,
    tradeLock: { isLocked: false, reason: null, until: null },
    writeLock: newWriteLock,
  };
};