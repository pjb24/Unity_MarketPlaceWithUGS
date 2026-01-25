/**
 * GrantItemInstanceToPlayer
 *
 * 목적:
 * - 유저에게 FRAG/EQ 인스턴스를 1개 생성·지급하고, Cloud Save Private Custom Items에 저장한다.
 * - 랜덤 뽑기/조회용 인덱스(IDX_ALL, IDX_<groupKey>)를 함께 갱신한다.
 *
 * 저장 위치:
 * - Cloud Save: Private Custom Items
 * - customId: "inventory"
 * - 인스턴스: key = "ITEM_<instanceId>"
 * - 인덱스:   key = "IDX_ALL", "IDX_<groupKey>" (value: { keys: string[] })
 *
 * key 규칙:
 * - templateKey = <kind>_<slot>_T<tier>_<seq3>
 *   예) FRAG_WPN_T1_001, EQ_ARM_T3_012
 * - instanceKey = ITEM_<instanceId>
 *   - instanceId 예) `${Date.now()}_${Math.floor(Math.random()*1e9)}`
 *   - crypto 모듈 사용 금지
 *
 * groupKey 규칙:
 * - groupKey = <kind>_<slot>_T<tier>
 *   예) FRAG_WPN_T1, EQ_ARM_T3
 *
 * 인덱스 규칙:
 * - IDX_ALL: 모든 instanceKey 목록
 * - IDX_<groupKey>: 해당 groupKey에 속한 instanceKey 목록
 * - 각 value는 { keys: string[] } 형태
 * - 중복 append 금지
 * - 최대 N개(기본 1000) 초과 시 에러(폴백 금지)
 *
 * [입력 파라미터(10개 이하)]
 * 1) kind: "FRAG"|"EQ" (필수)
 * 2) slot: "WPN"|"ARM"|"ACC" (필수)
 * 3) tier: number (필수)
 * 4) seq3: number (필수) // 1~999, 3자리 0패딩
 * 5) rarity: "COMMON"|"RARE"|"EPIC"|"LEGENDARY" (필수)
 * 6) quantity: number (선택, 기본 1) // 스택 가능 여부는 payload 정책에 따름 (기본은 인스턴스 1개)
 * 7) payload: object (선택, 기본 {}) // 인스턴스 추가 데이터(스탯/스킬/룰 등)
 * 8) note: string (선택, 기본 "")
 * 9) writeIndexes: boolean (선택, 기본 true)
 * 10) dryRun: boolean (선택, 기본 false)
 *
 * 에러·폴백 규칙:
 * - 입력값 자동 보정/추정 폴백 금지.
 * - dryRun=true면 저장/인덱스 갱신(setPrivateCustomItem) 금지.
 * - instanceKey 존재 여부를 getPrivateCustomItems로 확인하고, 이미 존재하면 에러(재생성 금지).
 * - 실패 시 { ok:false, errorCode, errorMessage } 반환.
 * - 폴백 로직을 넣는 경우(현재 구현은 폴백 없음), 반드시 console.warn에 "FALLBACK" 포함 로그 +
 *   반환값에 fallbackApplied=true 및 변경 내역 포함이 필요.
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

const CUSTOM_ID = "inventory";
const INDEX_ALL_KEY = "IDX_ALL";
const MAX_INDEX_KEYS = 1000;

const E_KIND = Object.freeze({ FRAG: "FRAG", EQ: "EQ" });
const E_SLOT = Object.freeze({ WPN: "WPN", ARM: "ARM", ACC: "ACC" });
const E_RARITY = Object.freeze({
  COMMON: "COMMON",
  RARE: "RARE",
  EPIC: "EPIC",
  LEGENDARY: "LEGENDARY",
});

module.exports = async function GrantItemInstanceToPlayer({ params, context, logger }) {
  try {
    const {
      kind,
      slot,
      tier,
      seq3,
      rarity,
      quantity = 1,
      payload = {},
      note = "",
      writeIndexes = true,
      dryRun = false,
    } = params ?? {};

    // ---------- A) validation (no silent fallback) ----------
    if (!isOneOf(kind, E_KIND)) return fail("INVALID_KIND", `kind must be one of: ${Object.values(E_KIND).join(", ")}`);
    if (!isOneOf(slot, E_SLOT)) return fail("INVALID_SLOT", `slot must be one of: ${Object.values(E_SLOT).join(", ")}`);
    if (!isOneOf(rarity, E_RARITY)) return fail("INVALID_RARITY", `rarity must be one of: ${Object.values(E_RARITY).join(", ")}`);

    if (!isPositiveInt(tier) || tier < 1) return fail("INVALID_TIER", "tier must be an integer >= 1");
    if (!isPositiveInt(seq3) || seq3 < 1 || seq3 > 999) return fail("INVALID_SEQ3", "seq3 must be an integer in range 1..999");
    if (!isPositiveInt(quantity) || quantity < 1) return fail("INVALID_QUANTITY", "quantity must be an integer >= 1");
    if (!isPlainObject(payload)) return fail("INVALID_PAYLOAD", "payload must be a non-null object (not array)");
    if (typeof note !== "string") return fail("INVALID_NOTE", "note must be a string");
    if (typeof writeIndexes !== "boolean") return fail("INVALID_WRITE_INDEXES", "writeIndexes must be a boolean");
    if (typeof dryRun !== "boolean") return fail("INVALID_DRY_RUN", "dryRun must be a boolean");

    // ---------- B) templateKey / groupKey ----------
    const seq3Str = pad3(seq3);
    const templateKey = `${kind}_${slot}_T${tier}_${seq3Str}`;
    const groupKey = `${kind}_${slot}_T${tier}`;

    // ---------- C) instanceId / instanceKey ----------
    const instanceId = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    const instanceKey = `ITEM_${instanceId}`;

    const nowIso = new Date().toISOString();
    const instance = {
      schema: 1,
      instanceId,
      instanceKey,
      templateKey,
      groupKey,
      kind,
      slot,
      tier,
      seq3: seq3Str,
      rarity,
      quantity,
      payload,
      lifecycle: {
        createdAt: nowIso,
        updatedAt: nowIso,
        createdBy: "GRANT",
      },
      note,
    };

    // ---------- D) dryRun ----------
    if (dryRun) {
      return {
        ok: true,
        templateKey,
        groupKey,
        instanceKey,
        instance,
        dryRun: true,
      };
    }

    const api = new DataApi(context);
    const projectId = context.projectId;
    const playerId = context.playerId;

    // ---------- E) store instance (collision check) ----------
    {
      const exists = await privateKeyExists(api, projectId, playerId, CUSTOM_ID, instanceKey);
      if (exists) return fail("INSTANCE_KEY_ALREADY_EXISTS", `instanceKey already exists: ${instanceKey}`);

      await api.setPrivateCustomItem(projectId, playerId, CUSTOM_ID, {
        key: instanceKey,
        value: instance,
      });
    }

    // ---------- F) update indexes ----------
    if (writeIndexes) {
      const groupIndexKey = `IDX_${groupKey}`;
      const indexKeysToRead = [INDEX_ALL_KEY, groupIndexKey];

      const indexMap = await getPrivateIndexMap(api, projectId, playerId, CUSTOM_ID, indexKeysToRead);

      const idxAll = normalizeIndexValue(indexMap[INDEX_ALL_KEY], INDEX_ALL_KEY);
      const idxGroup = normalizeIndexValue(indexMap[groupIndexKey], groupIndexKey);

      // append (dedupe)
      appendKeyOrFail(idxAll, instanceKey, INDEX_ALL_KEY);
      appendKeyOrFail(idxGroup, instanceKey, groupIndexKey);

      // write back
      await api.setPrivateCustomItem(projectId, playerId, CUSTOM_ID, {
        key: INDEX_ALL_KEY,
        value: idxAll,
      });

      await api.setPrivateCustomItem(projectId, playerId, CUSTOM_ID, {
        key: groupIndexKey,
        value: idxGroup,
      });
    }

    return {
      ok: true,
      templateKey,
      groupKey,
      instanceKey,
      instance,
      dryRun: false,
    };
  } catch (e) {
    return fail("UNHANDLED_EXCEPTION", safeErrorMessage(e));
  }
};

function fail(errorCode, errorMessage) {
  return { ok: false, errorCode: String(errorCode), errorMessage: String(errorMessage) };
}

function isOneOf(v, enumObj) {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(enumObj, v);
}

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

function pad3(n) {
  const s = String(n);
  return s.length >= 3 ? s : "0".repeat(3 - s.length) + s;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function privateKeyExists(api, projectId, playerId, customId, key) {
  // Missing key => empty results. Any SDK/response shape differences are handled safely.
  const res = await api.getPrivateCustomItems(projectId, playerId, customId, [key]);
  const data = res?.data;
  const items = data?.results ?? data?.items ?? [];
  return Array.isArray(items) && items.some((it) => it && it.key === key);
}

async function getPrivateIndexMap(api, projectId, playerId, customId, keys) {
  const res = await api.getPrivateCustomItems(projectId, playerId, customId, keys);
  const data = res?.data;
  const items = data?.results ?? data?.items ?? [];
  const map = {};
  if (Array.isArray(items)) {
    for (const it of items) {
      if (it && typeof it.key === "string") map[it.key] = it.value;
    }
  }
  return map;
}

function normalizeIndexValue(v, indexKey) {
  if (v === undefined || v === null) {
    return { keys: [] };
  }
  if (!isPlainObject(v) || !Array.isArray(v.keys) || !v.keys.every((x) => typeof x === "string")) {
    // No fallback allowed: invalid stored shape is a hard error (data corruption or misuse).
    throw new Error(`INVALID_INDEX_SHAPE: ${indexKey}`);
  }
  return { keys: [...v.keys] };
}

function appendKeyOrFail(indexValue, instanceKey, indexKey) {
  // dedupe
  if (!indexValue.keys.includes(instanceKey)) {
    if (indexValue.keys.length + 1 > MAX_INDEX_KEYS) {
      throw new Error(`INDEX_LIMIT_EXCEEDED: ${indexKey} max=${MAX_INDEX_KEYS}`);
    }
    indexValue.keys.push(instanceKey);
  }
}

function safeErrorMessage(e) {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  const status = e?.response?.status ?? e?.status;
  const detail = e?.response?.data?.detail ?? e?.response?.data?.message ?? e?.message;
  if (status && detail) return `status=${status} ${detail}`;
  if (detail) return String(detail);
  try {
    return JSON.stringify(e);
  } catch {
    return "unstringifiable error";
  }
}