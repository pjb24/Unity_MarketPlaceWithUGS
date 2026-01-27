/**
 * GetInventorySnapshot (GrantItemInstanceToPlayer 호환 버전)
 *
 * 목적:
 * - GrantItemInstanceToPlayer가 저장한 “인스턴스(키=instanceId)”와 “인덱스(IDX_*)”를 기반으로
 *   플레이어 인벤 스냅샷을 반환한다.
 * - 원본 인스턴스 배열 + 거래소 검증용 최소 필드(view) + 안정 해시(snapshotHash)를 제공한다.
 *
 * 저장 위치:
 * - Cloud Save v1.4 DataApi “Protected Player Data” (projectId, playerId 스코프)
 *
 * key 규칙:
 * - 인스턴스 key: instanceId 그대로 (예: "1700000000000_123456789")
 * - 인덱스 key:
 *   - "IDX_ALL"
 *   - "IDX_<groupKey>"  (groupKey = <kind>_<slot>_T<tier>)
 *
 * groupKey 규칙:
 * - groupKey = <kind>_<slot>_T<tier> (예: FRAG_WPN_T1, EQ_ARM_T3)
 *
 * 인덱스 규칙:
 * - 인덱스 value: { keys: string[] }
 * - keys 배열에는 인스턴스 key(=instanceId)를 저장한다.
 * - 중복은 없어야 하지만, 스냅샷에서는 방어적으로 de-dupe 한다(폴백 발생 시 Warning 로그).
 *
 * 에러·폴백 규칙:
 * - 인덱스 키가 없거나 형식이 깨졌으면 Warning 로그 + 빈 결과 반환 (무음 금지)
 * - 인덱스에 있는데 인스턴스가 없으면 Warning 로그 (데이터 불일치)
 * - getProtectedItems 실패는 그대로 throw (서버 문제)
 *
 * params (<= 10):
 * 1) groupKey: string (선택) 예: "FRAG_WPN_T1"  // 있으면 IDX_<groupKey> 사용
 * 2) kind: "FRAG" | "EQ" (선택)  // groupKey 없을 때만 사용
 * 3) slot: "WPN" | "ARM" | "ACC" (선택) // kind와 같이 사용
 * 4) tier: number (선택) // kind/slot과 같이 사용
 * 5) maxItems: number (선택, 기본 5000) // 과대 데이터 방어, 초과 시 Warning + truncate
 * 6) maxKeysPerRequest: number (선택, 기본 100) // getProtectedItems keys 배열 분할
 * 7) includeRaw: boolean (선택, 기본 true) // snapshot.instances 포함 여부
 *
 * return:
 * - indexKeyUsed
 * - instanceKeys (선택된 키들, maxItems 반영)
 * - snapshot.instances (선택)
 * - view.instances (최소 필드)
 * - counts
 * - snapshotHash32, snapshotHashHex
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

const IDX_ALL = "IDX_ALL";
const DEFAULT_MAX_ITEMS = 5000;
const DEFAULT_MAX_KEYS_PER_REQUEST = 100;

const E_KIND = Object.freeze({ FRAG: "FRAG", EQ: "EQ" });
const E_SLOT = Object.freeze({ WPN: "WPN", ARM: "ARM", ACC: "ACC" });

function _nowIso() {
  return new Date().toISOString();
}

function _asBool(v, fallback) {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  return fallback;
}

function _asInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function _isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function _isEnumKey(v, enumObj) {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(enumObj, v);
}

/** FNV-1a 32bit (crypto 없이) */
function _fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function _toHex32(u32) {
  return (u32 >>> 0).toString(16).padStart(8, "0");
}

/** stable stringify (object key sort) */
function _stableStringify(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number" || t === "boolean") return String(value);
  if (t === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return "[" + value.map(_stableStringify).join(",") + "]";
  }

  if (_isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + _stableStringify(value[k])).join(",") + "}";
  }

  return "null";
}

