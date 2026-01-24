/**
 * GetInventorySnapshot
 * - 플레이어 인벤토리(파편/장비) + 핵심 상태 필드(tradable, tradeLock, location) 스냅샷 반환
 * - crypto 모듈 없이 안정적인 해시(FNV-1a 32bit) 생성
 *
 * - 인벤: Cloud Save Private Custom Items (플레이어별 저장)
 * - 지갑: UGS Economy 2.4 Player Balances (CurrenciesApi.getPlayerCurrencies)
 *
 * 저장(권장) 위치:
 *  - customId: "inventory"
 *  - key:
 *    - "FRAGS" : 파편 인스턴스 배열(또는 dict)
 *    - "EQS"   : 장비 인스턴스 배열(또는 dict)
 *
 * params:
 *  - includeFrags: boolean (default true)
 *  - includeEqs: boolean (default true)
 *  - includeWallet: boolean (default false)   // Economy에서 읽음
 *  - currencyIds: string[] (optional)    // 예: ["MT","EC"]  (필터는 클라/서버에서 적용)
 *  - walletLimitPerPage: number (optional) default 100 (1~100 권장)
 *  - walletMaxPages: number (optional) default 10      // 무한루프 방지
 *  - maxItems: number (default 5000)  // 과대 데이터 방어
 *
 * return:
 *  - customId, keys
 *  - nowIso, nowEpochMs
 *  - snapshot: { frags, eqs, wallet? }   // 원본
 *      - wallet = = { balances: [{ currencyId, balance, ... }, ...] } | null
 *  - view: { frags, eqs }                // 거래소 검증에 필요한 최소 필드만 추린 뷰
 *  - counts
 *  - snapshotHash32, snapshotHashHex
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");
const { CurrenciesApi } = require("@unity-services/economy-2.4");

const CUSTOM_ID = "inventory";
const KEY_FRAGS = "FRAGS";
const KEY_EQS = "EQS";

const DEFAULT_MAX_ITEMS = 5000;

function _nowIso() { return new Date().toISOString(); }

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

function _isPlainObject(o) {
  return o != null && typeof o === "object" && !Array.isArray(o);
}

/**
 * FNV-1a 32bit (crypto 없이)
 * - 입력 문자열이 같으면 항상 동일 결과
 */
function _fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function _toHex32(u32) { return (u32 >>> 0).toString(16).padStart(8, "0"); }

/**
 * 안정적인 stringify (key 정렬)
 * - JSON.stringify는 object key 순서가 입력에 의존할 수 있어서 정렬 처리
 */
function _stableStringify(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number" || t === "boolean") return String(value);
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(_stableStringify).join(",") + "]";
  if (_isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + _stableStringify(value[k])).join(",") + "}";
  }
  
  // 함수/undefined 등은 JSON 규칙과 맞추기 위해 null 처리
  return "null";
}

/**
 * Cloud Save Private Custom Items 읽기
 * - 폴백 발생 시 Warning 로그 필수
 */
async function _getPrivateCustomItems(cloudSave, projectId, playerId, customId, keys, logger) {
  if (typeof cloudSave.getPrivateCustomItems === "function") {
    return await cloudSave.getPrivateCustomItems(projectId, playerId, customId, keys);
  }

  // 폴백: 메서드가 없으면 위험. 무음 금지 -> Warning
  logger.warning("GetInventorySnapshot fallback: getPrivateCustomItems not available.", {
    customId,
    keys
  });
  
  throw new Error("GetInventorySnapshot: getPrivateCustomItems is required for per-player inventory.");
}

function _normalizeToArray(value) {
  if (Array.isArray(value)) return value;
  if (_isPlainObject(value)) return Object.values(value);
  return [];
}

function _pickMarketViewItem(item) {
  // 거래소 검증에 필요한 최소 필드만 추림
  // item 스키마가 FRAG/EQ 공통으로 아래 경로를 가진다고 가정(없으면 null)
  const id = item?.instanceId ?? item?.id ?? null;
  
  const tradable = item?.market?.tradable ?? item?.tradable ?? null;
  
  const tradeLock = item?.market?.tradeLock ?? item?.tradeLock ?? null;
  const location = item?.location?.zone ?? item?.location ?? null;

  const kind = item?.kind ?? null;     // "FRAG" / "EQ" 등
  const slot = item?.slot ?? null;     // 장비 슬롯/파편 슬롯
  const rarity = item?.rarity ?? null; // 등급

  return { id, kind, slot, rarity, tradable, tradeLock, location };
}

function _filterBalancesByIds(results, currencyIds) {
  if (!Array.isArray(results)) return [];
  if (!currencyIds || currencyIds.length === 0) return results;

  const set = new Set(currencyIds.map(x => String(x).trim()).filter(Boolean));
  return results.filter(r => set.has(String(r?.currencyId ?? "").trim()));
}

/**
 * Economy 2.4 - Player currency balances 조회
 * - getPlayerCurrencies({ projectId, playerId, after?, limit? })
 * - results는 currencyId 오름차순. 다음 페이지는 after에 "마지막 currencyId"를 넣어서 진행.
 */
