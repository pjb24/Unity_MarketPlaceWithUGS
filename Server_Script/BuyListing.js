/**
 * BuyListing
 *
 * 목적:
 * - ACTIVE 리스팅을 구매 처리한다.
 * - buyer 잔액을 Economy로 검증/차감한다. (buyer 본인 토큰)
 * - seller 지급은 즉시 Economy 증액하지 않고, proceeds(Custom Items)에 적립한다.
 * - season pool(Custom Items) 적립은 기존대로 수행한다.
 * - escrow(Custom Items) 아이템을 buyer 인벤(Protected Items)으로 copy+delete로 이동한다. (경고 로그)
 * - listing 상태를 SOLD로 갱신하고, ACTIVE 인덱스를 제거한다.
 * - trade record + trade index(구매자/판매자)를 기록한다.
 * 
 * RemoteConfig(key="market") 사용:
 * - sellerCredit = price * (1 - feeRateTotal)
 * - poolCredit   = price * feeRatePool
 * - burn         = price - sellerCredit - poolCredit (암묵 소각: 어디에도 지급하지 않음)
 *
 * 저장 위치(기본값):
 * - 리스팅(Custom Items): customId="market_listings", key="LISTING_<listingId>"
 * - 인덱스(Custom Items): customId="market_indexes"
 * - 에스크로 아이템(Custom Items): customId="escrow", key="<itemInstanceId>"  // prefix 없음
 * - 구매자 인벤(Protected Items): key="<itemInstanceId>"  // prefix 없음
 * - 구매자 인덱스(Protected Items): "IDX_ALL", `IDX_${groupKey}`
 * - 거래 레코드(Custom Items): customId="market_trades", key="TRADE_<tradeId>"
 * - 정산 적립(Custom Items): customId="market_proceeds", key="PROCEEDS_<sellerPlayerId>_<currencyId>"
 * - 시즌풀(Custom Items): customId="season_pool", key="POOL_<currencyId>"
 * - 락(Custom Items): customId="txnlocks", key="BUYLISTING_<listingId>"
 *
 * key 규칙:
 * - 아이템 id(=instanceId/instanceKey)는 prefix 금지.
 * - 인덱스 키는 CreateListing 규칙과 동일하게 ACTIVE 인덱스를 삭제한다.
 *
 * 에러·폴백 규칙:
 * - 무음 폴백 금지. 복구/롤백 best-effort는 반드시 Warning 로그를 남긴다.
 * - “customId 변경으로 이동”은 Custom Items 내부에서만 가능하다.
 *   buyer 인벤은 Protected Items라서 escrow->buyer는 copy+delete로 처리하며 Warning 로그를 남긴다.
 *
 * params (최대 10개):
 *  1) listingId: string (필수)
 *  2) listingsCustomId: string (선택, 기본 "market_listings")
 *  3) indexesCustomId: string (선택, 기본 "market_indexes")
 *  4) escrowCustomId: string (선택, 기본 "escrow")
 *  5) tradesCustomId: string (선택, 기본 "market_trades")
 *  6) proceedsCustomId: string (선택, 기본 "market_proceeds")
 *  7) lockCustomId: string (선택, 기본 "txnlocks")
 *  8) requirePrice: number (선택) // 클라가 본 가격과 불일치 방지
 *  9) ttlSeconds: number (선택, 기본 10) // 락 TTL
 * 10) dryRun: boolean (선택, 기본 false)
 *
 * return:
 * - ok=true: listingId, tradeId, itemInstanceId, price, currencyId, sellerPlayerId, buyerPlayerId, nowIso, fee, proceedsKey
 * - ok=false: errorCode, errorMessage
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");
const { CurrenciesApi } = require("@unity-services/economy-2.4");
const { SettingsApi } = require("@unity-services/remote-config-1.1");

const IDX_ALL = "IDX_ALL";
const SEASON_POOL_CUSTOM_ID = "season_pool";

module.exports = async function BuyListing({ params, context, logger }) {
  try {
    const {
      listingId,
      listingsCustomId = "market_listings",
      indexesCustomId = "market_indexes",
      escrowCustomId = "escrow",
      tradesCustomId = "market_trades",
      proceedsCustomId = "market_proceeds",
      lockCustomId = "txnlocks",
      requirePrice,
      ttlSeconds = 10,
      dryRun = false,
    } = params ?? {};

    // ---- validate (no silent fallback) ----
    if (typeof listingId !== "string" || listingId.length === 0) return fail("INVALID_LISTING_ID", "listingId is required");
    if (listingId.trim() !== listingId) return fail("INVALID_LISTING_ID", "listingId must not contain leading/trailing whitespace");

    if (typeof listingsCustomId !== "string" || listingsCustomId.length === 0) return fail("INVALID_LISTINGS_CUSTOM_ID", "listingsCustomId must be a string");
    if (typeof indexesCustomId !== "string" || indexesCustomId.length === 0) return fail("INVALID_INDEXES_CUSTOM_ID", "indexesCustomId must be a string");
    if (typeof escrowCustomId !== "string" || escrowCustomId.length === 0) return fail("INVALID_ESCROW_CUSTOM_ID", "escrowCustomId must be a string");
    if (typeof tradesCustomId !== "string" || tradesCustomId.length === 0) return fail("INVALID_TRADES_CUSTOM_ID", "tradesCustomId must be a string");
    if (typeof proceedsCustomId !== "string" || proceedsCustomId.length === 0) return fail("INVALID_PROCEEDS_CUSTOM_ID", "proceedsCustomId must be a string");
    if (typeof lockCustomId !== "string" || lockCustomId.length === 0) return fail("INVALID_LOCK_CUSTOM_ID", "lockCustomId must be a string");

    if (requirePrice != null && (typeof requirePrice !== "number" || !Number.isFinite(requirePrice) || requirePrice < 1)) {
      return fail("INVALID_REQUIRE_PRICE", "requirePrice must be a finite number >= 1 when provided");
    }
    if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds) || !Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
      return fail("INVALID_TTL_SECONDS", "ttlSeconds must be an integer >= 1");
    }
    if (typeof dryRun !== "boolean") return fail("INVALID_DRY_RUN", "dryRun must be a boolean");

    const projectId = context.projectId;
    const buyerPlayerId = context.playerId;

    const api = new DataApi(context);
    const currencyApi = new CurrenciesApi({ accessToken: context.accessToken });
    const rcApi = new SettingsApi({ accessToken: context.accessToken });

    const _nowIso = new Date().toISOString();
    const listingKey = `LISTING_${listingId}`;

    // ---- lock (prevent double-buy) ----
    const lockKey = `BUYLISTING_${listingId}`;
    const token = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    const expiresAt = Date.now() + ttlSeconds * 1000;

    if (!dryRun) {
      const acquired = await tryAcquireCustomLock(api, projectId, lockCustomId, lockKey, token, expiresAt, logger);
      if (!acquired) return fail("LOCK_NOT_ACQUIRED", "another buy is in progress");
    }

    try {
      // ---- read listing ----
      const listingMap = await getCustomItemsByKeys(api, projectId, listingsCustomId, [listingKey]);
      const listing = listingMap.get(listingKey);

      if (!isPlainObject(listing)) return fail("LISTING_NOT_FOUND", `listing not found. key=${listingKey}`);
      if (listing.status !== "ACTIVE") return fail("LISTING_NOT_ACTIVE", `listing status is not ACTIVE. status=${String(listing.status)}`);

      const sellerPlayerId = listing.sellerPlayerId;
      const itemInstanceId = listing.itemInstanceId;
      const price = listing.price;
      const currencyId = listing.currencyId;

      if (typeof sellerPlayerId !== "string" || sellerPlayerId.length === 0) return fail("MISSING_SELLER", "listing is missing sellerPlayerId");
      if (sellerPlayerId === buyerPlayerId) return fail("CANNOT_BUY_OWN_LISTING", "buyer and seller are the same playerId");

      if (typeof itemInstanceId !== "string" || itemInstanceId.length === 0) return fail("MISSING_ITEM_INSTANCE_ID", "listing is missing itemInstanceId");
      if (typeof price !== "number" || !Number.isFinite(price) || price < 1) return fail("INVALID_LISTING_PRICE", "listing price is invalid");
      if (typeof currencyId !== "string" || currencyId.length === 0) return fail("MISSING_CURRENCY_ID", "listing is missing currencyId");

      if (requirePrice != null && price !== requirePrice) {
        return fail("PRICE_MISMATCH", `price mismatch. listingPrice=${price}, requirePrice=${requirePrice}`);
      }

      // ---- read escrow item ----
      const escrowMap = await getCustomItemsByKeys(api, projectId, escrowCustomId, [itemInstanceId]);
      const escrowItem = escrowMap.get(itemInstanceId);

      if (!isPlainObject(escrowItem)) return fail("ESCROW_ITEM_NOT_FOUND", `escrow item not found. key=${itemInstanceId}`);

      // ---- Remote Config: market ----
      const marketCfg = await getMarketConfigOrFail(rcApi, projectId, buyerPlayerId, logger);
      const feeRateTotal = marketCfg.feeRateTotal;
      const feeRatePool = marketCfg.feeRatePool;

      if (!isFinite01(feeRateTotal) || !isFinite01(feeRatePool) || feeRatePool > feeRateTotal) {
        return fail("INVALID_MARKET_CONFIG", `invalid fee rates. feeRateTotal=${feeRateTotal}, feeRatePool=${feeRatePool}`);
      }

      const sellerCredit = roundAmount(price * (1 - feeRateTotal));
      const poolCredit = roundAmount(price * feeRatePool);
      const burnAmount = roundAmount(price - sellerCredit - poolCredit);

      if (sellerCredit < 0 || poolCredit < 0 || burnAmount < -1e-6) {
        return fail("INVALID_FEE_CALC", `fee calc invalid. sellerCredit=${sellerCredit}, poolCredit=${poolCredit}, burnAmount=${burnAmount}`);
      }

      // ---- validate buyer balance ----
      // NOTE: Economy SDK 메서드명/시그니처는 프로젝트 세팅/버전에 따라 다를 수 있음.
      // 여기서는 economy-2.4 CurrenciesApi의 balance 조회/증감 패턴을 사용한다.
      const buyerBalance = await getCurrencyBalance(currencyApi, projectId, buyerPlayerId, currencyId);
      if (buyerBalance < price) return fail("INSUFFICIENT_FUNDS", `buyer balance is insufficient. balance=${buyerBalance}, price=${price}`);

      const proceedsKey = `PROCEEDS_${sellerPlayerId}_${currencyId}`;

      // ---- dryRun: stop before any writes ----
      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          listingId,
          listingKey,
          sellerPlayerId,
          buyerPlayerId,
          itemInstanceId,
          price,
          currencyId,
          nowIso: _nowIso,
          proceedsKey,
          fee: { feeRateTotal, feeRatePool, sellerCredit, poolCredit, burnAmount },
        };
      }

      // ---- debit buyer / credit seller / credit season pool ----
      // 실패하면 즉시 종료. 이후 단계 실패 시 롤백은 best-effort.
      await decrementCurrency(currencyApi, projectId, buyerPlayerId, currencyId, price);
      
      let proceedsAdded = false;
      let poolAdded = false;

      try {
        // ---- add proceeds (seller claim later) ----
        await addToProceeds(api, projectId, proceedsCustomId, sellerPlayerId, currencyId, sellerCredit, _nowIso);
        proceedsAdded = true;

        // ---- add season pool ----
        await addToSeasonPool(api, projectId, currencyId, poolCredit, _nowIso);
        poolAdded = true;
      } catch (e) {
        logger.warning(`BuyListing FALLBACK: proceeds/pool write failed after buyer debit. will try refund buyer. err=${safeErrorMessage(e)}`);

        // 롤백 best-effort
        await bestEffortRollbackAfterDebit(
          buyerCurrencyApi,
          api,
          projectId,
          buyerPlayerId,
          currencyId,
          price,
          proceedsCustomId,
          sellerPlayerId,
          sellerCredit,
          proceedsAdded,
          poolAdded,
          poolCredit,
          logger
        );

        return fail("SETTLEMENT_WRITE_FAILED", safeErrorMessage(e));
      }

      // ---- move item escrow -> buyer inventory (Protected Items) ----
      // customId 변경만으로 이동 불가(스코프가 다름) -> copy+delete + Warning
      logger.warning("BuyListing FALLBACK: escrow(Custom Items) -> buyer inventory(Protected Items) is cross-scope; moving via copy+delete (not customId change).");

      const groupKey = (typeof escrowItem.groupKey === "string" && escrowItem.groupKey.length > 0) ? escrowItem.groupKey : null;
      if (!groupKey) {
        logger.warning("BuyListing FALLBACK: escrow item missing groupKey. will try rollback currencies+pool.");
        await bestEffortRollbackAfterDebit(
          buyerCurrencyApi,
          api,
          projectId,
          buyerPlayerId,
          currencyId,
          price,
          proceedsCustomId,
          sellerPlayerId,
          sellerCredit,
          proceedsAdded,
          poolAdded,
          poolCredit,
          logger
        );
        return fail("MISSING_GROUP_KEY", "escrow item is missing groupKey");
      }

      const idxGroup = `IDX_${groupKey}`;

      // buyer 인덱스 읽기/갱신
      const idxMap = await getProtectedItemsByKeys(api, projectId, buyerPlayerId, [IDX_ALL, idxGroup]);
      const nextAll = normalizeIndex(idxMap.get(IDX_ALL));
      const nextGroup = normalizeIndex(idxMap.get(idxGroup));

      if (!nextAll.keys.includes(itemInstanceId)) nextAll.keys.push(itemInstanceId);
      if (!nextGroup.keys.includes(itemInstanceId)) nextGroup.keys.push(itemInstanceId);

      // 1) buyer protected item set + indexes set (batch)
      try {
        await api.setProtectedItemBatch(projectId, buyerPlayerId, {
          data: [
            { key: itemInstanceId, value: escrowItem },
            { key: IDX_ALL, value: dedupIndex(nextAll) },
            { key: idxGroup, value: dedupIndex(nextGroup) },
          ],
        });
      } catch (e) {
        logger.warning(`BuyListing FALLBACK: failed to write buyer inventory. will try rollback currencies+pool. err=${safeErrorMessage(e)}`);
        
        await bestEffortRollbackAfterDebit(
          buyerCurrencyApi,
          api,
          projectId,
          buyerPlayerId,
          currencyId,
          price,
          proceedsCustomId,
          sellerPlayerId,
          sellerCredit,
          proceedsAdded,
          poolAdded,
          poolCredit,
          logger
        );

        return fail("FAILED_WRITE_BUYER_INVENTORY", safeErrorMessage(e));
      }

      // 2) delete escrow custom item
      try {
        await api.deleteCustomItem(itemInstanceId, projectId, escrowCustomId);
      } catch (e) {
        // 아이템이 중복 지급될 수는 없지만(이미 buyer에 들어감) escrow 찌꺼기 발생 -> 경고 + 계속 진행
        logger.warning(`BuyListing FALLBACK: failed to delete escrow item (stale escrow). key=${itemInstanceId}, err=${safeErrorMessage(e)}`);
      }

      // ---- update listing + delete ACTIVE indexes ----
      const updatedAtKey = toCreatedAtKeyUtc(_nowIso);

      const nextListing = {
        ...listing,
        status: "SOLD",
        buyerPlayerId,
        soldAt: _nowIso,
        soldAtKey: updatedAtKey,
        updatedAt: _nowIso,
      };

      try {
        await api.setCustomItem(projectId, listingsCustomId, { key: listingKey, value: nextListing });

        // CreateListing이 만든 ACTIVE 인덱스 키 구성요소
        const createdAtKey = typeof listing.createdAtKey === "string" ? listing.createdAtKey : null;
        const expiresAtKey = typeof listing.expiresAtKey === "string" ? listing.expiresAtKey : null;

        if (!createdAtKey || !expiresAtKey) {
          logger.warning(`BuyListing FALLBACK: listing missing createdAtKey/expiresAtKey. skip deleting some ACTIVE indexes. listingId=${listingId}`);
        } else {
          // seller status index는 bucket 불필요
          const k1 = `IDX_SELLER_STATUS_${sellerPlayerId}_ACTIVE_${listingId}`;
          const k2 = `IDX_STATUS_CREATEDAT_ACTIVE_${createdAtKey}_${listingId}`;
          const k4 = `IDX_STATUS_EXPIREAT_ACTIVE_${expiresAtKey}_${listingId}`;

          await safeDeleteCustomKey(api, projectId, indexesCustomId, k1, logger);
          await safeDeleteCustomKey(api, projectId, indexesCustomId, k2, logger);
          await safeDeleteCustomKey(api, projectId, indexesCustomId, k4, logger);

          logger.warning(`BuyListing FALLBACK: cannot delete IDX_STATUS_PRICE_ACTIVE_ because priceBucket12 is not stored in listing. listingId=${listingId}`);
        }
      } catch (e) {
        // 구매 자체는 완료(통화/아이템 이동). 인덱스/리스팅만 꼬임 -> 경고 + 성공 반환
        logger.warning(`BuyListing FALLBACK: failed to update listing or delete indexes. listingId=${listingId}, err=${safeErrorMessage(e)}`);
      }

      // ---- write trade record + trade indexes ----
      const tradeId = `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      const tradeKey = `TRADE_${tradeId}`;
      const createdAtKeyTrade = toCreatedAtKeyUtc(_nowIso);

      const trade = {
        tradeId,
        listingId,
        itemInstanceId,
        currencyId,
        price,
        sellerPlayerId,
        buyerPlayerId,
        createdAt: _nowIso,
        createdAtKey: createdAtKeyTrade,

        feeRateTotal,
        feeRatePool,
        sellerCredit,
        poolCredit,
        burnAmount,

        settlement: { proceedsCustomId, proceedsKey },
      };

      try {
        await api.setCustomItem(projectId, tradesCustomId, { key: tradeKey, value: trade });

        const idxSeller = `IDX_TRADE_SELLER_${sellerPlayerId}_${createdAtKeyTrade}_${tradeId}`;
        const idxBuyer = `IDX_TRADE_BUYER_${buyerPlayerId}_${createdAtKeyTrade}_${tradeId}`;

        await api.setCustomItem(projectId, indexesCustomId, { key: idxSeller, value: { tradeId, role: "SELL", createdAtKey: createdAtKeyTrade } });
        await api.setCustomItem(projectId, indexesCustomId, { key: idxBuyer, value: { tradeId, role: "BUY", createdAtKey: createdAtKeyTrade } });
      } catch (e) {
        logger.warning(`BuyListing FALLBACK: failed to write trade record/indexes. listingId=${listingId}, err=${safeErrorMessage(e)}`);
      }

      return {
        ok: true,
        listingId,
        tradeId,
        itemInstanceId,
        price,
        currencyId,
        sellerPlayerId,
        buyerPlayerId,
        nowIso: _nowIso,
        proceedsKey,
        fee: { feeRateTotal, feeRatePool, sellerCredit, poolCredit, burnAmount },
      };
    } finally {
      // ---- release lock (best-effort) ----
      if (!dryRun) {
        try {
          await api.deleteCustomItem(lockKey, projectId, lockCustomId);
        } catch (e) {
          logger.warning(`BuyListing FALLBACK: failed to release lock. key=${lockKey}, err=${safeErrorMessage(e)}`);
        }
      }
    }
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

async function getCustomItemsByKeys(api, projectId, customId, keys) {
  const map = new Map();
  if (!Array.isArray(keys) || keys.length === 0) return map;

  const res = await api.getCustomItems(projectId, customId, keys);
  const items = res?.data?.results ?? [];
  for (const it of Array.isArray(items) ? items : []) {
    if (typeof it?.key === "string") map.set(it.key, it?.value);
  }
  return map;
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

async function safeDeleteCustomKey(api, projectId, customId, key, logger) {
  try {
    await api.deleteCustomItem(key, projectId, customId);
  } catch (e) {
    logger.warning(`BuyListing FALLBACK: failed to delete index key. customId=${customId}, key=${key}, err=${safeErrorMessage(e)}`);
  }
}

// ---- lock helpers ----

async function tryAcquireCustomLock(api, projectId, customId, key, token, expiresAtMs, logger) {
  // 1) read existing
  try {
    const m = await getCustomItemsByKeys(api, projectId, customId, [key]);
    const cur = m.get(key);
    if (isPlainObject(cur) && typeof cur.expiresAtMs === "number" && cur.expiresAtMs > Date.now()) {
      return false;
    }
  } catch (e) {
    logger.warning(`BuyListing FALLBACK: lock pre-read failed. will still try set. err=${safeErrorMessage(e)}`);
  }

  // 2) write
  try {
    await api.setCustomItem(projectId, customId, {
      key,
      value: { token, acquiredAtMs: Date.now(), expiresAtMs },
    });
  } catch (e) {
    logger.warning(`BuyListing FALLBACK: lock set failed. err=${safeErrorMessage(e)}`);
    return false;
  }

  // 3) verify
  try {
    const m2 = await getCustomItemsByKeys(api, projectId, customId, [key]);
    const v = m2.get(key);
    return isPlainObject(v) && v.token === token;
  } catch (e) {
    logger.warning(`BuyListing FALLBACK: lock verify failed. err=${safeErrorMessage(e)}`);
    return false;
  }
}

// ---- Remote Config helpers ----

async function getMarketConfigOrFail(rcApi, projectId, userId, logger) {
  if (typeof rcApi.assignSettings !== "function") {
    throw new Error("SettingsApi.assignSettings is not a function (check remote-config SDK version/import)");
  }

  let res;
  try {
    // v1.1: assignSettings(SettingsDeliveryRequest)
    // - projectId, userId 필수
    // - key: string[] (keys 아님)
    // - attributes는 선택이지만, 규칙/오버라이드 쓰면 넣는 게 안전
    res = await rcApi.assignSettings({
      projectId,
      userId,
      key: ["market"],
      attributes: { unity: {}, app: {}, user: {} },
    });
  } catch (e) {
    throw new Error(`RemoteConfig assignSettings failed. err=${safeErrorMessage(e)}`);
  }

  const settings = res?.data?.configs?.settings;
  const raw = settings?.market?.value ?? settings?.market;
  if (raw == null) {
    logger.warning("BuyListing FALLBACK: RemoteConfig key 'market' missing.");
    throw new Error("RemoteConfig 'market' missing");
  }

  const obj = (typeof raw === "string") ? safeJsonParse(raw) : raw;
  if (!isPlainObject(obj)) throw new Error("RemoteConfig 'market' value is not an object/json");

  return {
    feeRateTotal: obj.feeRateTotal,
    feeRatePool: obj.feeRatePool,
    feeRateBurn: obj.feeRateBurn,
    listingExpireDays: obj.listingExpireDays,
    priceMin: obj.priceMin,
    priceMax: obj.priceMax,
  };
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function isFinite01(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

function roundAmount(v) {
  // Economy가 소수 허용일 수 있으니 과도하게 자르지 말고, 부동소수 오차만 줄임
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.round(v * 1e6) / 1e6;
}

// ---- Season pool (Cloud Save Custom Items) ----
// customId = "season_pool", key = "POOL_<currencyId>", value = { currencyId, balance }
async function addToSeasonPool(api, projectId, currencyId, amount) {
  if (amount <= 0) return;

  const key = `POOL_${currencyId}`;
  const m = await getCustomItemsByKeys(api, projectId, SEASON_POOL_CUSTOM_ID, [key]);
  const cur = m.get(key);

  const curBal = (isPlainObject(cur) && typeof cur.balance === "number" && Number.isFinite(cur.balance)) ? cur.balance : 0;
  const next = {
    currencyId,
    balance: roundAmount(curBal + amount),
    updatedAt: new Date().toISOString(),
  };

  await api.setCustomItem(projectId, SEASON_POOL_CUSTOM_ID, { key, value: next });
}

async function removeFromSeasonPoolBestEffort(api, projectId, currencyId, amount, logger) {
  if (amount <= 0) return;

  const key = `POOL_${currencyId}`;
  try {
    const m = await getCustomItemsByKeys(api, projectId, SEASON_POOL_CUSTOM_ID, [key]);
    const cur = m.get(key);

    const curBal = (isPlainObject(cur) && typeof cur.balance === "number" && Number.isFinite(cur.balance)) ? cur.balance : 0;
    const nextBal = roundAmount(Math.max(0, curBal - amount));

    await api.setCustomItem(projectId, SEASON_POOL_CUSTOM_ID, {
      key,
      value: { currencyId, balance: nextBal, updatedAt: new Date().toISOString() },
    });
  } catch (e) {
    logger.warning(`BuyListing FALLBACK: rollback season pool failed. err=${safeErrorMessage(e)}`);
  }
}

// ---- proceeds (settlement) ----
async function addToProceeds(api, projectId, proceedsCustomId, sellerPlayerId, currencyId, amount, nowIso) {
  if (amount <= 0) return;

  const key = `PROCEEDS_${sellerPlayerId}_${currencyId}`;
  const m = await getCustomItemsByKeys(api, projectId, proceedsCustomId, [key]);
  const cur = m.get(key);

  const curBal = (isPlainObject(cur) && typeof cur.balance === "number" && Number.isFinite(cur.balance)) ? cur.balance : 0;

  await api.setCustomItem(projectId, proceedsCustomId, {
    key,
    value: {
      sellerPlayerId,
      currencyId,
      balance: roundAmount(curBal + amount),
      updatedAt: nowIso,
    },
  });
}

async function removeFromProceedsBestEffort(api, projectId, proceedsCustomId, sellerPlayerId, currencyId, amount, logger) {
  if (amount <= 0) return;

  const key = `PROCEEDS_${sellerPlayerId}_${currencyId}`;
  try {
    const m = await getCustomItemsByKeys(api, projectId, proceedsCustomId, [key]);
    const cur = m.get(key);

    const curBal = (isPlainObject(cur) && typeof cur.balance === "number" && Number.isFinite(cur.balance)) ? cur.balance : 0;
    const nextBal = roundAmount(Math.max(0, curBal - amount));

    await api.setCustomItem(projectId, proceedsCustomId, {
      key,
      value: {
        sellerPlayerId,
        currencyId,
        balance: nextBal,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    logger.warning(`BuyListing FALLBACK: rollback proceeds failed. err=${safeErrorMessage(e)}`);
  }
}

async function bestEffortRollbackAfterDebit(
  buyerCurrencyApi,
  api,
  projectId,
  buyerPlayerId,
  currencyId,
  price,
  proceedsCustomId,
  sellerPlayerId,
  sellerCredit,
  proceedsAdded,
  poolAdded,
  poolCredit,
  logger
) {
  try {
    await incrementCurrency(buyerCurrencyApi, projectId, buyerPlayerId, currencyId, price);
  } catch (e) {
    logger.warning(`BuyListing FALLBACK: refund buyer failed. err=${safeErrorMessage(e)}`);
  }

  if (proceedsAdded) {
    await removeFromProceedsBestEffort(api, projectId, proceedsCustomId, sellerPlayerId, currencyId, sellerCredit, logger);
  }
  if (poolAdded) {
    await removeFromSeasonPoolBestEffort(api, projectId, currencyId, poolCredit, logger);
  }
}

// ---- economy helpers (economy-2.4) ----
async function getCurrencyBalance(currencyApi, projectId, playerId, currencyId) {
    // v2.4: getPlayerCurrencies({ projectId, playerId, limit, after, configAssignmentHash })
  if (typeof currencyApi.getPlayerCurrencies !== "function") {
    throw new Error("CurrenciesApi.getPlayerCurrencies is not a function (check economy SDK version/import)");
  }

  // limit 기본 20이라 넉넉히
  const res = await currencyApi.getPlayerCurrencies({ projectId, playerId, limit: 100 });
  const results = res?.data?.results ?? [];
  for (const r of Array.isArray(results) ? results : []) {
    if (r?.currencyId === currencyId) {
      const bal = r?.balance;
      return (typeof bal === "number" && Number.isFinite(bal)) ? bal : 0;
    }
  }
  return 0;
}

async function decrementCurrency(currencyApi, projectId, playerId, currencyId, amount) {
    if (typeof currencyApi.decrementPlayerCurrencyBalance !== "function") {
    throw new Error("CurrenciesApi.decrementPlayerCurrencyBalance is not a function (check economy SDK version/import)");
  }

  await currencyApi.decrementPlayerCurrencyBalance({
    projectId,
    playerId,
    currencyId,
    currencyModifyBalanceRequest: { amount },
  });
}

async function incrementCurrency(currencyApi, projectId, playerId, currencyId, amount) {
  if (typeof currencyApi.incrementPlayerCurrencyBalance !== "function") {
    throw new Error("CurrenciesApi.incrementPlayerCurrencyBalance is not a function (check economy SDK version/import)");
  }

  await currencyApi.incrementPlayerCurrencyBalance({
    projectId,
    playerId,
    currencyId,
    currencyModifyBalanceRequest: { amount },
  });
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
  listingId: { type: "String", required: true },
  listingsCustomId: { type: "String", required: false },
  indexesCustomId: { type: "String", required: false },
  escrowCustomId: { type: "String", required: false },
  tradesCustomId: { type: "String", required: false },
  proceedsCustomId: { type: "String", required: false },
  lockCustomId: { type: "String", required: false },
  requirePrice: { type: "Number", required: false },
  ttlSeconds: { type: "Number", required: false },
  dryRun: { type: "Boolean", required: false },
};