function _normalizeIndex(raw, logger, indexKey) {
  if (raw == null) return { keys: [] };
  if (!_isPlainObject(raw)) {
    logger.warning(`FALLBACK GetInventorySnapshot: invalid index payload. indexKey=${indexKey}`);
    return { keys: [] };
  }
  const keys = Array.isArray(raw.keys) ? raw.keys.filter(k => typeof k === "string" && k.length > 0) : [];
  return { keys };
}

function _dedupeKeys(keys, logger, indexKey) {
  const seen = new Set();
  const out = [];
  let dupCount = 0;

  for (const k of keys) {
    if (seen.has(k)) {
      dupCount++;
      continue;
    }
    seen.add(k);
    out.push(k);
  }

  if (dupCount > 0) {
    logger.warning(`FALLBACK GetInventorySnapshot: duplicate keys found in index. indexKey=${indexKey}, dupCount=${dupCount}`);
  }

  return out;
}

function _chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function _pickMarketViewItem(instance) {
  // GrantItemInstanceToPlayer가 만든 공통 필드 + (payload/market/location이 있을 수도 있음) 방어적으로 읽음
  const id = instance?.instanceId ?? instance?.instanceKey ?? instance?.id ?? null;

  const kind = instance?.kind ?? null;     // "FRAG"|"EQ"
  const slot = instance?.slot ?? null;     // "WPN"|"ARM"|"ACC"
  const tier = instance?.tier ?? null;
  const rarity = instance?.rarity ?? null;

  const groupKey = instance?.groupKey ?? null;
  const templateKey = instance?.templateKey ?? null;

  const tradable = instance?.payload?.market?.tradable ?? null;
  const tradeLock = instance?.payload?.market?.tradeLock ?? null;
  const location = instance?.payload?.location?.zone ?? null;

  const quantity = instance?.quantity ?? null;

  return {
    id,
    kind,
    slot,
    tier,
    rarity,
    groupKey,
    templateKey,
    quantity,
    tradable,
    tradeLock,
    location
  };
}

async function _getProtectedItemsByKeys(api, projectId, playerId, keys) {
  // DataApi v1.4: getProtectedItems(projectId, playerId, keys?)
  const res = await api.getProtectedItems(projectId, playerId, keys);
  const items = res?.data?.results ?? [];
  const map = new Map();
  if (Array.isArray(items)) {
    for (const it of items) {
      const k = it?.key;
      if (typeof k === "string") map.set(k, it?.value);
    }
  }
  return map;
}

function _makeIndexKey(groupKey, kind, slot, tier) {
  if (groupKey) return `IDX_${groupKey}`;

  if (kind || slot || tier != null) {
    // 부분 입력은 허용하지 않는다(자동 보정 금지)
    if (!_isEnumKey(kind, E_KIND)) return { error: "INVALID_KIND" };
    if (!_isEnumKey(slot, E_SLOT)) return { error: "INVALID_SLOT" };
    if (!Number.isInteger(tier) || tier < 1) return { error: "INVALID_TIER" };
    const gk = `${kind}_${slot}_T${tier}`;
    return { indexKey: `IDX_${gk}`, groupKey: gk };
  }

  return { indexKey: IDX_ALL, groupKey: null };
}

