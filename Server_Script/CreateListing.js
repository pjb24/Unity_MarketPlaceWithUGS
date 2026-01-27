/**
 * CreateListing
 *
 * 목적:
 * - Protected Player Data(GrantItemInstanceToPlayer 산출물)에 있는 아이템 인스턴스(key=itemInstanceId)를
 *   거래소에 등록한다.
 * - 아이템 id에 prefix를 붙이지 않는다. (escrow에서도 key=itemInstanceId 그대로 사용)
 * - Grant 구조상 “인벤토리↔에스크로”를 customId 변경만으로 처리할 수 없다(Protected Items는 customId가 없음).
 *   따라서 서버에서 다음 순서로 “이동”을 수행한다:
 *   1) Protected Items에서 아이템/인덱스(IDX_ALL, IDX_<groupKey>) 읽기
 *   2) escrow(Custom Items)에 동일 key로 저장
 *   3) Protected Items에서 아이템 삭제 + 인덱스에서 key 제거 (배치)
 * - 이후 market_listings / market_indexes(Custom Items)에 리스팅/인덱스를 기록한다.
 * - 중간 실패 시 무음 금지: Warning 로그 남기고, 가능한 범위에서 롤백 시도 후 에러 반환.
 *
 * 추가(Expire):
 * - listing에 expiresAt/expiresAtKey 저장
 * - 만료 인덱스 키 추가:
 *   IDX_STATUS_EXPIREAT_ACTIVE_<expiresAtKey>_<listingId>
 * 
 * 데이터 저장 위치(기본값):
 * - 인벤 아이템(Protected Items): key = "<itemInstanceId>"
 * - 인벤 인덱스(Protected Items): "IDX_ALL", `IDX_${groupKey}`
 * - 에스크로 아이템(Custom Items): customId="escrow", key="<itemInstanceId>"  // prefix 없음
 * - 리스팅(Custom Items): customId="market_listings", key="LISTING_<listingId>"
 * - 인덱스(Custom Items): customId="market_indexes"
 *
 * params (최대 10개):
 *  1) itemInstanceId: string (필수)
 *  2) price: number (필수, 1 이상)
 *  3) currencyId: string (필수)
 *  4) listingsCustomId: string (선택, 기본 "market_listings")
 *  5) indexesCustomId: string (선택, 기본 "market_indexes")
 *  6) escrowCustomId: string (선택, 기본 "escrow")
 *  7) nowIso: string (선택) // 테스트용 시간 주입, 없으면 new Date().toISOString()
 *  8) priceBucketSize: number (선택, 기본 1)
 *  9) dryRun: boolean (선택, 기본 false) // true면 읽기/쓰기 전부 금지, 생성 결과만 반환
 *  10) expiresInSeconds: number (선택, 기본 86400)  // 만료까지 초
 *
 * return:
 * - ok=true: listingId, listingKey, listing, indexKeys
 * - ok=false: errorCode, errorMessage
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

const IDX_ALL = "IDX_ALL";
const DEFAULT_EXPIRES_IN_SECONDS = 86400; // 1 day

module.exports = async function CreateListing({ params, context, logger }) {
  try {
    const {
      itemInstanceId,
      price,
      currencyId,
      listingsCustomId = "market_listings",
      indexesCustomId = "market_indexes",
      escrowCustomId = "escrow",
      nowIso,
      priceBucketSize = 1,
      dryRun = false,
      expiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS,
    } = params ?? {};

    // ---- validate (no silent fallback) ----
    if (typeof itemInstanceId !== "string" || itemInstanceId.length === 0) {
      return fail("INVALID_ITEM_INSTANCE_ID", "itemInstanceId is required");
    }
    if (itemInstanceId.trim() !== itemInstanceId) {
      return fail("INVALID_ITEM_INSTANCE_ID", "itemInstanceId must not contain leading/trailing whitespace");
    }
    if (typeof price !== "number" || !Number.isFinite(price) || price < 1) return fail("INVALID_PRICE", "price must be a finite number >= 1");
    if (typeof currencyId !== "string" || currencyId.length === 0) return fail("INVALID_CURRENCY_ID", "currencyId is required");

    if (typeof listingsCustomId !== "string" || listingsCustomId.length === 0) return fail("INVALID_LISTINGS_CUSTOM_ID", "listingsCustomId must be a string");
    if (typeof indexesCustomId !== "string" || indexesCustomId.length === 0) return fail("INVALID_INDEXES_CUSTOM_ID", "indexesCustomId must be a string");
    if (typeof escrowCustomId !== "string" || escrowCustomId.length === 0) return fail("INVALID_ESCROW_CUSTOM_ID", "escrowCustomId must be a string");

    if (typeof priceBucketSize !== "number" || !Number.isFinite(priceBucketSize) || !Number.isInteger(priceBucketSize) || priceBucketSize < 1) {
      return fail("INVALID_PRICE_BUCKET_SIZE", "priceBucketSize must be an integer >= 1");
    }
    if (typeof dryRun !== "boolean") return fail("INVALID_DRY_RUN", "dryRun must be a boolean");
    if (nowIso != null && typeof nowIso !== "string") return fail("INVALID_NOW_ISO", "nowIso must be a string when provided");

    if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds) || !Number.isInteger(expiresInSeconds) || expiresInSeconds < 1) {
      return fail("INVALID_EXPIRES_IN_SECONDS", "expiresInSeconds must be an integer >= 1");
    }

    const projectId = context.projectId;
    const playerId = context.playerId;
    const api = new DataApi(context);

    const _nowIso = (typeof nowIso === "string" && nowIso.length > 0) ? nowIso : new Date().toISOString();

    // expiresAt 계산 (UTC ISO)
    const expiresAtIso = new Date(Date.parse(_nowIso) + expiresInSeconds * 1000).toISOString();
    const expiresAtKey = toCreatedAtKeyUtc(expiresAtIso);

    // listingId 생성 (외부 의존 없음)
    const listingId = `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const listingKey = `LISTING_${listingId}`;

    // createdAtKey: 문자열 정렬용(UTC)
    const createdAtKey = toCreatedAtKeyUtc(_nowIso);

    const bucket = Math.floor(price / priceBucketSize) * priceBucketSize;
    const priceBucket12 = String(bucket).padStart(12, "0");

    const indexKeys = [
      `IDX_SELLER_STATUS_${playerId}_ACTIVE_${listingId}`,
      `IDX_STATUS_CREATEDAT_ACTIVE_${createdAtKey}_${listingId}`,
      `IDX_STATUS_PRICE_ACTIVE_${priceBucket12}_${listingId}`,
      `IDX_STATUS_EXPIREAT_ACTIVE_${expiresAtKey}_${listingId}`,
    ];

    const listing = {
      listingId,
      status: "ACTIVE",
      sellerPlayerId: playerId,

      itemInstanceId, // prefix 없음
      price,
      currencyId,

      createdAt: _nowIso,
      createdAtKey,
      updatedAt: _nowIso,

      expiresAt: expiresAtIso,
      expiresAtKey,
    };

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        listingId,
        listingKey,
        listing,
        indexKeys,
      };
    }

    // ---- read inventory item from Protected Items ----
    const invMap = await getProtectedItemsByKeys(api, projectId, playerId, [itemInstanceId]);
    const instance = invMap.get(itemInstanceId);

    if (!isPlainObject(instance)) {
      return fail("ITEM_NOT_FOUND_IN_INVENTORY", `protected item not found. key=${itemInstanceId}`);
    }

    // groupKey 인덱스 정리용
    const groupKey = typeof instance.groupKey === "string" ? instance.groupKey : null;
    if (!groupKey) return fail("MISSING_GROUP_KEY", "inventory item is missing groupKey");
    const idxGroup = `IDX_${groupKey}`;

    // ---- ensure not already in escrow ----
    const escrowExisting = await getCustomItemsByKeys(api, projectId, escrowCustomId, [itemInstanceId]);
    if (escrowExisting.has(itemInstanceId)) {
      return fail("ITEM_ALREADY_IN_ESCROW", `escrow already has this key. key=${itemInstanceId}`);
    }

    // Grant 설계상 customId 변경만으로 이동 불가(Protected Items) -> 명시 Warning
    logger.warning("CreateListing fallback: inventory is Protected Items; moving to escrow requires cross-scope copy+delete (not customId change).");

    // ---- read & update inventory indexes ----
    const idxMap = await getProtectedItemsByKeys(api, projectId, playerId, [IDX_ALL, idxGroup]);
    const nextAll = normalizeIndex(idxMap.get(IDX_ALL));
    const nextGroup = normalizeIndex(idxMap.get(idxGroup));

    const beforeAllLen = nextAll.keys.length;
    const beforeGroupLen = nextGroup.keys.length;

    nextAll.keys = nextAll.keys.filter((k) => k !== itemInstanceId);
    nextGroup.keys = nextGroup.keys.filter((k) => k !== itemInstanceId);

    if (nextAll.keys.length === beforeAllLen) {
      logger.warning(`CreateListing fallback: IDX_ALL did not contain item key (index drift). key=${itemInstanceId}`);
    }
    if (nextGroup.keys.length === beforeGroupLen) {
      logger.warning(`CreateListing fallback: ${idxGroup} did not contain item key (index drift). key=${itemInstanceId}`);
    }

    // ---- move item to escrow: set escrow -> delete protected + write index updates (batch) ----
    try {
      await setCustomItemValue(api, projectId, escrowCustomId, itemInstanceId, instance);
    } catch (e) {
      logger.warning(`CreateListing fallback: failed to set escrow item. key=${itemInstanceId}, escrowCustomId=${escrowCustomId}`);
      return fail("FAILED_SET_ESCROW", safeErrorMessage(e));
    }

    try {
      const batchData = [
        { key: itemInstanceId, value: null, isDelete: true }, // delete protected item
        { key: IDX_ALL, value: nextAll },
        { key: idxGroup, value: nextGroup },
      ];
      await setProtectedItemBatchWithDeletes(api, projectId, playerId, batchData);
    } catch (e) {
      logger.warning(`CreateListing fallback: failed to delete protected item / update indexes after escrow set. key=${itemInstanceId}`);

      // rollback: remove escrow copy (best-effort)
      try {
        await deleteCustomItemKey(api, projectId, escrowCustomId, itemInstanceId);
      } catch (re) {
        logger.warning(`CreateListing fallback: rollback failed (delete escrow). key=${itemInstanceId}, err=${safeErrorMessage(re)}`);
      }

      return fail("FAILED_REMOVE_FROM_INVENTORY", safeErrorMessage(e));
    }

    // ---- write listing + indexes (Custom Items) ----
    try {
      await setCustomItemValue(api, projectId, listingsCustomId, listingKey, listing);

      const indexValue = {
        listingId,
        status: "ACTIVE",
        sellerPlayerId: playerId,
        createdAtKey,
        priceBucket12,
      };

      for (const k of indexKeys) {
        await setCustomItemValue(api, projectId, indexesCustomId, k, indexValue);
      }
    } catch (e) {
      logger.warning(`CreateListing fallback: failed to write listing/indexes after moving item to escrow. listingId=${listingId}`);

      // rollback: move item back to inventory (best-effort)
      try {
        // restore protected item + indexes
        nextAll.keys.push(itemInstanceId);
        nextGroup.keys.push(itemInstanceId);

        const restoreBatch = [
          { key: itemInstanceId, value: instance },
          { key: IDX_ALL, value: dedupIndex(nextAll) },
          { key: idxGroup, value: dedupIndex(nextGroup) },
        ];
        await api.setProtectedItemBatch(projectId, playerId, { data: restoreBatch });

        // remove escrow
        await deleteCustomItemKey(api, projectId, escrowCustomId, itemInstanceId);
      } catch (re) {
        logger.warning(`CreateListing fallback: rollback failed (restore inventory). key=${itemInstanceId}, err=${safeErrorMessage(re)}`);
      }

      return fail("FAILED_WRITE_LISTING_OR_INDEX", safeErrorMessage(e));
    }

    return {
      ok: true,
      listingId,
      listingKey,
      listing,
      indexKeys,
      dryRun: false,
    };
  } catch (e) {
    return fail("UNHANDLED_EXCEPTION", safeErrorMessage(e));
  }
};

function fail(errorCode, errorMessage) {
  return { ok: false, errorCode: String(errorCode), errorMessage: String(errorMessage) };
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function normalizeIndex(raw) {
  if (!isPlainObject(raw)) return { keys: [] };
  const keys = Array.isArray(raw.keys) ? raw.keys.filter((k) => typeof k === "string") : [];
  return { keys };
}

function dedupIndex(idx) {
  const out = { keys: [] };
  const set = new Set();
  for (const k of Array.isArray(idx?.keys) ? idx.keys : []) {
    if (typeof k !== "string") continue;
    if (set.has(k)) continue;
    set.add(k);
    out.keys.push(k);
  }
  return out;
}

function toCreatedAtKeyUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "00000000000000000";
  const pad = (n, w) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}` +
    `${pad(d.getUTCMonth() + 1, 2)}` +
    `${pad(d.getUTCDate(), 2)}` +
    `${pad(d.getUTCHours(), 2)}` +
    `${pad(d.getUTCMinutes(), 2)}` +
    `${pad(d.getUTCSeconds(), 2)}` +
    `${pad(d.getUTCMilliseconds(), 3)}`
  );
}

async function getProtectedItemsByKeys(api, projectId, playerId, keys) {
  const map = new Map();
  if (!Array.isArray(keys) || keys.length === 0) return map;

  const res = await api.getProtectedItems(projectId, playerId, keys);
  const items = res?.data?.results ?? [];
  for (const it of Array.isArray(items) ? items : []) {
    if (typeof it?.key === "string") map.set(it.key, it?.value);
  }
  return map;
}

async function deleteProtectedItemKey(api, projectId, playerId, key) {
  await api.deleteProtectedItem(key, projectId, playerId);
}

async function setProtectedItemBatch(api, projectId, playerId, data) {
  await api.setProtectedItemBatch(projectId, playerId, { data });
}

async function getCustomItemsByKeys(api, projectId, customId, keys) {
  const map = new Map();
  if (!Array.isArray(keys) || keys.length === 0) return map;


  // getCustomItems(projectId, customId, keys?)
  const res = await api.getCustomItems(projectId, customId, keys);
  const items = res?.data?.results ?? [];
  for (const it of Array.isArray(items) ? items : []) {
    if (typeof it?.key === "string") map.set(it.key, it?.value);
  }
  return map;
}

async function setCustomItemValue(api, projectId, customId, key, value) {
  await api.setCustomItem(projectId, customId, { key, value });
}

async function deleteCustomItemKey(api, projectId, customId, key) {
  await api.deleteCustomItem(key, projectId, customId);
}

// Cloud Save v1.4 setProtectedItemBatch는 delete를 직접 지원하지 않는 경우가 있어
// delete가 필요할 때는 deleteProtectedItem + setProtectedItemBatch 조합을 쓴다.
// (무음 금지: 호출 실패는 상위에서 Warning+에러 처리)
async function setProtectedItemBatchWithDeletes(api, projectId, playerId, entries) {
  const deletes = [];
  const sets = [];

  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.key !== "string") continue;
    if (e.isDelete === true) deletes.push(e.key);
    else sets.push({ key: e.key, value: e.value });
  }

  for (const k of deletes) {
    await deleteProtectedItemKey(api, projectId, playerId, k);
  }

  if (sets.length > 0) {
    await setProtectedItemBatch(api, projectId, playerId, sets);
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

module.exports.params = {
  itemInstanceId: { type: "String", required: true },
  price: { type: "Number", required: true },
  currencyId: { type: "String", required: true },
  listingsCustomId: { type: "String", required: false },
  indexesCustomId: { type: "String", required: false },
  escrowCustomId: { type: "String", required: false },
  nowIso: { type: "String", required: false },
  priceBucketSize: { type: "Number", required: false },
  dryRun: { type: "Boolean", required: false },
  expiresInSeconds: { type: "Number", required: false },
};