/**
 * AddToSeasonPool (Economy 2.4 + Cloud Save 1.4)
 *
 * 목적:
 * - 시즌 풀(특수 계정 + 시즌 메타)에 재화를 적립한다.
 * - 구현:
 *   1) poolOwner(특수 계정)의 currency 잔액을 increment 한다. (실제 금고)
 *   2) Cloud Save의 시즌 풀 메타(custom item)에 누적액을 더해 기록한다. (리포트/정산용)
 * - txnId 기반 멱등 처리(idempotency): 동일 txnId 재호출 시 중복 적립 방지.
 * - 단계별 커밋: 1) Economy 적립 완료 → 2) 시즌 메타 반영 완료
 *   - 메타 저장 실패 시 Warning 로그(폴백 발생) + 에러로 중단(중복 적립 위험).
 *
 * params (키 최대 10개):
 *  1) txnId: string                         // 필수
 *  2) seasonId: string                      // 필수 (예: "S2026_01")
 *  3) amount: number                        // 필수 (양수)
 *  4) currencyId?: string                   // 기본 "MARKETTOKEN"
 *  5) poolOwnerPlayerId?: string            // 기본 "MARKET"  (시즌 풀 금고 계정)
 *  6) expectedOwnerWriteLock?: string|null  // 선택: Economy writeLock
 *  7) tokenType?: "SERVICE"|"ACCESS"        // 기본 "SERVICE"
 *  8) idempotency?: boolean                 // 기본 true
 *
 * return:
 *  {
 *    txnId,
 *    seasonId,
 *    currencyId,
 *    poolOwnerPlayerId,
 *    addedAmount,
 *    owner: { newBalance, writeLock },
 *    meta: { totalAddedInSeason, updatedAt },
 *    alreadyProcessed: boolean,
 *    processedAt: string
 *  }
 */

const { CurrenciesApi, Configuration: EconomyConfiguration } = require("@unity-services/economy-2.4");
const { DataApi, Configuration: CloudSaveConfiguration } = require("@unity-services/cloud-save-1.4");

const DEFAULT_CURRENCY_ID = "MARKETTOKEN";
const DEFAULT_POOL_OWNER = "MARKET";

// txn 단계 저장(멱등 + 단계별 진행상태)
const TXN_CUSTOM_ID = "seasonpool_txn"; // [A-Za-z0-9_-]
// 시즌 누적 메타
const META_CUSTOM_ID = "seasonpool_meta"; // [A-Za-z0-9_-]

function _nowIso() {
  return new Date().toISOString();
}

function _pickToken(context, tokenType) {
  if (tokenType === "ACCESS") return context.accessToken;
  return context.serviceToken;
}

function _assertString(v, name) {
  if (typeof v !== "string" || v.trim().length === 0) throw new Error(`AddToSeasonPool: invalid ${name}`);
  return v.trim();
}

function _assertPositiveNumber(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`AddToSeasonPool: ${name} must be a positive number`);
  return n;
}

function _txnKey(txnId, seasonId, currencyId, poolOwnerPlayerId) {
  // ':' 금지
  return `TXN_${txnId}_S_${seasonId}_C_${currencyId}_O_${poolOwnerPlayerId}`;
}

function _metaKey(seasonId, currencyId) {
  return `S_${seasonId}_C_${currencyId}`;
}

async function _getPrivateItem(dataApi, projectId, customId, key) {
  const res = await dataApi.getPrivateCustomItems(projectId, customId, [key]);
  const items = (res && res.data && res.data.results) ? res.data.results : [];
  if (!items.length) return null;
  const it = items[0];
  return { value: it?.value ?? null, writeLock: it?.writeLock ?? null };
}

async function _setPrivateItem(dataApi, projectId, customId, key, value, writeLock) {
  await dataApi.setPrivateCustomItem(projectId, customId, {
    key,
    value,
    ...(writeLock ? { writeLock } : {}),
  });
}