async function _getWalletFromEconomy(context, logger, currencyIds, limitPerPage, maxPages) {
  const { projectId, playerId } = context;

  let api = null;
  try {
    // Cloud Code SDK들은 보통 context를 configuration 자리에 그대로 넣어도 동작한다.
    api = new CurrenciesApi(context);
  } catch (e) {
    logger.warning("GetInventorySnapshot fallback: failed to construct CurrenciesApi (economy-2.4). wallet will be null.", {
      "error.message": e?.message ?? "unknown"
    });
    return null;
  }

  const limit = Math.min(100, Math.max(1, _asInt(limitPerPage, 100)));
  const pages = Math.max(1, _asInt(maxPages, 10));

  const all = [];
  let after = undefined;

  try {
    for (let i = 0; i < pages; i++) {
      const req = { projectId, playerId, limit };
      if (after) req.after = after;

      const res = await api.getPlayerCurrencies(req);
      const results = res?.data?.results ?? [];

      if (!Array.isArray(results)) break;

      all.push(...results);

      if (results.length < limit) break;

      const lastCurrencyId = String(results[results.length - 1]?.currencyId ?? "").trim();
      if (!lastCurrencyId) break;

      // 다음 페이지: "이 currencyId 이후"로 가져온다.
      after = lastCurrencyId;
    }
  } catch (e) {
    logger.warning("GetInventorySnapshot: Economy getPlayerCurrencies failed. wallet will be null.", {
      "error.message": e?.message ?? "unknown",
      "error.status": e?.response?.status ?? null
    });
    return null;
  }

  return _filterBalancesByIds(all, currencyIds);
}

module.exports = async ({ params, context, logger }) => {
  const includeFrags = _asBool(params?.includeFrags, true);
  const includeEqs = _asBool(params?.includeEqs, true);
  const includeWallet = _asBool(params?.includeWallet, false);

  const currencyIds =
    Array.isArray(params?.currencyIds) ? params.currencyIds.map(x => String(x)) : null;

  const walletLimitPerPage = params?.walletLimitPerPage;
  const walletMaxPages = params?.walletMaxPages;

  const maxItems = Math.max(1, _asInt(params?.maxItems, DEFAULT_MAX_ITEMS));

  const { projectId, playerId } = context;
  const cloudSave = new DataApi(context);

  const keys = [];
  if (includeFrags) keys.push(KEY_FRAGS);
  if (includeEqs) keys.push(KEY_EQS);

  const nowMs = Date.now();
  const nowIso = _nowIso();

  // 1) 인벤 읽기 (Cloud Save)
  let res = null;
  try {
    res = await _getPrivateCustomItems(cloudSave, projectId, playerId, CUSTOM_ID, keys, logger);
  } catch (e) {
    logger.warning("GetInventorySnapshot: inventory read failed.", {
      customId: CUSTOM_ID,
      keys,
      "error.message": e?.message ?? "unknown",
      "error.status": e?.response?.status ?? null
    });
    throw e;
  }

  const results = res?.data?.results ?? [];
  const map = new Map();
  for (const it of results) {
    if (!it?.key) continue;
    map.set(it.key, it.value ?? null);
  }

  const fragsRaw = includeFrags ? (map.get(KEY_FRAGS) ?? null) : null;
  const eqsRaw = includeEqs ? (map.get(KEY_EQS) ?? null) : null;

  const fragsArr = includeFrags ? _normalizeToArray(fragsRaw) : [];
  const eqsArr = includeEqs ? _normalizeToArray(eqsRaw) : [];

  if (fragsArr.length + eqsArr.length > maxItems) {
    logger.warning("GetInventorySnapshot fallback: too many items. Truncating for safety.", {
      maxItems,
      frags: fragsArr.length,
      eqs: eqsArr.length
    });
  }

  const fragsTrim = fragsArr.slice(0, maxItems);
  const remaining = Math.max(0, maxItems - fragsTrim.length);
  const eqsTrim = eqsArr.slice(0, remaining);

  // 2) view 생성(최소 필드만)
  const fragsView = fragsTrim.map(_pickMarketViewItem);
  const eqsView = eqsTrim.map(_pickMarketViewItem);

  // 3) 지갑 읽기 (Economy 2.4)
  let walletBalances = null;
  if (includeWallet) {
    walletBalances = await _getWalletFromEconomy(
      context,
      logger,
      currencyIds,
      walletLimitPerPage,
      walletMaxPages
    );

    if (walletBalances == null) {
      logger.warning("GetInventorySnapshot fallback: wallet is null (Economy read failed).", {
        playerId,
        currencyIds: currencyIds ?? null
      });
    }
  }

  // 3) 해시 (view + wallet 포함)
  const hashPayload = {
    schema: 1,
    playerId,
    keys,
    frags: fragsView,
    eqs: eqsView,
    wallet: includeWallet ? walletBalances : null
  };

  const stable = _stableStringify(hashPayload);
  const hash32 = _fnv1a32(stable);
  const hashHex = _toHex32(hash32);

  return {
    customId: CUSTOM_ID,
    keys,
    nowIso,
    nowEpochMs: nowMs,

    snapshot: {
      frags: includeFrags ? fragsRaw : null,
      eqs: includeEqs ? eqsRaw : null,
      wallet: includeWallet ? (walletBalances ? { balances: walletBalances } : null) : null
    },

    view: {
      frags: fragsView,
      eqs: eqsView
    },

    counts: {
      frags: fragsView.length,
      eqs: eqsView.length,
      total: fragsView.length + eqsView.length
    },

    snapshotHash32: hash32,
    snapshotHashHex: hashHex
  };
};

module.exports.params = {
  includeFrags: { type: "Boolean", required: false },
  includeEqs: { type: "Boolean", required: false },
  includeWallet: { type: "Boolean", required: false },
  currencyIds: { type: "Array", required: false },
  walletLimitPerPage: { type: "Number", required: false },
  walletMaxPages: { type: "Number", required: false },
  maxItems: { type: "Number", required: false }
};
