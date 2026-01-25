/**
 * ValidateItemTradable
 * - 아이템 인스턴스가 거래소에 "등록/구매/이동" 가능한지 서버에서 검증한다.
 * - 클라 신뢰 금지.
 *
 * 입력 params:
 *  - itemInstanceId: string (필수)
 *  - playerId: string (선택) 기본: context.playerId
 *  - expectedZone: "BAG" | "EQUIPPED" | "MARKET_ESCROW" | "STORAGE" | null (선택) 기본: "BAG"
 *  - allowKinds: string[] (선택) 기본: ["FRAG","EQ"]
 *  - inventoryCustomId: string (선택) 기본: "inventory"
 *  - inventoryKey: string (선택) 기본: itemInstanceId
 *  - inventoryContainerKey: string (선택) 기본: null
 *      - 아이템을 단건 키로 저장하지 않고, 컨테이너(예: key="items")에 배열/맵으로 저장한 경우에만 사용.
 *
 * 반환:
 *  - { ok: true, tradable: boolean, reasonCode: string|null, details: object }
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

const E_TradeValidateReason = Object.freeze({
  OK: "OK",

  NOT_FOUND: "NOT_FOUND",
  INVALID_SCHEMA: "INVALID_SCHEMA",
  INVALID_KIND: "INVALID_KIND",

  NOT_TRADABLE_FLAG: "NOT_TRADABLE_FLAG",

  LOCKED: "LOCKED",
  LOCKED_UNTIL: "LOCKED_UNTIL",

  WRONG_LOCATION: "WRONG_LOCATION",
  EQUIPPED_LOCK: "EQUIPPED_LOCK",

  MALFORMED_MARKET: "MALFORMED_MARKET",
});

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

  const dataApi = new DataApi(context);
  const projectId = context.projectId;

  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  // ---- 1) 아이템 로드 (단건 키 우선, 컨테이너 폴백) ----
  let item = null;
  let loadPath = null;

  // (A) 단건 키로 저장된 경우: key == itemInstanceId (권장)
  try {
    const res = await dataApi.getPrivateCustomItem(projectId, inventoryCustomId, [inventoryKey]);
    item = res?.data?.results?.[0]?.value ?? null;
    loadPath = `privateCustomItems:${inventoryCustomId}/${inventoryKey}`;
  } catch (e) {
    // 폴백 시도
    logger.warning(
      `[ValidateItemTradable] primary load failed. fallback will run. playerId=${playerId}, customId=${inventoryCustomId}, key=${inventoryKey}, err=${e?.message ?? e}`
    );
  }

  // (B) 컨테이너 키(예: key="items") 안에 배열/맵으로 저장된 경우 폴백
  if (!item && inventoryContainerKey) {
    try {
      const res = await dataApi.getPrivateCustomItem(projectId, inventoryCustomId, [inventoryContainerKey]);
      const container = res?.data?.results?.[0]?.value;

      if (Array.isArray(container)) {
        item = container.find(x => x?.instanceId === itemInstanceId || x?.id === itemInstanceId) ?? null;
      } else if (container && typeof container === "object") {
        item = container[itemInstanceId] ?? null;
      }

      loadPath = `privateCustomItemContainer:${inventoryCustomId}/${inventoryContainerKey}`;
      logger.warning(
        `[ValidateItemTradable] fallback container load used. playerId=${playerId}, customId=${inventoryCustomId}, containerKey=${inventoryContainerKey}, itemInstanceId=${itemInstanceId}`
      );
    } catch (e) {
      // 폴백도 실패
      logger.warning(
        `[ValidateItemTradable] fallback container load failed. playerId=${playerId}, customId=${inventoryCustomId}, containerKey=${inventoryContainerKey}, err=${e?.message ?? e}`
      );
    }
  }

  if (!item) {
    return {
      ok: true,
      tradable: false,
      reasonCode: E_TradeValidateReason.NOT_FOUND,
      details: { playerId, itemInstanceId, loadedFrom: loadPath, nowIso },
    };
  }

  // ---- 2) 최소 필드 정규화 ----
  const kind = item.kind;
  if (!kind || typeof kind !== "string") {
    return {
      ok: true,
      tradable: false,
      reasonCode: E_TradeValidateReason.INVALID_SCHEMA,
      details: { playerId, itemInstanceId, loadedFrom: loadPath, nowIso, hint: "missing item.kind" },
    };
  }

  if (!allowKinds.includes(kind)) {
    return {
      ok: true,
      tradable: false,
      reasonCode: E_TradeValidateReason.INVALID_KIND,
      details: { playerId, itemInstanceId, kind, allowKinds, loadedFrom: loadPath, nowIso },
    };
  }

  // FRAG 정의에는 location이 없을 수 있다. 그 경우 BAG로 간주(폴백) + Warning 로그.
  let zone = item?.location?.zone ?? null;
  if (!zone) {
    zone = "BAG";
    logger.warning(
      `[ValidateItemTradable] item.location.zone missing. fallback zone=BAG applied. playerId=${playerId}, itemInstanceId=${itemInstanceId}, kind=${kind}`
    );
  }

  const market = item.market;
  if (!market || typeof market !== "object") {
    return {
      ok: true,
      tradable: false,
      reasonCode: E_TradeValidateReason.MALFORMED_MARKET,
      details: { playerId, itemInstanceId, kind, zone, loadedFrom: loadPath, nowIso, hint: "missing item.market" },
    };
  }

  const tradableFlag = market.tradable === true;
  const tradeLock = market.tradeLock ?? { isLocked: false, reason: null, until: null };

  // ---- 3) 룰 체크 ----
  // 3-1) 위치 체크
  if (expectedZone !== null && zone !== expectedZone) {
    return {
      ok: true,
      tradable: false,
      reasonCode: E_TradeValidateReason.WRONG_LOCATION,
      details: { playerId, itemInstanceId, kind, zone, expectedZone, loadedFrom: loadPath, nowIso },
    };
  }

  // 3-2) 장비 착용 상태 거래 금지
  if (kind === "EQ" && zone === "EQUIPPED") {
    return {
      ok: true,
      tradable: false,
      reasonCode: E_TradeValidateReason.EQUIPPED_LOCK,
      details: { playerId, itemInstanceId, kind, zone, loadedFrom: loadPath, nowIso },
    };
  }

  // 3-3) tradable 플래그
  if (!tradableFlag) {
    return {
      ok: true,
      tradable: false,
      reasonCode: E_TradeValidateReason.NOT_TRADABLE_FLAG,
      details: { playerId, itemInstanceId, kind, zone, loadedFrom: loadPath, nowIso },
    };
  }

  // 3-4) tradeLock
  if (tradeLock?.isLocked === true) {
    // until이 있고 이미 지났으면 "잠금 만료됨" 상태인데 isLocked가 true로 남아있는 데이터 오염이다.
    // 여기서 조용히 풀지 않는다. 폴백 처리 대신 Warning 로그 + 차단(운영/복구 경로로 정리).
    const untilIso = tradeLock.until;
    if (untilIso) {
      const untilMs = Date.parse(untilIso);
      if (!Number.isNaN(untilMs) && untilMs <= nowMs) {
        logger.warning(
          `[ValidateItemTradable] tradeLock expired but still locked. blocked. playerId=${playerId}, itemInstanceId=${itemInstanceId}, until=${untilIso}, now=${nowIso}, reason=${tradeLock.reason}`
        );
        return {
          ok: true,
          tradable: false,
          reasonCode: E_TradeValidateReason.LOCKED_UNTIL,
          details: { playerId, itemInstanceId, kind, zone, tradeLock, nowIso },
        };
      }
    }

    return {
      ok: true,
      tradable: false,
      reasonCode: E_TradeValidateReason.LOCKED,
      details: { playerId, itemInstanceId, kind, zone, tradeLock, nowIso },
    };
  }

  // ---- OK ----
  return {
    ok: true,
    tradable: true,
    reasonCode: null,
    details: {
      playerId,
      itemInstanceId,
      kind,
      zone,
      loadedFrom: loadPath,
      nowIso,
      market: {
        tradable: true,
        tradeLock: { isLocked: false },
      },
    },
  };
};
