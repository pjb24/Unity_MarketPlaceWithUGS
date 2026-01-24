/**
 * SetItemTradeLock
 *
 * 목적:
 * - 인벤(Private Custom Item, 저장된 아이템(FRAG/EQ)의
 *   market.tradeLock 을 서버 권한으로 설정/해제한다.
 * - writeLock 기반 충돌 체크를 수행한다(경합 방지).
 *
 * 저장 위치(기본):
 * - getPrivateCustomItems / setPrivateCustomItem 사용
 *
 * params:
 *  - itemInstanceId: string (필수)
 *  - isLocked: boolean (필수)
 *  - reason: string | null (잠금 시 필수, 해제 시 null 권장)
 *  - until: string | null (ISO8601, 선택. 잠금 시 자동해제 시각)
 *  - note: string | null (선택. location.note에 운영/디버그 메모 기록)
 *  - ownerPlayerId: string (선택, 기본 context.playerId)
 *  - inventoryCustomId: string (선택, 기본 "inventory")
 *
 * return:
 *  - itemInstanceId, ownerPlayerId, tradeLock, writeLock
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

function _assertNonEmptyString(name, v) {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
}

function _isValidIsoDateString(s) {
  if (s == null) return true;
  if (typeof s !== "string") return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
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
    isLocked,
    reason = null,
    until = null,
    note = null,
    ownerPlayerId = context.playerId,
    inventoryCustomId = "inventory",
  } = params ?? {};

  _assertNonEmptyString("itemInstanceId", itemInstanceId);
  _assertNonEmptyString("ownerPlayerId", ownerPlayerId);
  _assertCustomId(inventoryCustomId);

  if (typeof isLocked !== "boolean") {
    throw new Error("isLocked must be boolean");
  }

  if (isLocked) {
    _assertNonEmptyString("reason", reason);
    if (!_isValidIsoDateString(until)) {
      throw new Error("until must be ISO8601 string or null");
    }
  } else {
    if (until != null) {
      logger?.warn?.(`[SetItemTradeLock] unlock requested but until provided. Ignoring until. item=${itemInstanceId}`);
    }
  }

  // Cloud Code server-to-service auth
  const cloudSave = new DataApi(context);
  const projectId = context.projectId;

  // 1) read with writeLock (via getPrivateCustomItems)
  // getPrivateCustomItems(projectId, customId, keys?, after?)
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
    logger?.warn?.(`[SetItemTradeLock] market missing. Creating market object. item=${itemInstanceId}`);
    item.market = {};
  }
  if (!item.market.tradeLock || typeof item.market.tradeLock !== "object") {
    logger?.warn?.(`[SetItemTradeLock] market.tradeLock missing. Creating tradeLock object. item=${itemInstanceId}`);
    item.market.tradeLock = { isLocked: false, reason: null, until: null };
  }

  // 2) mutate
  item.market.tradeLock.isLocked = isLocked;
  item.market.tradeLock.reason = isLocked ? reason : null;
  item.market.tradeLock.until = isLocked ? (until ?? null) : null;

  if (note != null) {
    if (!item.location || typeof item.location !== "object") {
      logger?.warn?.(`[SetItemTradeLock] location missing. Creating location object. item=${itemInstanceId}`);
      item.location = { zone: "BAG", note: null };
    }
    item.location.note = String(note);
  }

  // 3) write back with conflict check
  // setPrivateCustomItem(projectId, customId, setItemBody)
  // setItemBody: { key, value, writeLock? }
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
    tradeLock: item.market.tradeLock,
    writeLock: newWriteLock,
  };
};