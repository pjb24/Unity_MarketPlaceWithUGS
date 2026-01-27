/**
 * MoveItemToEscrow
 * - 판매 등록 시 아이템을 에스크로로 이동시키고, tradeLock을 건다.
 *  - location=MARKET_ESCROW
 *  - tradeLock.reason=ESCROW
 *  - tradeLock.until=... (선택)
 * - 클라 신뢰 금지. 서버에서 검증 후 상태 변경.
 *
 * - 동작: (1) 아이템 로드 → (2) 거래 가능 검증
 *   → (3) location.zone=MARKET_ESCROW + market.tradeLock 잠금
 *   → (4) 저장 후 재조회 검증.
 *
 * params:
 *  - itemInstanceId: string (필수)
 *  - playerId: string (선택) 기본 context.playerId
 *
 *  - expectedZone: "BAG" | "EQUIPPED" | "MARKET_ESCROW" | "STORAGE" | null (선택) 기본 "BAG"
 *  - allowKinds: string[] (선택) 기본 ["FRAG","EQ"]
 *
 *  - inventoryCustomId: string (선택) 기본 "inventory"
 *  - inventoryKey: string (선택) 기본 itemInstanceId
 *  - inventoryContainerKey: string|null (선택) 기본 null
 *    - 단건 키로 저장하지 않고 컨테이너(예: key="items") 안에 배열/맵이면 사용
 *
 *  - listingId: string (선택) 에스크로 사유에 참고(로그/디버그용)
 *  - lockUntilIso: string|null (선택) tradeLock.until (만료시간 등)
 *  - lockReason: string (선택) 기본 "ESCROW"
 *
 * return:
 *  - { ok: true, moved: boolean, item: object|null, details: object }
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

const E_EscrowMoveFail = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  INVALID_SCHEMA: "INVALID_SCHEMA",
  INVALID_KIND: "INVALID_KIND",
  MALFORMED_MARKET: "MALFORMED_MARKET",

  NOT_TRADABLE_FLAG: "NOT_TRADABLE_FLAG",
  LOCKED: "LOCKED",
  WRONG_LOCATION: "WRONG_LOCATION",
  EQUIPPED_LOCK: "EQUIPPED_LOCK",

  WRITE_FAILED: "WRITE_FAILED",
  VERIFY_FAILED: "VERIFY_FAILED",
});

function _nowIso() {
  return new Date().toISOString();
}

function _clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function _getZoneWithFallback(item, logger, playerId, itemInstanceId) {
  let zone = item?.location?.zone ?? null;
  if (!zone) {
    zone = "BAG";
    logger.warning(
      `[MoveItemToEscrow] item.location.zone missing. fallback zone=BAG applied. playerId=${playerId}, itemInstanceId=${itemInstanceId}`
    );
  }
  return zone;
}

function _validateTradableOrThrow({ item, kind, zone, expectedZone, allowKinds }) {
  if (!kind || typeof kind !== "string") {
    return { ok: false, code: E_EscrowMoveFail.INVALID_SCHEMA, msg: "missing item.kind" };
  }
  if (!allowKinds.includes(kind)) {
    return { ok: false, code: E_EscrowMoveFail.INVALID_KIND, msg: `invalid kind ${kind}` };
  }

  const market = item.market;
  if (!market || typeof market !== "object") {
    return { ok: false, code: E_EscrowMoveFail.MALFORMED_MARKET, msg: "missing item.market" };
  }

  if (expectedZone !== null && zone !== expectedZone) {
    return { ok: false, code: E_EscrowMoveFail.WRONG_LOCATION, msg: `zone=${zone} expected=${expectedZone}` };
  }

  if (kind === "EQ" && zone === "EQUIPPED") {
    return { ok: false, code: E_EscrowMoveFail.EQUIPPED_LOCK, msg: "equipped items cannot be escrowed" };
  }

  if (market.tradable !== true) {
    return { ok: false, code: E_EscrowMoveFail.NOT_TRADABLE_FLAG, msg: "market.tradable is false" };
  }

  const tradeLock = market.tradeLock ?? { isLocked: false, reason: null, until: null };
  if (tradeLock.isLocked === true) {
    return { ok: false, code: E_EscrowMoveFail.LOCKED, msg: `already locked reason=${tradeLock.reason}` };
  }

  return { ok: true, code: null, msg: null };
}

module.exports = async ({ params, context, logger }) => {
  const playerId = params.playerId ?? context.playerId;
  if (!playerId) throw new Error("playerId is required (params.playerId or context.playerId).");

  const itemInstanceId = params.itemInstanceId;
  if (!itemInstanceId) throw new Error("itemInstanceId is required.");

  const expectedZone = (params.expectedZone === undefined) ? "BAG" : params.expectedZone; // null 허용
  const allowKinds = Array.isArray(params.allowKinds) ? params.allowKinds : ["FRAG", "EQ"];

  const inventoryCustomId = params.inventoryCustomId ?? "inventory";
  const inventoryKey = params.inventoryKey ?? itemInstanceId;
  const inventoryContainerKey = params.inventoryContainerKey ?? null;

  const listingId = params.listingId ?? null;
  const lockUntilIso = (params.lockUntilIso === undefined) ? null : params.lockUntilIso;
  const lockReason = params.lockReason ?? "ESCROW";

  const dataApi = new DataApi(context);
  const projectId = context.projectId;

  const nowIso = _nowIso();

  // ---------- 1) 아이템 로드 (단건 키 → 컨테이너 폴백) ----------
  let item = null;
  let loadPath = null;
  let itemWriteLock = null;
  let containerWriteLock = null;

  try {
    const res = await dataApi.getPrivateCustomItems(projectId, inventoryCustomId, [inventoryKey]);
    const row = res?.data?.results?.[0];
    item = row?.value ?? null;
    itemWriteLock = row?.writeLock ?? null;
    loadPath = `privateCustomItem:${inventoryCustomId}/${inventoryKey}`;
  } catch (e) {
    logger.warning(
      `[MoveItemToEscrow] primary load failed. fallback will run. playerId=${playerId}, customId=${inventoryCustomId}, key=${inventoryKey}, err=${e?.message ?? e}`
    );
  }

  let container = null;
  if (!item && inventoryContainerKey) {
    try {
      const res = await dataApi.getPrivateCustomItems(projectId, inventoryCustomId, [inventoryContainerKey]);
      const row = res?.data?.results?.[0];
      container = row?.value ?? null;
      containerWriteLock = row?.writeLock ?? null;
      loadPath = `privateCustomItemContainer:${inventoryCustomId}/${inventoryContainerKey}`;

      if (Array.isArray(container)) {
        item = container.find(x => x?.instanceId === itemInstanceId || x?.id === itemInstanceId) ?? null;
      } else if (container && typeof container === "object") {
        item = container[itemInstanceId] ?? null;
      }

      logger.warning(
        `[MoveItemToEscrow] fallback container load used. playerId=${playerId}, customId=${inventoryCustomId}, containerKey=${inventoryContainerKey}, itemInstanceId=${itemInstanceId}`
      );
    } catch (e) {
      logger.warning(
        `[MoveItemToEscrow] fallback container load failed. playerId=${playerId}, customId=${inventoryCustomId}, containerKey=${inventoryContainerKey}, err=${e?.message ?? e}`
      );
    }
  }

  if (!item) {
    return {
      ok: true,
      moved: false,
      item: null,
      details: { failCode: E_EscrowMoveFail.NOT_FOUND, playerId, itemInstanceId, loadedFrom: loadPath, nowIso },
    };
  }

  // ---------- 2) 검증 ----------
  const kind = item.kind;
  const zone = _getZoneWithFallback(item, logger, playerId, itemInstanceId);

  const valid = _validateTradableOrThrow({
    item,
    kind,
    zone,
    expectedZone,
    allowKinds,
  });

  if (!valid.ok) {
    return {
      ok: true,
      moved: false,
      item: null,
      details: {
        failCode: valid.code,
        message: valid.msg,
        playerId,
        itemInstanceId,
        kind,
        zone,
        expectedZone,
        loadedFrom: loadPath,
        nowIso,
      },
    };
  }

  // ---------- 3) 상태 변경(에스크로 + 락) ----------
  const next = _clone(item);

  // location
  next.location = next.location && typeof next.location === "object" ? next.location : {};
  next.location.zone = "MARKET_ESCROW";
  next.location.updatedAt = nowIso;

  // market + tradeLock
  next.market = next.market && typeof next.market === "object" ? next.market : { tradable: true };
  next.market.tradeLock = {
    isLocked: true,
    reason: listingId ? `${lockReason}_LISTING_${listingId}` : lockReason,
    until: lockUntilIso ?? null,
  };

  // lifecycle
  next.lifecycle = next.lifecycle && typeof next.lifecycle === "object" ? next.lifecycle : {};
  next.lifecycle.updatedAt = nowIso;

  // ---------- 4) 저장 ----------
  try {
    if (!inventoryContainerKey) {
      // 단건 키 저장
      await dataApi.setPrivateCustomItem(projectId, inventoryCustomId, {
        key: inventoryKey,
        value: next,
        ...DataApi(itemWriteLock ? { writeLock: itemWriteLock } : {}),
      });
    } else {
      // 컨테이너 저장(컨테이너 형태 유지)
      if (!container) {
        // 여기 오면 로드 로직이 꼬인 것. 무음 처리 금지.
        logger.warning(
          `[MoveItemToEscrow] container write requested but container is null. blocked. playerId=${playerId}, itemInstanceId=${itemInstanceId}`
        );
        return {
          ok: true,
          moved: false,
          item: null,
          details: {
            failCode: E_EscrowMoveFail.WRITE_FAILED,
            message: "container is null (cannot write)",
            playerId,
            itemInstanceId,
            nowIso,
          },
        };
      }

      const nextContainer = _clone(container);
      if (Array.isArray(nextContainer)) {
        const idx = nextContainer.findIndex(x => x?.instanceId === itemInstanceId || x?.id === itemInstanceId);
        if (idx < 0) {
          return {
            ok: true,
            moved: false,
            item: null,
            details: { failCode: E_EscrowMoveFail.NOT_FOUND, message: "not found in container", playerId, itemInstanceId, nowIso },
          };
        }
        nextContainer[idx] = next;
      } else if (nextContainer && typeof nextContainer === "object") {
        if (!nextContainer[itemInstanceId]) {
          return {
            ok: true,
            moved: false,
            item: null,
            details: { failCode: E_EscrowMoveFail.NOT_FOUND, message: "not found in container map", playerId, itemInstanceId, nowIso },
          };
        }
        nextContainer[itemInstanceId] = next;
      } else {
        return {
          ok: true,
          moved: false,
          item: null,
          details: { failCode: E_EscrowMoveFail.INVALID_SCHEMA, message: "container is not array/object", playerId, itemInstanceId, nowIso },
        };
      }

      await dataApi.setPrivateCustomItem(projectId, inventoryCustomId, {
        key: inventoryContainerKey,
        value: nextContainer,
        ...(containerWriteLock ? { writeLock: containerWriteLock } : {}),
      });
      logger.warning(
        `[MoveItemToEscrow] container write used (non-ideal). playerId=${playerId}, containerKey=${inventoryContainerKey}, itemInstanceId=${itemInstanceId}`
      );
    }
  } catch (e) {
    logger.warning(
      `[MoveItemToEscrow] write failed. playerId=${playerId}, itemInstanceId=${itemInstanceId}, err=${e?.message ?? e}`
    );
    return {
      ok: true,
      moved: false,
      item: null,
      details: { failCode: E_EscrowMoveFail.WRITE_FAILED, playerId, itemInstanceId, nowIso, error: e?.message ?? String(e) },
    };
  }

  // ---------- 5) 재조회 검증(무조건) ----------
  try {
    let verifyItem = null;

    if (!inventoryContainerKey) {
      const res = await dataApi.getPrivateCustomItems(projectId, inventoryCustomId, [inventoryKey]);
      verifyItem = res?.data?.results?.[0]?.value ?? null;
    } else {
      const res = await dataApi.getPrivateCustomItems(projectId, inventoryCustomId, [inventoryContainerKey]);
      const verifyContainer = res?.data?.results?.[0]?.value ?? null;
      if (Array.isArray(verifyContainer)) {
        verifyItem = verifyContainer.find(x => x?.instanceId === itemInstanceId || x?.id === itemInstanceId) ?? null;
      } else if (verifyContainer && typeof verifyContainer === "object") {
        verifyItem = verifyContainer[itemInstanceId] ?? null;
      }
    }

    const vz = verifyItem?.location?.zone ?? null;
    const locked = verifyItem?.market?.tradeLock?.isLocked === true;

    if (vz !== "MARKET_ESCROW" || !locked) {
      logger.warning(
        `[MoveItemToEscrow] verify failed. playerId=${playerId}, itemInstanceId=${itemInstanceId}, zone=${vz}, locked=${locked}`
      );
      return {
        ok: true,
        moved: false,
        item: null,
        details: { failCode: E_EscrowMoveFail.VERIFY_FAILED, playerId, itemInstanceId, nowIso, zone: vz, locked },
      };
    }

    return {
      ok: true,
      moved: true,
      item: verifyItem,
      details: { playerId, itemInstanceId, nowIso, listingId, loadedFrom: loadPath },
    };
  } catch (e) {
    logger.warning(
      `[MoveItemToEscrow] verify read failed. playerId=${playerId}, itemInstanceId=${itemInstanceId}, err=${e?.message ?? e}`
    );
    return {
      ok: true,
      moved: false,
      item: null,
      details: { failCode: E_EscrowMoveFail.VERIFY_FAILED, playerId, itemInstanceId, nowIso, error: e?.message ?? String(e) },
    };
  }
};