/**
 * CreateItemTemplateInstance
 *
 * 목적:
 * - kind/slot/tier/seq3로 아이템 템플릿 인스턴스 key를 생성하고,
 *   Cloud Save Game Data(Custom Items, 공용) customId="item_templates"에 저장한다.
 * - 특정 유저 인벤토리와 무관한 전역 게임 데이터(서버 권한 데이터)이다.
 * - seq3는 해당 groupKey 내에서 중복되지 않아야 한다.
 * - 동일 key가 이미 존재하면 에러.
 *
 * key 규칙:
 * - key = <kind>_<slot>_T<tier>_<seq3>
 *   - kind: "FRAG" | "EQ"
 *   - slot: "WPN" | "ARM" | "ACC"
 *   - tier: 1 이상의 정수
 *   - seq3: 001~999 (입력 number 1~999를 3자리 0패딩)
 * - overwrite=false 상태에서 동일 key가 이미 존재하면 에러.
 * - 예: FRAG_WPN_T1_001, EQ_ARM_T3_012
 *
 * groupKey 규칙(랜덤 뽑기용):
 * - groupKey = <kind>_<slot>_T<tier>
 * - 저장되는 모든 인스턴스는 반드시 groupKey를 포함한다.
 *
 * parameters
 * 1) kind: "FRAG" | "EQ" (필수)
 * 2) slot: "WPN" | "ARM" | "ACC" (필수)
 * 3) tier: number (필수)
 * 4) seq3: number (필수) // 1~999, 내부에서 0패딩
 * 5) rarity: "COMMON"|"RARE"|"EPIC"|"LEGENDARY" (필수)
 * 6) payload: object (필수) // 스탯, 스킬, 룰 등 템플릿 실제 내용
 * 7) schema: number (선택, 기본 1)
 * 8) authorNote: string (선택, 기본 "")
 * 9) overwrite: boolean (선택, 기본 false)
 * 10) dryRun: boolean (선택, 기본 false)
 *
 * [저장 데이터 구조]
 * {
 *   "schema": <schema>,
 *   "key": "<kind>_<slot>_T<tier>_<seq3>",
 *   "groupKey": "<kind>_<slot>_T<tier>",
 *   "kind": "<kind>",
 *   "slot": "<slot>",
 *   "tier": <tier>,
 *   "rarity": "<rarity>",
 *   "payload": <payload>,
 *   "meta": {
 *    "createdAt": "<ISO8601>",
 *    "updatedAt": "<ISO8601>",
 *    "authorNote": "<authorNote>"
 *   }
 * }
 *
 * 에러 규칙:
 * - 입력값 자동 보정/추정(폴백) 금지.
 * - dryRun=true면 검증만 수행하고 setCustomItem 호출 금지.
 * - 검증 실패/저장 실패 시:
 *   { ok:false, errorCode, errorMessage } 반환.
 * - 어떤 이유로든 폴백이 실행되면 console.warn에 "FALLBACK" 포함 로그를 남긴다.
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

const CUSTOM_ID = "item_templates";

const E_KIND = Object.freeze({ FRAG: "FRAG", EQ: "EQ" });
const E_SLOT = Object.freeze({ WPN: "WPN", ARM: "ARM", ACC: "ACC" });
const E_RARITY = Object.freeze({
  COMMON: "COMMON",
  RARE: "RARE",
  EPIC: "EPIC",
  LEGENDARY: "LEGENDARY",
});

module.exports = async function CreateItemTemplateInstance({ params, context, logger }) {
  try {
    const {
      kind,
      slot,
      tier,
      seq3,
      rarity,
      payload,
      schema = 1,
      authorNote = "",
      overwrite = false,
      dryRun = false,
    } = params ?? {};

    // -------- validation (no silent fallback) --------
    if (!isOneOf(kind, E_KIND)) return fail("INVALID_KIND", `kind must be one of: ${Object.values(E_KIND).join(", ")}`);
    if (!isOneOf(slot, E_SLOT)) return fail("INVALID_SLOT", `slot must be one of: ${Object.values(E_SLOT).join(", ")}`);
    if (!isOneOf(rarity, E_RARITY)) return fail("INVALID_RARITY", `rarity must be one of: ${Object.values(E_RARITY).join(", ")}`);

    if (!isPositiveInt(tier) || tier < 1) return fail("INVALID_TIER", "tier must be an integer >= 1");
    if (!isPositiveInt(seq3) || seq3 < 1 || seq3 > 999) return fail("INVALID_SEQ3", "seq3 must be an integer in range 1..999");
    if (!isPlainObject(payload)) return fail("INVALID_PAYLOAD", "payload must be a non-null object (not array)");

    if (!Number.isFinite(schema) || schema <= 0) return fail("INVALID_SCHEMA", "schema must be a positive number");
    if (typeof authorNote !== "string") return fail("INVALID_AUTHOR_NOTE", "authorNote must be a string");
    if (typeof overwrite !== "boolean") return fail("INVALID_OVERWRITE", "overwrite must be a boolean");
    if (typeof dryRun !== "boolean") return fail("INVALID_DRY_RUN", "dryRun must be a boolean");

    const seq3Str = pad3(seq3);
    const key = `${kind}_${slot}_T${tier}_${seq3Str}`;
    const groupKey = `${kind}_${slot}_T${tier}`;

    const api = new DataApi(context);
    const projectId = context.projectId;

    // -------- existence check (overwrite=false only) --------
    if (!overwrite) {
      const exists = await customKeyExists(api, projectId, CUSTOM_ID, key);
      if (exists) return fail("KEY_ALREADY_EXISTS", `key already exists: ${key}`);
    }

    const nowIso = new Date().toISOString();

    const template = {
      schema,
      key,
      groupKey,
      kind,
      slot,
      tier,
      rarity,
      payload,
      meta: {
        createdAt: nowIso,
        updatedAt: nowIso,
        authorNote,
      },
    };

    if (dryRun) {
      return {
        ok: true,
        key,
        groupKey,
        template,
        dryRun: true,
      };
    }

    // -------- write (Game Data Custom Item) --------
    // Cloud Save v1.4: setCustomItem(projectId, customId, { key, value, writeLock? })
    await api.setCustomItem(projectId, CUSTOM_ID, {
      key,
      value: template,
    });

    return {
      ok: true,
      key,
      groupKey,
      template,
      dryRun: false,
    };
  } catch (e) {
    // No fallback here. Just return a stable error.
    const msg = safeErrorMessage(e);
    return fail("UNHANDLED_EXCEPTION", msg);
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
  // Deterministic formatting (not a fallback)
  const s = String(n);
  return s.length >= 3 ? s : "0".repeat(3 - s.length) + s;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function customKeyExists(api, projectId, customId, key) {
  // Cloud Save SDK provides getCustomItems (keys array). Missing key returns empty results.
  try {
    const res = await api.getCustomItems(projectId, customId, [key]);
    const data = res?.data;
    const items = data?.results ?? data?.items ?? [];
    // results schema can vary; we treat any returned item with matching key as exists.
    return Array.isArray(items) && items.some((it) => it && it.key === key);
  } catch (e) {
    // If Cloud Save returns error, do NOT fallback. Surface as failure.
    // (If you ever decide to fallback to "assume not exists", you MUST warn with "FALLBACK".)
    throw new Error(`CLOUDSAVE_GET_FAILED: ${safeErrorMessage(e)}`);
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