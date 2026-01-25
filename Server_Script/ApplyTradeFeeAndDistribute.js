/**
 * ApplyTradeFeeAndDistribute (Economy 2.4 + Cloud Save 1.4)
 *
 * 목적:
 * - 거래 금액(grossAmount) 기준 수수료를 계산하고 분배한다.
 *   - seller: gross - feeTotal
 *   - pool: feePool
 *   - burn: feeBurn (의도적으로 어디에도 credit 하지 않음 = 이미 buyer에서 빠진 금액 중 미분배분)
 * - txnId 기반 멱등 처리(idempotency) + 단계별 진행상태 저장으로 재시도 시 중복 지급 방지.
 *
 * 전제:
 * - buyer의 grossAmount 차감(DebitCurrency)은 이미 성공한 상태에서 호출한다.
 * - 상위에서 LISTING/PLAYER 락을 잡고 호출한다.
 *
 * params (키 최대 10개):
 *  1) txnId: string                       // 필수
 *  2) sellerPlayerId: string              // 필수
 *  3) grossAmount: number                 // 필수 (양수)
 *  4) currencyId?: string                 // 기본 "MARKETTOKEN"
 *  5) feeBpsTotal?: number                // 기본 1000 (=10%)
 *  6) poolBps?: number                    // 기본 600 (=6%)  // burnBps는 feeBpsTotal - poolBps
 *  7) seasonId?: string                   // 기본 "CURRENT"  // 분배 로그/키 구분용
 *  8) poolOwnerPlayerId?: string          // 기본 "MARKET"   // 시즌 풀을 보유할 특수 계정
 *  9) tokenType?: "SERVICE"|"ACCESS"      // 기본 "SERVICE"
 * 10) writeLocks?: { seller?: string|null, pool?: string|null } // 선택: Economy writeLock
 *
 * return:
 *  {
 *    txnId, currencyId, seasonId,
 *    grossAmount,
 *    feeBpsTotal, poolBps, burnBps,
 *    feeTotal, feePool, feeBurn,
 *    sellerNet,
 *    seller: { playerId, credited, newBalance, writeLock },
 *    pool:   { playerId, credited, newBalance, writeLock },
 *    alreadyProcessed: boolean,
 *    processedAt: string
 *  }
 */

const { CurrenciesApi } = require("@unity-services/economy-2.4");
const { DataApi } = require("@unity-services/cloud-save-1.4");

const DEFAULT_CURRENCY_ID = "MARKETTOKEN";

// Custom Item(게임 데이터)로 멱등/진행상태 저장 (서버만 쓰는 용도)
const IDEMPOTENCY_CUSTOM_ID = "tradefee_txn"; // [A-Za-z0-9_-]

function _nowIso() {
  return new Date().toISOString();
}

function _pickToken(context, tokenType) {
  if (tokenType === "ACCESS") return context.accessToken;
  return context.serviceToken;
}

function _assertString(v, name) {
  if (typeof v !== "string" || v.trim().length === 0) throw new Error(`ApplyTradeFeeAndDistribute: invalid ${name}`);
  return v.trim();
}

function _assertPositiveNumber(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`ApplyTradeFeeAndDistribute: ${name} must be a positive number`);
  return n;
}

function _assertBps(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10000) throw new Error(`ApplyTradeFeeAndDistribute: ${name} must be 0..10000`);
  return Math.floor(n);
}

function _key(txnId, currencyId) {
  // ':' 금지. 길이 과하면 상위에서 txnId를 짧게 만들어라.
  return `TXN_${txnId}_C_${currencyId}`;
}

async function _getCustomItem(dataApi, projectId, key) {
  // getCustomItems(projectId, customId, keys?, after?)
  const res = await dataApi.getCustomItems(projectId, IDEMPOTENCY_CUSTOM_ID, [key]);
  const items = (res && res.data && res.data.results) ? res.data.results : [];
  if (!items.length) return null;

  const item = items[0];
  return {
    value: item?.value ?? null,
    writeLock: item?.writeLock ?? null,
  };
}

async function _setCustomItem(dataApi, projectId, key, value, writeLock) {
  // setCustomItem(projectId, customId, setItemBody?)
  // writeLock 생략하면 충돌 무시(위험). 여기선 writeLock을 가능하면 항상 사용.
  await dataApi.setCustomItem(projectId, IDEMPOTENCY_CUSTOM_ID, {
    key,
    value,
    ...(writeLock ? { writeLock } : {}),
  });
}

