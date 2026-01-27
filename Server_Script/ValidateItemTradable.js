/**
 * ValidateItemTradable
 *
 * 목적:
 * - GrantItemInstanceToPlayer가 생성/저장한 “Protected Items(=Protected Player Data)” 구조를 기준으로
 *   아이템 인스턴스가 거래 가능한지 검증한다.
 * - 거래소 등록 아이템(escrow)은 “customId 변경” 방식이므로,
 *   인벤(Protected Items)에서 아이템을 제거하고 escrow customId로 옮긴 뒤에도
 *   itemInstanceId(=key) 그대로 유지된다는 전제를 따른다. (id prefix 금지)
 *
 * 저장 위치(조회 기준):
 * - INVENTORY: DataApi.getProtectedItems(projectId, playerId, keys) 로 단건 조회
 *   - key = itemInstanceId (=instanceKey)
 * - ESCROW: DataApi.getPublicCustomItem(marketOwnerPlayerId, escrowCustomId, itemInstanceId) 로 단건 조회
 *   - escrow에는 “에스크로 레코드(랩)” 또는 “아이템 인스턴스 그대로” 둘 다 올 수 있다.
 *     - 랩 형태: { schema, status, itemInstanceId, sellerPlayerId, item: <instance> ... }
 *     - 인스턴스 형태: GrantItemInstanceToPlayer의 instance 그대로
 *
 * 검증 규칙(GrantItemInstanceToPlayer 기준):
 * - instance.schema === 1 필수
 * - instance.instanceId/instanceKey/templateKey/groupKey/kind/slot/tier/rarity/quantity/payload/lifecycle 필드 존재/타입 검사
 * - kind는 allowKinds에 포함 (기본 ["FRAG","EQ"])
 * - market 필드는 Grant 코드에 기본 포함되지 않는다.
 *   - 따라서 requireMarketTradable=false 기본(=market 미존재 허용)
 *   - requireMarketTradable=true일 경우:
 *     - instance.market.tradable === true 필요
 * - tradeLock 필드도 기본 포함되지 않는다.
 *   - 따라서 requireUnlocked=false 기본(=tradeLock 미존재 허용)
 *   - requireUnlocked=true일 경우:
 *     - tradeLock.isLocked !== true 필요
 * - expectedZone은 location.zone 기반 검사인데, Grant 인스턴스에는 location이 없다.
 *   - expectedZone이 null이 아니면, location 누락은 “폴백 금지” 정책상 실패 처리한다.
 * 
 * 폴백/로깅:
 * - 호출 실패/404 등으로 읽기 실패 시: ok=true, tradable=false 반환 + Warning 로그(무음 금지)
 * - storage=ESCROW에서 “랩/인스턴스” 자동 판별 실패 시: Warning 로그 + 실패 반환
 *
 * params (총 10개):
 *  1) itemInstanceId: string (필수)
 *  2) storage: "INVENTORY" | "ESCROW" (선택, 기본 "INVENTORY")
 *  3) playerId: string (선택, INVENTORY일 때만 사용, 기본 context.playerId)
 *  4) inventoryProjectId: string (선택, INVENTORY일 때만 사용, 기본 context.projectId)
 *  5) marketOwnerPlayerId: string (선택, ESCROW일 때만 사용, 기본 "MARKET")
 *  6) escrowCustomId: string (선택, ESCROW일 때만 사용, 기본 "escrow")
 *  7) allowKinds: string[] (선택, 기본 ["FRAG","EQ"])
 *  8) requireMarketTradable: boolean (선택, 기본 false)
 *  9) requireUnlocked: boolean (선택, 기본 false)
 * 10) expectedZone: string|null (선택, 기본 null)
 *
 * return:
 *  - { ok: true, tradable: boolean, storageUsed, keyUsed, details }
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

const E_ValidateTradableFail = Object.freeze({
  OK: "OK",

  NOT_FOUND: "NOT_FOUND",
  LOAD_FAILED: "LOAD_FAILED",

  INVALID_SCHEMA: "INVALID_SCHEMA",
  INVALID_KIND: "INVALID_KIND",

  INVALID_INSTANCE_SHAPE: "INVALID_INSTANCE_SHAPE",

  MARKET_REQUIRED_MISSING: "MARKET_REQUIRED_MISSING",
  NOT_TRADABLE_FLAG: "NOT_TRADABLE_FLAG",

  LOCK_REQUIRED_MISSING: "LOCK_REQUIRED_MISSING",
  LOCKED: "LOCKED",

  LOCATION_REQUIRED_MISSING: "LOCATION_REQUIRED_MISSING",
  WRONG_LOCATION: "WRONG_LOCATION",

  ESCROW_WRAPPER_INVALID: "ESCROW_WRAPPER_INVALID",
});

function _nowIso() {
  return new Date().toISOString();
}

function _isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function _hasOwn(obj, prop) {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, prop);
}

function _asBool(v, def) {
  return (v === undefined) ? def : (v === true);
}

function _validateGrantInstanceShape(inst) {
  if (!_isPlainObject(inst)) return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "instance not object" };
  if (inst.schema !== 1) return { ok: false, failCode: E_ValidateTradableFail.INVALID_SCHEMA, msg: "instance.schema must be 1" };

  // 핵심 필드(Grant 코드 기준)
  if (typeof inst.instanceId !== "string" || inst.instanceId.length === 0) return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "missing instance.instanceId" };
  if (typeof inst.instanceKey !== "string" || inst.instanceKey.length === 0) return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "missing instance.instanceKey" };

  if (typeof inst.templateKey !== "string" || inst.templateKey.length === 0) return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "missing instance.templateKey" };
  if (typeof inst.groupKey !== "string" || inst.groupKey.length === 0) return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "missing instance.groupKey" };

  if (typeof inst.kind !== "string" || inst.kind.length === 0) return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "missing instance.kind" };
  if (typeof inst.slot !== "string" || inst.slot.length === 0) return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "missing instance.slot" };

  if (!Number.isInteger(inst.tier) || inst.tier < 1) return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "instance.tier must be int >=1" };
  if (typeof inst.seq3 !== "string" || inst.seq3.length === 0) return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "missing instance.seq3" };

  if (typeof inst.rarity !== "string" || inst.rarity.length === 0) return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "missing instance.rarity" };
  if (!Number.isInteger(inst.quantity) || inst.quantity < 1) return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "instance.quantity must be int >=1" };

  if (!_isPlainObject(inst.payload)) return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "instance.payload must be object" };

  const lc = inst.lifecycle;
  if (!_isPlainObject(lc)) return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "missing instance.lifecycle" };
  if (typeof lc.createdAt !== "string") return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "missing lifecycle.createdAt" };
  if (typeof lc.updatedAt !== "string") return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "missing lifecycle.updatedAt" };
  if (typeof lc.createdBy !== "string") return { ok: false, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, msg: "missing lifecycle.createdBy" };

  return { ok: true };
}

function _extractInstanceFromEscrowValue(value, logger, itemInstanceId) {
  // 1) 랩 형태
  if (_isPlainObject(value) && _isPlainObject(value.item)) {
    const wId = value.itemInstanceId;
    if (typeof wId === "string" && wId !== itemInstanceId) {
      return {
        ok: false,
        failCode: E_ValidateTradableFail.ESCROW_WRAPPER_INVALID,
        msg: `escrow wrapper itemInstanceId mismatch: ${wId}`,
      };
    }
    return { ok: true, wrapper: value, instance: value.item, wrapperStatus: value.status ?? null };
  }

  // 2) 인스턴스 형태(그대로 저장된 경우)
  if (_isPlainObject(value) && value.schema === 1 && typeof value.instanceId === "string") {
    return { ok: true, wrapper: null, instance: value, wrapperStatus: null };
  }

  logger?.warn?.(
    `[ValidateItemTradable] FALLBACK escrow shape detection failed. itemInstanceId=${itemInstanceId}`
  );
  return { ok: false, failCode: E_ValidateTradableFail.ESCROW_WRAPPER_INVALID, msg: "unknown escrow value shape" };
}

module.exports = async ({ params, context, logger }) => {
  const itemInstanceId = params.itemInstanceId;

  const storage = params.storage ?? "INVENTORY"; // "INVENTORY" | "ESCROW"

  const playerId = params.playerId ?? context.playerId;
  const inventoryProjectId = params.inventoryProjectId ?? context.projectId;

  const marketOwnerPlayerId = params.marketOwnerPlayerId ?? "MARKET";
  const escrowCustomId = params.escrowCustomId ?? "escrow";

  const allowKinds = Array.isArray(params.allowKinds) ? params.allowKinds : ["FRAG", "EQ"];
  const requireMarketTradable = _asBool(params.requireMarketTradable, false);
  const requireUnlocked = _asBool(params.requireUnlocked, false);
  const expectedZone = (params.expectedZone === undefined) ? null : params.expectedZone;

  if (!itemInstanceId) throw new Error("itemInstanceId is required.");

  const nowIso = _nowIso();
  const api = new DataApi(context);

  const keyUsed = itemInstanceId;

  let raw = null;
  let storageUsed = storage;
  let detailsBase = {
    itemInstanceId,
    nowIso,
    storageUsed,
    keyUsed,
  };

  // ---------- 1) 로드 ----------
  if (storage === "ESCROW") {
    try {
      // customId 변경 기반 escrow: Public Custom Item 사용
      const res = await api.getPublicCustomItem(marketOwnerPlayerId, escrowCustomId, keyUsed);
      raw = res?.data?.value ?? null;
    } catch (e) {
      logger?.warn?.(
        `[ValidateItemTradable] ESCROW load failed. marketOwnerPlayerId=${marketOwnerPlayerId}, customId=${escrowCustomId}, key=${keyUsed}, err=${e?.message ?? e}`
      );
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: {
          ...detailsBase,
          failCode: E_ValidateTradableFail.LOAD_FAILED,
          message: "escrow load failed",
          error: e?.message ?? String(e),
        },
      };
    }

    if (!raw) {
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: { ...detailsBase, failCode: E_ValidateTradableFail.NOT_FOUND, message: "escrow item not found" },
      };
    }

    const ex = _extractInstanceFromEscrowValue(raw, logger, itemInstanceId);
    if (!ex.ok) {
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: { ...detailsBase, failCode: ex.failCode, message: ex.msg },
      };
    }

    const instance = ex.instance;

    // ---------- 2) shape 검증(Grant 기준) ----------
    const shape = _validateGrantInstanceShape(instance);
    if (!shape.ok) {
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: { ...detailsBase, failCode: shape.failCode, message: shape.msg, wrapperStatus: ex.wrapperStatus },
      };
    }

    // key/id 일치(Grant 규칙: instanceKey=instanceId=CloudSave key)
    if (instance.instanceKey !== itemInstanceId || instance.instanceId !== itemInstanceId) {
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: {
          ...detailsBase,
          failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE,
          message: `instanceId/instanceKey mismatch. instanceId=${instance.instanceId} instanceKey=${instance.instanceKey}`,
          wrapperStatus: ex.wrapperStatus,
        },
      };
    }

    // kind allow
    if (!allowKinds.includes(instance.kind)) {
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: { ...detailsBase, failCode: E_ValidateTradableFail.INVALID_KIND, message: `invalid kind ${instance.kind}`, kind: instance.kind },
      };
    }

    // market/tradeLock (기본은 미요구)
    // market/tradeLock
    if (requireMarketTradable) {
      if (!_hasOwn(instance, "market") || instance.market == null) {
        return {
          ok: true,
          tradable: false,
          storageUsed,
          keyUsed,
          details: { ...detailsBase, failCode: E_ValidateTradableFail.MARKET_REQUIRED_MISSING, message: "market required but missing" },
        };
      }

      const m = instance.market;
      if (!_isPlainObject(m)) {
        return {
          ok: true,
          tradable: false,
          storageUsed,
          keyUsed,
          details: { ...detailsBase, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, message: "instance.market must be a non-null object" },
        };
      }

      if (m.tradable !== true) {
        return {
          ok: true,
          tradable: false,
          storageUsed,
          keyUsed,
          details: { ...detailsBase, failCode: E_ValidateTradableFail.NOT_TRADABLE_FLAG, message: "market.tradable is false" },
        };
      }
    }

    if (requireUnlocked) {
      if (!_hasOwn(instance, "market") || instance.market == null) {
        return {
          ok: true,
          tradable: false,
          storageUsed,
          keyUsed,
          details: { ...detailsBase, failCode: E_ValidateTradableFail.MARKET_REQUIRED_MISSING, message: "market required for tradeLock but missing" },
        };
      }

      const m = instance.market;
      if (!_isPlainObject(m)) {
        return {
          ok: true,
          tradable: false,
          storageUsed,
          keyUsed,
          details: { ...detailsBase, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, message: "instance.market must be a non-null object" },
        };
      }

      if (!_hasOwn(m, "tradeLock") || m.tradeLock == null) {
        return {
          ok: true,
          tradable: false,
          storageUsed,
          keyUsed,
          details: { ...detailsBase, failCode: E_ValidateTradableFail.LOCK_REQUIRED_MISSING, message: "tradeLock required but missing" },
        };
      }

      const tl = m.tradeLock;
      if (!_isPlainObject(tl) || typeof tl.isLocked !== "boolean") {
        return {
          ok: true,
          tradable: false,
          storageUsed,
          keyUsed,
          details: { ...detailsBase, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, message: "tradeLock must be a non-null object with boolean isLocked" },
        };
      }

      if (tl.isLocked === true) {
        return {
          ok: true,
          tradable: false,
          storageUsed,
          keyUsed,
          details: { ...detailsBase, failCode: E_ValidateTradableFail.LOCKED, message: `locked reason=${tl.reason}`, tradeLock: tl },
        };
      }
    }
    if (expectedZone !== null) {
      const zone = instance.location?.zone ?? null;
      if (zone === null) {
        return {
          ok: true,
          tradable: false,
          storageUsed,
          keyUsed,
          details: { ...detailsBase, failCode: E_ValidateTradableFail.LOCATION_REQUIRED_MISSING, message: "expectedZone set but instance.location.zone missing" },
        };
      }
      if (zone !== expectedZone) {
        return {
          ok: true,
          tradable: false,
          storageUsed,
          keyUsed,
          details: { ...detailsBase, failCode: E_ValidateTradableFail.WRONG_LOCATION, message: `zone=${zone} expected=${expectedZone}`, zone, expectedZone },
        };
      }
    }

    return {
      ok: true,
      tradable: true,
      storageUsed,
      keyUsed,
      details: {
        ...detailsBase,
        kind: instance.kind,
        slot: instance.slot,
        tier: instance.tier,
        rarity: instance.rarity,
        groupKey: instance.groupKey,
        templateKey: instance.templateKey,
        wrapperStatus: ex.wrapperStatus,
      },
    };
  }

  // ---------- INVENTORY (Protected Items) ----------
  storageUsed = "INVENTORY";
  detailsBase.storageUsed = storageUsed;

  if (!playerId) throw new Error("playerId is required for INVENTORY (params.playerId or context.playerId).");
  if (!inventoryProjectId) throw new Error("inventoryProjectId is required (params.inventoryProjectId or context.projectId).");

  try {
    const res = await api.getProtectedItems(inventoryProjectId, playerId, [keyUsed]);
    const items = res?.data?.results ?? [];
    if (Array.isArray(items) && items.length > 0) {
      // results: [{ key, value, writeLock, modifiedAt ... }]
      raw = items[0]?.value ?? null;
    } else {
      raw = null;
    }
  } catch (e) {
    logger?.warn?.(
      `[ValidateItemTradable] INVENTORY load failed. projectId=${inventoryProjectId}, playerId=${playerId}, key=${keyUsed}, err=${e?.message ?? e}`
    );
    return {
      ok: true,
      tradable: false,
      storageUsed,
      keyUsed,
      details: {
        ...detailsBase,
        failCode: E_ValidateTradableFail.LOAD_FAILED,
        message: "inventory load failed",
        error: e?.message ?? String(e),
      },
    };
  }

  if (!raw) {
    return {
      ok: true,
      tradable: false,
      storageUsed,
      keyUsed,
      details: { ...detailsBase, failCode: E_ValidateTradableFail.NOT_FOUND, message: "inventory item not found", playerId },
    };
  }

  const instance = raw;

  const shape = _validateGrantInstanceShape(instance);
  if (!shape.ok) {
    return {
      ok: true,
      tradable: false,
      storageUsed,
      keyUsed,
      details: { ...detailsBase, failCode: shape.failCode, message: shape.msg, playerId },
    };
  }

  if (instance.instanceKey !== itemInstanceId || instance.instanceId !== itemInstanceId) {
    return {
      ok: true,
      tradable: false,
      storageUsed,
      keyUsed,
      details: {
        ...detailsBase,
        failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE,
        message: `instanceId/instanceKey mismatch. instanceId=${instance.instanceId} instanceKey=${instance.instanceKey}`,
        playerId,
      },
    };
  }

  if (!allowKinds.includes(instance.kind)) {
    return {
      ok: true,
      tradable: false,
      storageUsed,
      keyUsed,
      details: { ...detailsBase, failCode: E_ValidateTradableFail.INVALID_KIND, message: `invalid kind ${instance.kind}`, kind: instance.kind, playerId },
    };
  }
  // market/tradeLock
  if (requireMarketTradable) {
    if (!_hasOwn(instance, "market") || instance.market == null) {
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: { ...detailsBase, failCode: E_ValidateTradableFail.MARKET_REQUIRED_MISSING, message: "market required but missing" },
      };
    }

    const m = instance.market;
    if (!_isPlainObject(m)) {
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: { ...detailsBase, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, message: "instance.market must be a non-null object" },
      };
    }

    if (m.tradable !== true) {
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: { ...detailsBase, failCode: E_ValidateTradableFail.NOT_TRADABLE_FLAG, message: "market.tradable is false" },
      };
    }
  }

  if (requireUnlocked) {
    if (!_hasOwn(instance, "market") || instance.market == null) {
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: { ...detailsBase, failCode: E_ValidateTradableFail.MARKET_REQUIRED_MISSING, message: "market required for tradeLock but missing" },
      };
    }

    const m = instance.market;
    if (!_isPlainObject(m)) {
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: { ...detailsBase, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, message: "instance.market must be a non-null object" },
      };
    }

    if (!_hasOwn(m, "tradeLock") || m.tradeLock == null) {
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: { ...detailsBase, failCode: E_ValidateTradableFail.LOCK_REQUIRED_MISSING, message: "tradeLock required but missing" },
      };
    }

    const tl = m.tradeLock;
    if (!_isPlainObject(tl) || typeof tl.isLocked !== "boolean") {
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: { ...detailsBase, failCode: E_ValidateTradableFail.INVALID_INSTANCE_SHAPE, message: "tradeLock must be a non-null object with boolean isLocked" },
      };
    }

    if (tl.isLocked === true) {
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: { ...detailsBase, failCode: E_ValidateTradableFail.LOCKED, message: `locked reason=${tl.reason}`, tradeLock: tl },
      };
    }
  }

  if (expectedZone !== null) {
    const zone = instance.location?.zone ?? null;
    if (zone === null) {
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: { ...detailsBase, failCode: E_ValidateTradableFail.LOCATION_REQUIRED_MISSING, message: "expectedZone set but instance.location.zone missing", playerId },
      };
    }
    if (zone !== expectedZone) {
      return {
        ok: true,
        tradable: false,
        storageUsed,
        keyUsed,
        details: { ...detailsBase, failCode: E_ValidateTradableFail.WRONG_LOCATION, message: `zone=${zone} expected=${expectedZone}`, zone, expectedZone, playerId },
      };
    }
  }

  return {
    ok: true,
    tradable: true,
    storageUsed,
    keyUsed,
    details: {
      ...detailsBase,
      playerId,
      kind: instance.kind,
      slot: instance.slot,
      tier: instance.tier,
      rarity: instance.rarity,
      groupKey: instance.groupKey,
      templateKey: instance.templateKey,
    },
  };
};