module.exports = async ({ params, context, logger }) => {
  const projectId = context.projectId;

  const txnId = _assertString(params?.txnId, "txnId");
  const seasonId = _assertString(params?.seasonId, "seasonId");
  const amount = _assertPositiveNumber(params?.amount, "amount");

  const currencyId = params?.currencyId ? _assertString(params.currencyId, "currencyId") : DEFAULT_CURRENCY_ID;
  const poolOwnerPlayerId = params?.poolOwnerPlayerId ?
    _assertString(params.poolOwnerPlayerId, "poolOwnerPlayerId") :
    DEFAULT_POOL_OWNER;

  const tokenType = params?.tokenType ? params.tokenType : "SERVICE";
  const token = _pickToken(context, tokenType);
  if (!token) throw new Error(`AddToSeasonPool: missing token for tokenType=${tokenType}. Check context.accessToken/serviceToken.`);

  const idempotency = (params?.idempotency !== undefined) ? !!params.idempotency : true;
  const expectedOwnerWriteLock =
    (params?.expectedOwnerWriteLock === undefined) ? undefined : (params.expectedOwnerWriteLock ?? null);

  const cloudSaveApi = new DataApi(new CloudSaveConfiguration({ accessToken: token }));
  const currenciesApi = new CurrenciesApi(new EconomyConfiguration({ accessToken: token }));

  const tKey = _txnKey(txnId, seasonId, currencyId, poolOwnerPlayerId);

  // --------- txn state load (멱등) ---------
  if (idempotency) {
    const existing = await _getPrivateItem(cloudSaveApi, projectId, TXN_CUSTOM_ID, tKey);
    if (existing?.value?.status === "COMPLETED") {
      return {
        ...existing.value.result,
        alreadyProcessed: true,
      };
    }
  }

  let stateWrap = await _getPrivateItem(cloudSaveApi, projectId, TXN_CUSTOM_ID, tKey);
  let state = stateWrap?.value;
  let stateWriteLock = stateWrap?.writeLock ?? null;

  if (!state) {
    state = {
      status: "PENDING",
      createdAt: _nowIso(),
      txnId,
      seasonId,
      currencyId,
      poolOwnerPlayerId,
      amount,
      steps: {
        ownerCredited: false,
        metaUpdated: false,
      },
      result: null,
    };

    await _setPrivateItem(cloudSaveApi, projectId, TXN_CUSTOM_ID, tKey, state, null);
    stateWrap = await _getPrivateItem(cloudSaveApi, projectId, TXN_CUSTOM_ID, tKey);
    stateWriteLock = stateWrap?.writeLock ?? null;
  }

  // --------- step1: Economy credit to pool owner ---------
  let ownerNewBalance = null;
  let ownerWriteLock = null;

  if (!state.steps.ownerCredited) {
    let incRes;
    try {
      incRes = await currenciesApi.incrementPlayerCurrencyBalance({
        projectId,
        playerId: poolOwnerPlayerId,
        currencyId,
        currencyModifyBalanceRequest: {
          amount,
          ...(expectedOwnerWriteLock !== undefined ? { writeLock: expectedOwnerWriteLock } : {}),
        },
      });
    } catch (e) {
      logger.error(
        `AddToSeasonPool failed: owner credit. owner=${poolOwnerPlayerId}, currencyId=${currencyId}, amount=${amount}, txnId=${txnId}`
      );
      throw e;
    }

    const d = incRes?.data;
    ownerNewBalance = (d && typeof d.balance === "number") ? d.balance : null;
    ownerWriteLock = d?.writeLock ?? null;

    state.steps.ownerCredited = true;
    state.steps.owner = { newBalance: ownerNewBalance, writeLock: ownerWriteLock, processedAt: _nowIso() };

    try {
      await _setPrivateItem(cloudSaveApi, projectId, TXN_CUSTOM_ID, tKey, state, stateWriteLock);
      const reread = await _getPrivateItem(cloudSaveApi, projectId, TXN_CUSTOM_ID, tKey);
      stateWriteLock = reread?.writeLock ?? stateWriteLock;
    } catch (e) {
      logger.warning(
        `AddToSeasonPool fallback: failed to persist ownerCredited step. ` +
        `This can cause double-credit if retried. key=${tKey}, txnId=${txnId}`
      );
      throw e;
    }
  } else {
    ownerNewBalance = state.steps.owner?.newBalance ?? null;
    ownerWriteLock = state.steps.owner?.writeLock ?? null;
  }

  // --------- step2: Cloud Save meta accumulate ---------
  const mKey = _metaKey(seasonId, currencyId);
  let metaTotal = null;
  let metaUpdatedAt = null;

  if (!state.steps.metaUpdated) {
    const metaWrap = await _getPrivateItem(cloudSaveApi, projectId, META_CUSTOM_ID, mKey);
    const meta = metaWrap?.value ?? {
      seasonId,
      currencyId,
      totalAdded: 0,
      updatedAt: null,
    };

    const prevTotal = Number(meta.totalAdded) || 0;
    const nextTotal = prevTotal + amount;

    meta.totalAdded = nextTotal;
    meta.updatedAt = _nowIso();

    try {
      await _setPrivateItem(cloudSaveApi, projectId, META_CUSTOM_ID, mKey, meta, metaWrap?.writeLock ?? null);
    } catch (e) {
      // owner는 이미 지급됨. 메타 저장 실패는 재시도 시 중복 적립 위험.
      logger.warning(
        `AddToSeasonPool fallback: failed to persist season meta. ` +
        `This can cause double-credit if retried. metaKey=${mKey}, txnKey=${tKey}, txnId=${txnId}`
      );
      throw e;
    }

    metaTotal = nextTotal;
    metaUpdatedAt = meta.updatedAt;

    state.steps.metaUpdated = true;
    state.steps.meta = { totalAddedInSeason: metaTotal, updatedAt: metaUpdatedAt };

    try {
      await _setPrivateItem(cloudSaveApi, projectId, TXN_CUSTOM_ID, tKey, state, stateWriteLock);
      const reread = await _getPrivateItem(cloudSaveApi, projectId, TXN_CUSTOM_ID, tKey);
      stateWriteLock = reread?.writeLock ?? stateWriteLock;
    } catch (e) {
      logger.warning(
        `AddToSeasonPool fallback: failed to persist metaUpdated step. ` +
        `This can cause repeated calls. key=${tKey}, txnId=${txnId}`
      );
      throw e;
    }
  } else {
    metaTotal = state.steps.meta?.totalAddedInSeason ?? null;
    metaUpdatedAt = state.steps.meta?.updatedAt ?? null;
  }

  // --------- complete ---------
  const processedAt = _nowIso();

  const result = {
    txnId,
    seasonId,
    currencyId,
    poolOwnerPlayerId,
    addedAmount: amount,
    owner: { newBalance: ownerNewBalance, writeLock: ownerWriteLock },
    meta: { totalAddedInSeason: metaTotal, updatedAt: metaUpdatedAt },
    alreadyProcessed: false,
    processedAt,
  };

  state.status = "COMPLETED";
  state.result = result;
  state.completedAt = processedAt;

  try {
    await _setPrivateItem(cloudSaveApi, projectId, TXN_CUSTOM_ID, tKey, state, stateWriteLock);
  } catch (e) {
    logger.warning(
      `AddToSeasonPool fallback: failed to persist COMPLETED. ` +
      `This can cause repeated calls. key=${tKey}, txnId=${txnId}`
    );
    throw e;
  }

  return result;
};