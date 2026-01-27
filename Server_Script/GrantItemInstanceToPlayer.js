/**
 * GrantItemInstanceToPlayer
 *
 * 목적:
 * - (kind/slot/tier/seq3/rarity/payload)를 기반으로 “아이템 인스턴스”를 생성해 유저에게 지급한다.
 * - 지급된 인스턴스와 조회용 인덱스(IDX_*)를 Cloud Save에 저장한다.
 *
 * 저장 위치:
 * - Cloud Save v1.4 DataApi의 “Protected Player Data” 사용 (서버 권한 전용)
 *   - 이유: DataApi v1.4의 Private Custom Items는 (projectId, customId) 단위의 “게임 데이터”이며 playerId 스코프가 아니다.
 * - 따라서 플레이어 인벤토리는 (projectId, playerId) 스코프인 Protected Items로 저장한다.
 *
 * key 규칙:
 * - 인스턴스 key(=id): prefix 금지 → instanceId 그대로 사용 (예: "1700000000000_123456789")
 * - 인덱스 key:
 *   - "IDX_ALL"
 *   - `IDX_${groupKey}`
 *
 * groupKey 규칙:
 * - groupKey = <kind>_<slot>_T<tier>
 *   예: FRAG_WPN_T1, EQ_ARM_T3
 * - templateKey = <kind>_<slot>_T<tier>_<seq3>
 *   예: FRAG_WPN_T1_001, EQ_ARM_T3_012
 *
 * 인덱스 규칙:
 * - 인덱스 value는 { keys: string[] } 형태
 * - keys 배열에는 “인스턴스 key(=id)”를 저장한다. (중복 금지)
 * - MAX_INDEX_KEYS 초과 시 에러 (폴백 금지)
 *
 * Parameters
 * 1) kind: "FRAG" | "EQ" (필수) 아이템 종류
 * 2) slot: "WPN" | "ARM" | "ACC" (필수) 장착 슬롯
 * 3) tier: number (필수) 티어, 정수, 1 이상
 * 4) seq3: number (필수) 템플릿 시퀀스, 1 ~ 999, 내부에서 3자리 0패딩 처리
 * 5) rarity: "COMMON" | "RARE" | "EPIC" | "LEGENDARY" (필수) 희귀도
 * 6) quantity: number (선택, 기본값: 1) 지급 수량, 정수, 1 이상, 스택 가능 여부는 payload 정책에 따름
 * 7) payload: object (선택, 기본값: {}) 인스턴스 전용 추가 데이터, 스탯, 스킬, 룰 등, 반드시 object
 * 8) note: string (선택, 기본값: "") 운영/디버그용 메모
 * 9) writeIndexes: boolean (선택, 기본값: true) IDX_ALL, IDX_<groupKey> 인덱스 갱신 여부
 * 10) dryRun: boolean (선택, 기본값: false) true일 경우: 검증 및 생성 데이터만 반환, Cloud Save 읽기/쓰기 전부 수행하지 않음
 * 
 * 에러·폴백 규칙:
 * - 입력 자동 보정/추정(폴백) 금지.
 * - dryRun=true면 검증/생성 결과만 반환하고 Cloud Save 호출 금지.
 * - 실패 시 { ok:false, errorCode, errorMessage } 반환.
 * - 폴백 로직을 넣는 순간 반드시 console.warn("FALLBACK ...") 찍고, 반환에 fallbackApplied 포함해야 한다.
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

const E_KIND = Object.freeze({ FRAG: "FRAG", EQ: "EQ" });
const E_SLOT = Object.freeze({ WPN: "WPN", ARM: "ARM", ACC: "ACC" });
const E_RARITY = Object.freeze({
  COMMON: "COMMON",
  RARE: "RARE",
  EPIC: "EPIC",
  LEGENDARY: "LEGENDARY",
});

const IDX_ALL = "IDX_ALL";
const MAX_INDEX_KEYS = 1000;

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

    // ---- validate (no silent fallback) ----
    if (!isEnumKey(kind, E_KIND)) return fail("INVALID_KIND", `kind must be one of: ${Object.values(E_KIND).join(", ")}`);
    if (!isEnumKey(slot, E_SLOT)) return fail("INVALID_SLOT", `slot must be one of: ${Object.values(E_SLOT).join(", ")}`);
    if (!isEnumKey(rarity, E_RARITY)) return fail("INVALID_RARITY", `rarity must be one of: ${Object.values(E_RARITY).join(", ")}`);

    if (!isPositiveInt(tier) || tier < 1) return fail("INVALID_TIER", "tier must be an integer >= 1");
    if (!isPositiveInt(seq3) || seq3 < 1 || seq3 > 999) return fail("INVALID_SEQ3", "seq3 must be an integer in range 1..999");
    if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 1) return fail("INVALID_QUANTITY", "quantity must be an integer >= 1");
    if (!isPlainObject(payload)) return fail("INVALID_PAYLOAD", "payload must be a non-null object (not array)");
    if (typeof note !== "string") return fail("INVALID_NOTE", "note must be a string");
    if (typeof writeIndexes !== "boolean") return fail("INVALID_WRITE_INDEXES", "writeIndexes must be a boolean");
    if (typeof dryRun !== "boolean") return fail("INVALID_DRY_RUN", "dryRun must be a boolean");

    const seq3Str = pad3(seq3);
    const groupKey = `${kind}_${slot}_T${tier}`;
    const templateKey = `${kind}_${slot}_T${tier}_${seq3Str}`;

    // id에 prefix 붙이지 않기: key = instanceId 그대로 사용
    const instanceId = genInstanceId();
    const instanceKey = instanceId;

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

    // ---- existence check: key already exists? (should not) ----
    const existing = await getProtectedItemsByKeys(api, projectId, playerId, [instanceKey]);
    if (existing.has(instanceKey)) return fail("INSTANCE_KEY_ALREADY_EXISTS", `instance key already exists: ${instanceKey}`);

    // ---- read indexes (optional) ----
    const idxGroup = `IDX_${groupKey}`;
    const idxKeysToRead = writeIndexes ? [IDX_ALL, idxGroup] : [];

    const idxMap = writeIndexes ? await getProtectedItemsByKeys(api, projectId, playerId, idxKeysToRead) : new Map();

    const nextAll = writeIndexes ? normalizeIndex(idxMap.get(IDX_ALL)) : null;
    const nextGroup = writeIndexes ? normalizeIndex(idxMap.get(idxGroup)) : null;

    if (writeIndexes) {
      // append (no duplicates)
      if (!nextAll.keys.includes(instanceKey)) nextAll.keys.push(instanceKey);
      if (!nextGroup.keys.includes(instanceKey)) nextGroup.keys.push(instanceKey);

      if (nextAll.keys.length > MAX_INDEX_KEYS) return fail("IDX_ALL_LIMIT_EXCEEDED", `IDX_ALL keys exceeded max=${MAX_INDEX_KEYS}`);
      if (nextGroup.keys.length > MAX_INDEX_KEYS) return fail("IDX_GROUP_LIMIT_EXCEEDED", `${idxGroup} keys exceeded max=${MAX_INDEX_KEYS}`);
    }

    // ---- write atomically: instance + indexes (batch) ----
    const batchData = [{ key: instanceKey, value: instance }];

    if (writeIndexes) {
      batchData.push({ key: IDX_ALL, value: nextAll });
      batchData.push({ key: idxGroup, value: nextGroup });
    }

    // SetItemBatchBody: { data: SetItemBody[] }
    await api.setProtectedItemBatch(projectId, playerId, { data: batchData });

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

function isEnumKey(v, enumObj) {
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

function genInstanceId() {
  // crypto 모듈 금지
  return `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

function normalizeIndex(raw) {
  if (raw == null) return { keys: [] };
  if (!isPlainObject(raw)) return { keys: [] };
  const keys = Array.isArray(raw.keys) ? raw.keys.filter((k) => typeof k === "string") : [];
  return { keys };
}

async function getProtectedItemsByKeys(api, projectId, playerId, keys) {
  const map = new Map();
  if (!Array.isArray(keys) || keys.length === 0) return map;

  // getProtectedItems(projectId, playerId, keys?, after?)
  const res = await api.getProtectedItems(projectId, playerId, keys);
  const items = res?.data?.results ?? [];

  if (Array.isArray(items)) {
    for (const it of items) {
      const k = it?.key;
      if (typeof k === "string") map.set(k, it?.value);
    }
  }
  return map;
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