function _calcDistribution(grossAmount, feeBpsTotal, poolBps) {
  // 숫자 안정성: 입력이 소수여도 그냥 Number로 처리 (Economy currency scale에 맞춰 upstream에서 관리 권장)
  // 수수료는 "내림"으로 계산해서 과금 초과를 방지한다.
  const gross = Number(grossAmount);

  const feeTotal = Math.floor((gross * feeBpsTotal) / 10000);
  const feePool = Math.floor((gross * poolBps) / 10000);

  const feeBurn = feeTotal - feePool;
  const sellerNet = gross - feeTotal;

  if (sellerNet < 0) throw new Error("ApplyTradeFeeAndDistribute: computed sellerNet < 0 (check bps)");

  return { gross, feeTotal, feePool, feeBurn, sellerNet };
}

module.exports = async ({ params, context, logger }) => {
  const projectId = context.projectId;

  // -------- params (10개 이하) --------
  const txnId = _assertString(params?.txnId, "txnId");
  const sellerPlayerId = _assertString(params?.sellerPlayerId, "sellerPlayerId");
  const grossAmount = _assertPositiveNumber(params?.grossAmount, "grossAmount");

  const currencyId = (params?.currencyId ? _assertString(params.currencyId, "currencyId") : DEFAULT_CURRENCY_ID);

  const feeBpsTotal = _assertBps(params?.feeBpsTotal ?? 1000, "feeBpsTotal");
  const poolBps = _assertBps(params?.poolBps ?? 600, "poolBps");
  if (poolBps > feeBpsTotal) throw new Error("ApplyTradeFeeAndDistribute: poolBps must be <= feeBpsTotal");

  const burnBps = feeBpsTotal - poolBps;

  const seasonId = (params?.seasonId ? _assertString(params.seasonId, "seasonId") : "CURRENT");
  const poolOwnerPlayerId = (params?.poolOwnerPlayerId ? _assertString(params.poolOwnerPlayerId, "poolOwnerPlayerId") : "MARKET");

  const tokenType = params?.tokenType ? params.tokenType : "SERVICE";
  const token = _pickToken(context, tokenType);
  if (!token) throw new Error(`ApplyTradeFeeAndDistribute: missing token for tokenType=${tokenType}`);

  const writeLocks = params?.writeLocks ?? {};
  const expectedSellerWriteLock = (writeLocks.seller === undefined) ? undefined : (writeLocks.seller ?? null);
  const expectedPoolWriteLock = (writeLocks.pool === undefined) ? undefined : (writeLocks.pool ?? null);

  // -------- 계산 --------
  const { gross, feeTotal, feePool, feeBurn, sellerNet } = _calcDistribution(grossAmount, feeBpsTotal, poolBps);

  // feeTotal이 0이면 사실상 분배할 게 없음. 그래도 seller 지급은 발생할 수 있음(소액).
  // feeTotal==0인데 feePool/feeBurn이 음수/양수면 계산식이 깨진 거라 위에서 throw 됨.

  // -------- 멱등/진행상태 로드 --------
  const cloudSaveApi = new DataApi(context);
  const idKey = _key(txnId, currencyId);

  const existing = await _getCustomItem(cloudSaveApi, projectId, idKey);
  if (existing?.value?.status === "COMPLETED") {
    return {
      ...existing.value.result,
      alreadyProcessed: true,
    };
  }

  // 신규/재시도 공통으로 쓸 상태
  let state = existing?.value;
  let stateWriteLock = existing?.writeLock ?? null;

  if (!state) {
    // 최초 생성: PENDING
    state = {
      status: "PENDING",
      createdAt: _nowIso(),
      txnId,
      currencyId,
      seasonId,
      sellerPlayerId,
      poolOwnerPlayerId,
      grossAmount: gross,
      feeBpsTotal,
      poolBps,
      burnBps,
      amounts: { feeTotal, feePool, feeBurn, sellerNet },
      steps: {
        sellerCredited: false,
        poolCredited: false,
      },
      result: null,
    };

    // 멱등 레코드 생성 실패는 중복 지급 위험. 에러로 중단.
    await _setCustomItem(cloudSaveApi, projectId, idKey, state, null);

    // writeLock 다시 가져와서 이후 업데이트에 사용
    const created = await _getCustomItem(cloudSaveApi, projectId, idKey);
    stateWriteLock = created?.writeLock ?? null;
  }

  // -------- Economy 분배 (단계별 커밋) --------
  const currenciesApi = new CurrenciesApi(context);

  const sellerOut = { playerId: sellerPlayerId, credited: 0, newBalance: null, writeLock: null };
  const poolOut = { playerId: poolOwnerPlayerId, credited: 0, newBalance: null, writeLock: null };

  // 1) seller 지급
  if (!state.steps?.sellerCredited && sellerNet > 0) {
    let res;
    try {
      res = await currenciesApi.incrementPlayerCurrencyBalance({
        projectId,
        playerId: sellerPlayerId,
        currencyId,
        currencyModifyBalanceRequest: {
          amount: sellerNet,
          ...(expectedSellerWriteLock !== undefined ? { writeLock: expectedSellerWriteLock } : {}),
        },
      });
    } catch (e) {
      logger.error(`ApplyTradeFeeAndDistribute: seller credit failed. seller=${sellerPlayerId}, amount=${sellerNet}, txnId=${txnId}`);
      throw e;
    }

    const d = res?.data;
    sellerOut.credited = sellerNet;
    sellerOut.newBalance = (d && typeof d.balance === "number") ? d.balance : null;
    sellerOut.writeLock = d?.writeLock ?? null;

    // 단계 저장
    state.steps.sellerCredited = true;
    state.steps.seller = { ...sellerOut, processedAt: _nowIso() };

    // writeLock 충돌은 상위 락 설계로 막는 게 기본. 여기선 writeLock 사용 가능 시 사용.
    try {
      await _setCustomItem(cloudSaveApi, projectId, idKey, state, stateWriteLock);
      const reread = await _getCustomItem(cloudSaveApi, projectId, idKey);
      stateWriteLock = reread?.writeLock ?? stateWriteLock;
    } catch (e) {
      // seller는 이미 지급됨. 여기서 실패하면 재시도 시 중복 지급 가능성이 생김.
      // 따라서 Warning 로그로 폴백(위험) 명시 + 에러로 중단.
      logger.warning(
        `ApplyTradeFeeAndDistribute fallback: failed to persist seller step. ` +
        `This can cause double-credit if retried. key=${idKey}, txnId=${txnId}`
      );
      throw e;
    }
  } else if (state.steps?.sellerCredited) {
    const prev = state.steps?.seller;
    if (prev) {
      sellerOut.credited = prev.credited ?? 0;
      sellerOut.newBalance = prev.newBalance ?? null;
      sellerOut.writeLock = prev.writeLock ?? null;
    }
  }

  // 2) pool 적립
  if (!state.steps?.poolCredited && feePool > 0) {
    let res;
    try {
      res = await currenciesApi.incrementPlayerCurrencyBalance({
        projectId,
        playerId: poolOwnerPlayerId,
        currencyId,
        currencyModifyBalanceRequest: {
          amount: feePool,
          ...(expectedPoolWriteLock !== undefined ? { writeLock: expectedPoolWriteLock } : {}),
        },
      });
    } catch (e) {
      logger.error(`ApplyTradeFeeAndDistribute: pool credit failed. poolOwner=${poolOwnerPlayerId}, amount=${feePool}, txnId=${txnId}`);
      throw e;
    }

    const d = res?.data;
    poolOut.credited = feePool;
    poolOut.newBalance = (d && typeof d.balance === "number") ? d.balance : null;
    poolOut.writeLock = d?.writeLock ?? null;

    // 단계 저장
    state.steps.poolCredited = true;
    state.steps.pool = { ...poolOut, processedAt: _nowIso() };

    try {
      await _setCustomItem(cloudSaveApi, projectId, idKey, state, stateWriteLock);
      const reread = await _getCustomItem(cloudSaveApi, projectId, idKey);
      stateWriteLock = reread?.writeLock ?? stateWriteLock;
    } catch (e) {
      logger.warning(
        `ApplyTradeFeeAndDistribute fallback: failed to persist pool step. ` +
        `This can cause double-credit if retried. key=${idKey}, txnId=${txnId}`
      );
      throw e;
    }
  } else if (state.steps?.poolCredited) {
    const prev = state.steps?.pool;
    if (prev) {
      poolOut.credited = prev.credited ?? 0;
      poolOut.newBalance = prev.newBalance ?? null;
      poolOut.writeLock = prev.writeLock ?? null;
    }
  }

  // 3) 완료 커밋 (burn은 "미분배"로 처리)
  const processedAt = _nowIso();

  const result = {
    txnId,
    currencyId,
    seasonId,
    grossAmount: gross,
    feeBpsTotal,
    poolBps,
    burnBps,
    feeTotal,
    feePool,
    feeBurn,
    sellerNet,
    seller: sellerOut,
    pool: poolOut,
    alreadyProcessed: false,
    processedAt,
  };

  state.status = "COMPLETED";
  state.result = result;
  state.completedAt = processedAt;

  try {
    await _setCustomItem(cloudSaveApi, projectId, idKey, state, stateWriteLock);
  } catch (e) {
    // 완료 마킹 실패는 재시도 시 "이미 지급된 상태"를 또 실행할 위험.
    // 단계 저장은 이미 했지만, 그래도 위험하니 Warning + 에러.
    logger.warning(
      `ApplyTradeFeeAndDistribute fallback: failed to persist COMPLETED. ` +
      `This can cause repeated calls. key=${idKey}, txnId=${txnId}`
    );
    throw e;
  }

  return result;
};