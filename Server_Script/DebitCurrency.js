/**
 * DebitCurrency (Economy 2.4 + Cloud Save 1.4)
 *
 * 목적:
 * - 플레이어 재화를 차감한다. (server authority)
 * - txnId 기반 멱등 처리(idempotency): 동일 txnId 재호출 시 중복 차감 방지.
 * - 누락/폴백은 없음. 실패는 그대로 실패 처리.
 *
 * params:
 *  - currencyId: string                // 필수
 *  - amount: number                    // 필수 (양수)
 *  - txnId: string                     // 필수 (멱등 키)
 *  - playerId?: string                 // 기본: context.playerId
 *  - expectedWriteLock?: string|null   // 선택: Economy writeLock 충돌 체크
 *  - tokenType?: "SERVICE"|"ACCESS"    // 기본: "SERVICE"
 *  - idempotency?: boolean             // 기본: true
 *
 * return:
 *  {
 *    playerId: string,
 *    currencyId: string,
 *    txnId: string,
 *    debitAmount: number,
 *    newBalance: number,
 *    writeLock: string|null,
 *    alreadyProcessed: boolean,
 *    processedAt: string
 *  }
 */

const { CurrenciesApi } = require("@unity-services/economy-2.4");
const { DataApi } = require("@unity-services/cloud-save-1.4");

const IDEMPOTENCY_CUSTOM_ID = "wallettxn"; // [A-Za-z0-9_-], 1~50

function _nowIso() {
  return new Date().toISOString();
}

function _pickToken(context, tokenType) {
  if (tokenType === "ACCESS") return context.accessToken;
  return context.serviceToken;
}

function _assertString(v, name) {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`DebitCurrency: invalid ${name}`);
  }
  return v.trim();
}

function _assertPositiveNumber(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`DebitCurrency: ${name} must be a positive number`);
  }
  return n;
}

function _buildIdempotencyKey(playerId, txnId, currencyId) {
  // 키는 Cloud Save item key라서 ':' 같은 금지문자 회피
  // playerId/txnId가 길어질 수 있어 prefix만 붙인다.
  return `P_${playerId}_T_${txnId}_C_${currencyId}`;
}

async function _tryGetIdempotencyRecord(dataApi, projectId, key) {
  // getPrivateCustomItems(projectId, customId, keys?, after?)
  const res = await dataApi.getPrivateCustomItems(projectId, IDEMPOTENCY_CUSTOM_ID, [key]);
  const items = (res && res.data && res.data.results) ? res.data.results : [];
  if (!items.length) return null;

  const item = items[0];
  // item.value에 저장된 payload를 그대로 신뢰(서버만 쓰는 private custom)
  return item && item.value ? item.value : null;
}

async function _writeIdempotencyRecord(dataApi, projectId, key, value) {
  // setPrivateCustomItem(projectId, customId, setItemBody?)
  // SetItemBody: { key, value, writeLock? }
  await dataApi.setPrivateCustomItem(projectId, IDEMPOTENCY_CUSTOM_ID, {
    key,
    value,
  });
}

module.exports = async ({ params, context, logger }) => {
  const projectId = context.projectId;

  const currencyId = _assertString(params?.currencyId, "currencyId");
  const txnId = _assertString(params?.txnId, "txnId");
  const amount = _assertPositiveNumber(params?.amount, "amount");

  const targetPlayerId = params?.playerId ? _assertString(params.playerId, "playerId") : context.playerId;

  const tokenType = params?.tokenType ? params.tokenType : "SERVICE";
  const token = _pickToken(context, tokenType);
  if (!token) {
    throw new Error(`DebitCurrency: missing token for tokenType=${tokenType}. Check context.accessToken/serviceToken.`);
  }

  const idempotency = (params?.idempotency !== undefined) ? !!params.idempotency : true;
  const expectedWriteLock =
    (params?.expectedWriteLock === undefined) ? undefined : (params.expectedWriteLock ?? null);

  // Cloud Save client (멱등 레코드)
  const cloudSaveApi = new DataApi(context);
  const idempotencyKey = _buildIdempotencyKey(targetPlayerId, txnId, currencyId);

  if (idempotency) {
    const existing = await _tryGetIdempotencyRecord(cloudSaveApi, projectId, idempotencyKey);
    if (existing) {
      return {
        ...existing,
        alreadyProcessed: true,
      };
    }
  }

  // Economy decrement
  const currenciesApi = new CurrenciesApi(context);

  let decRes;
  try {
    decRes = await currenciesApi.decrementPlayerCurrencyBalance({
      projectId,
      playerId: targetPlayerId,
      currencyId,
      currencyModifyBalanceRequest: {
        amount, // decrement 엔드포인트는 양수 amount를 차감으로 해석
        ...(expectedWriteLock !== undefined ? { writeLock: expectedWriteLock } : {}),
      },
    });
  } catch (e) {
    // 여기서 "잔액 부족" / "writeLock 충돌" 같은 케이스는 그대로 실패 처리.
    // (클라/상위 트랜잭션에서 롤백/에러코드 매핑)
    logger.error(`DebitCurrency failed: playerId=${targetPlayerId}, currencyId=${currencyId}, amount=${amount}, txnId=${txnId}`);
    throw e;
  }

  const data = decRes?.data;
  const newBalance = (data && typeof data.balance === "number") ? data.balance : 0;
  const writeLock = (data && data.writeLock) ? data.writeLock : null;

  const processedAt = _nowIso();

  const payload = {
    playerId: targetPlayerId,
    currencyId,
    txnId,
    debitAmount: amount,
    newBalance,
    writeLock,
    alreadyProcessed: false,
    processedAt,
  };

  if (idempotency) {
    // 멱등 레코드 저장 실패는 위험: 중복 차감 가능성이 생김.
    // 따라서 저장 실패는 Warning 로그 + 에러로 중단(상위에서 재시도/복구하도록).
    try {
      await _writeIdempotencyRecord(cloudSaveApi, projectId, idempotencyKey, payload);
    } catch (e) {
      logger.warning(
        `DebitCurrency idempotency write failed (fallback 발생): key=${idempotencyKey}. ` +
        `This can cause double-debit if retried. txnId=${txnId}`
      );
      throw e;
    }
  }

  return payload;
};