module.exports = async ({ params, context, logger }) => {
  const groupKeyParam = typeof params?.groupKey === "string" ? params.groupKey.trim() : "";
  const groupKey = groupKeyParam || null;

  const kind = typeof params?.kind === "string" ? params.kind.trim().toUpperCase() : null;
  const slot = typeof params?.slot === "string" ? params.slot.trim().toUpperCase() : null;
  const tier = params?.tier;

  const maxItems = Math.max(1, _asInt(params?.maxItems, DEFAULT_MAX_ITEMS));
  const maxKeysPerRequest = Math.max(1, Math.min(500, _asInt(params?.maxKeysPerRequest, DEFAULT_MAX_KEYS_PER_REQUEST)));
  const includeRaw = _asBool(params?.includeRaw, true);

  const { indexKey, error, groupKey: computedGroupKey } = _makeIndexKey(groupKey, kind, slot, tier);
  if (error === "INVALID_KIND") return { ok: false, errorCode: "INVALID_KIND", errorMessage: "kind must be FRAG or EQ" };
  if (error === "INVALID_SLOT") return { ok: false, errorCode: "INVALID_SLOT", errorMessage: "slot must be WPN/ARM/ACC" };
  if (error === "INVALID_TIER") return { ok: false, errorCode: "INVALID_TIER", errorMessage: "tier must be integer >= 1" };

  const { projectId, playerId } = context;
  const api = new DataApi(context);

  const nowMs = Date.now();
  const nowIso = _nowIso();

  // 1) 인덱스 읽기
  let indexMap = null;
  try {
    indexMap = await _getProtectedItemsByKeys(api, projectId, playerId, [indexKey]);
  } catch (e) {
    logger.warning("GetInventorySnapshot: getProtectedItems(index) failed.", {
      indexKey,
      "error.message": e?.message ?? "unknown",
      "error.status": e?.response?.status ?? null
    });
    throw e;
  }

  const rawIndex = indexMap.get(indexKey);

  if (!indexMap.has(indexKey)) {
    logger.warning(`FALLBACK GetInventorySnapshot: missing index key. indexKey=${indexKey}`);
  }

  const normIndex = _normalizeIndex(rawIndex, logger, indexKey);
  const dedupedKeys = _dedupeKeys(normIndex.keys, logger, indexKey);

  // 2) maxItems 적용
  const selectedKeys = dedupedKeys.slice(0, maxItems);

  if (dedupedKeys.length > maxItems) {
    logger.warning(`FALLBACK GetInventorySnapshot: index keys exceed maxItems. indexKey=${indexKey}, total=${dedupedKeys.length}, maxItems=${maxItems}`);
  }

  // 3) 인스턴스 배치 읽기
  const chunks = _chunk(selectedKeys, maxKeysPerRequest);

  const instances = [];
  const missingKeys = [];

  for (const ks of chunks) {
    let m = null;
    try {
      m = await _getProtectedItemsByKeys(api, projectId, playerId, ks);
    } catch (e) {
      logger.warning("GetInventorySnapshot: getProtectedItems(instances) failed.", {
        indexKey,
        batchSize: ks.length,
        "error.message": e?.message ?? "unknown",
        "error.status": e?.response?.status ?? null
      });
      throw e;
    }

    for (const k of ks) {
      if (!m.has(k)) {
        missingKeys.push(k);
        continue;
      }
      instances.push(m.get(k));
    }
  }

  if (missingKeys.length > 0) {
    logger.warning(`FALLBACK GetInventorySnapshot: index references missing instances. indexKey=${indexKey}, missingCount=${missingKeys.length}`);
  }

  // 4) view + hash (인스턴스 원본 전체가 아니라 view 기준으로 안정/경량)
  const viewInstances = instances.map(_pickMarketViewItem);

  const hashPayload = {
    schema: 1,
    playerId,
    indexKeyUsed: indexKey,
    instanceKeys: selectedKeys, // 순서 포함(인덱스가 순서를 가진다면 동일성에 영향)
    view: viewInstances
  };

  const stable = _stableStringify(hashPayload);
  const hash32 = _fnv1a32(stable);
  const hashHex = _toHex32(hash32);

  return {
    ok: true,

    scope: "PROTECTED_PLAYER_DATA",
    indexKeyUsed: indexKey,
    groupKeyUsed: groupKey ?? computedGroupKey ?? null,

    nowIso,
    nowEpochMs: nowMs,

    instanceKeys: selectedKeys,

    snapshot: includeRaw
      ? {
          instances
        }
      : null,

    view: {
      instances: viewInstances
    },

    counts: {
      indexed: dedupedKeys.length,
      selected: selectedKeys.length,
      loaded: instances.length,
      missing: missingKeys.length
    },

    snapshotHash32: hash32,
    snapshotHashHex: hashHex
  };
};

module.exports.params = {
  groupKey: { type: "String", required: false },
  kind: { type: "String", required: false },
  slot: { type: "String", required: false },
  tier: { type: "Number", required: false },
  maxItems: { type: "Number", required: false },
  maxKeysPerRequest: { type: "Number", required: false },
  includeRaw: { type: "Boolean", required: false }
};