/**
 * ClaimEarning
 *
 * 목적:
 * - BuyListing에서 seller에게 즉시 지급하지 않고 market_proceeds(Custom Items)에 적립한 대금을,
 *   seller가 Economy 잔액으로 “정산(Claim)”하는 기능.
 *
 * 저장 위치(기본값):
 * - 정산 적립(Custom Items): customId="market_proceeds", key="PROCEEDS_<sellerPlayerId>_<currencyId>"
 * - 락(Custom Items): customId="txnlocks", key="CLAIMEARNING_<sellerPlayerId>_<currencyId>"
 *
 * key 규칙:
 * - 아이템 id에 prefix 붙이지 않기(본 스크립트는 아이템 id를 다루지 않음)
 * - proceedsKey는 "PROCEEDS_<playerId>_<currencyId>" 고정
 *
 * groupKey 규칙:
 * - 해당 없음 (아이템/인벤 인덱스 미사용)
 *
 * 인덱스 규칙:
 * - 해당 없음
 *
 * 에러·폴백 규칙:
 * - 무음(silent) 폴백 금지.
 * - Economy 증액 성공 후 proceeds 0 처리 실패 시: Warning 로그 + Economy 롤백(decrement) best-effort 수행.
 * - proceeds가 없거나 balance<=0이면 정상 케이스로 ok=true, claimedAmount=0 반환(Warning 아님).
 *
 * params (최대 10개):
 *  1) currencyId: string (필수)  // MT 등
 *  2) proceedsCustomId: string (선택, 기본 "market_proceeds")
 *  3) lockCustomId: string (선택, 기본 "txnlocks")
 *  4) ttlSeconds: number (선택, 기본 10)
 *  5) dryRun: boolean (선택, 기본 false)
 *  6) minClaimAmount: number (선택, 기본 0) // 이 값 미만이면 claimed=0 처리
 *
 * return:
 * - ok=true: playerId, currencyId, proceedsKey, claimedAmount, beforeBalance, afterBalance, nowIso, dryRun
 * - ok=false: errorCode, errorMessage
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");
const { CurrenciesApi } = require("@unity-services/economy-2.4");

module.exports = async function ClaimEarning({ params, context, logger }) {
  try {
    const {
      currencyId,
      proceedsCustomId = "market_proceeds",
      lockCustomId = "txnlocks",
      ttlSeconds = 10,
      dryRun = false,
      minClaimAmount = 0,
    } = params ?? {};

    // ---- validate (no silent fallback) ----
    if (typeof currencyId !== "string" || currencyId.length === 0) return fail("INVALID_CURRENCY_ID", "currencyId is required");
    if (currencyId.trim() !== currencyId) return fail("INVALID_CURRENCY_ID", "currencyId must not contain leading/trailing whitespace");

    if (typeof proceedsCustomId !== "string" || proceedsCustomId.length === 0) return fail("INVALID_PROCEEDS_CUSTOM_ID", "proceedsCustomId must be a string");
    if (typeof lockCustomId !== "string" || lockCustomId.length === 0) return fail("INVALID_LOCK_CUSTOM_ID", "lockCustomId must be a string");

    if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds) || !Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
      return fail("INVALID_TTL_SECONDS", "ttlSeconds must be an integer >= 1");
    }
    if (typeof dryRun !== "boolean") return fail("INVALID_DRY_RUN", "dryRun must be a boolean");

    if (minClaimAmount != null && (typeof minClaimAmount !== "number" || !Number.isFinite(minClaimAmount) || minClaimAmount < 0)) {
      return fail("INVALID_MIN_CLAIM_AMOUNT", "minClaimAmount must be a finite number >= 0 when provided");
    }

    const projectId = context.projectId;
    const playerId = context.playerId;

    const api = new DataApi(context);
    const currencyApi = new CurrenciesApi({ accessToken: context.accessToken });

    const nowIso = new Date().toISOString();
    const proceedsKey = `PROCEEDS_${playerId}_${currencyId}`;

    // ---- lock (prevent double-claim) ----
    const lockKey = `CLAIMEARNING_${playerId}_${currencyId}`;
    const token = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    const expiresAtMs = Date.now() + ttlSeconds * 1000;

    if (!dryRun) {
      const acquired = await tryAcquireCustomLock(api, projectId, lockCustomId, lockKey, token, expiresAtMs, logger);
      if (!acquired) return fail("LOCK_NOT_ACQUIRED", "another claim is in progress");
    }

    try {
      // ---- read proceeds ----
      const m = await getCustomItemsByKeys(api, projectId, proceedsCustomId, [proceedsKey]);
      const cur = m.get(proceedsKey);

      const beforeBalance = readNumber(cur?.balance);
      const claimable = roundAmount(beforeBalance);

      if (claimable <= 0 || claimable < minClaimAmount) {
        return {
          ok: true,
          playerId,
          currencyId,
          proceedsKey,
          claimedAmount: 0,
          beforeBalance,
          afterBalance: beforeBalance,
          nowIso,
          dryRun,
        };
      }

      if (dryRun) {
        return {
          ok: true,
          playerId,
          currencyId,
          proceedsKey,
          claimedAmount: claimable,
          beforeBalance,
          afterBalance: roundAmount(beforeBalance - claimable),
          nowIso,
          dryRun: true,
        };
      }

      // ---- credit economy first (then zero proceeds; rollback best-effort on failure) ----
      try {
        await incrementCurrency(currencyApi, projectId, playerId, currencyId, claimable);
      } catch (e) {
        return fail("FAILED_CREDIT_CURRENCY", `incrementPlayerCurrencyBalance failed. err=${safeErrorMessage(e)}`);
      }

      try {
        // balance를 0으로 만들고, 마지막 정산 메타 남김
        await api.setCustomItem(projectId, proceedsCustomId, {
          key: proceedsKey,
          value: {
            sellerPlayerId: playerId,
            currencyId,
            balance: roundAmount(beforeBalance - claimable), // 보통 0
            lastClaimedAt: nowIso,
            lastClaimedAmount: claimable,
            updatedAt: nowIso,
          },
        });
      } catch (e) {
        // Economy 지급은 이미 끝남 -> 무음 금지: 경고 + 롤백 시도
        logger.warning(
          `ClaimEarning FALLBACK: proceeds update failed AFTER economy credit. will try rollback economy. proceedsKey=${proceedsKey}, err=${safeErrorMessage(e)}`
        );

        try {
          await decrementCurrency(currencyApi, projectId, playerId, currencyId, claimable);
          logger.warning(`ClaimEarning FALLBACK: economy rollback succeeded. amount=${claimable}, currencyId=${currencyId}`);
        } catch (e2) {
          logger.warning(
            `ClaimEarning FALLBACK: economy rollback FAILED. manual reconciliation required. amount=${claimable}, currencyId=${currencyId}, err=${safeErrorMessage(e2)}`
          );
        }

        return fail("FAILED_UPDATE_PROCEEDS", safeErrorMessage(e));
      }

      return {
        ok: true,
        playerId,
        currencyId,
        proceedsKey,
        claimedAmount: claimable,
        beforeBalance,
        afterBalance: roundAmount(beforeBalance - claimable),
        nowIso,
        dryRun: false,
      };
    } finally {
      // ---- release lock (best-effort) ----
      if (!dryRun) {
        try {
          await api.deleteCustomItem(lockKey, projectId, lockCustomId);
        } catch (e) {
          logger.warning(`ClaimEarning FALLBACK: failed to release lock. key=${lockKey}, err=${safeErrorMessage(e)}`);
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

function readNumber(v) {
  return (typeof v === "number" && Number.isFinite(v)) ? v : 0;
}

function roundAmount(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.round(v * 1e6) / 1e6;
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

// ---- lock helpers ----
async function tryAcquireCustomLock(api, projectId, customId, key, token, expiresAtMs, logger) {
  // 1) pre-read
  try {
    const m = await getCustomItemsByKeys(api, projectId, customId, [key]);
    const cur = m.get(key);
    if (cur && typeof cur === "object" && typeof cur.expiresAtMs === "number" && cur.expiresAtMs > Date.now()) {
      return false;
    }
  } catch (e) {
    logger.warning(`ClaimEarning FALLBACK: lock pre-read failed. will still try set. err=${safeErrorMessage(e)}`);
  }

  // 2) set
  try {
    await api.setCustomItem(projectId, customId, { key, value: { token, acquiredAtMs: Date.now(), expiresAtMs } });
  } catch (e) {
    logger.warning(`ClaimEarning FALLBACK: lock set failed. err=${safeErrorMessage(e)}`);
    return false;
  }

  // 3) verify
  try {
    const m2 = await getCustomItemsByKeys(api, projectId, customId, [key]);
    const v = m2.get(key);
    return v && typeof v === "object" && v.token === token;
  } catch (e) {
    logger.warning(`ClaimEarning FALLBACK: lock verify failed. err=${safeErrorMessage(e)}`);
    return false;
  }
}

// ---- economy helpers (economy-2.4) ----
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
  currencyId: { type: "String", required: true },
  proceedsCustomId: { type: "String", required: false },
  lockCustomId: { type: "String", required: false },
  ttlSeconds: { type: "Number", required: false },
  dryRun: { type: "Boolean", required: false },
  minClaimAmount: { type: "Number", required: false },
};