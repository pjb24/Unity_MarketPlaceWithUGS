/**
 * BurnCurrency (Economy 2.4 + Cloud Save 1.4)
 *
 * 목적:
 * - 재화를 "소각"한다.
 * - 구현: burnOwner(소각 전용 계정) 잔액에서 decrement 해서 제거한다.
 * - txnId 기반 멱등 처리(idempotency): 동일 txnId 재호출 시 중복 소각 방지.
 *
 * params (키 최대 10개):
 *  1) txnId: string                     // 필수
 *  2) amount: number                    // 필수 (양수)
 *  3) currencyId?: string               // 기본 "MARKETTOKEN"
 *  4) burnOwnerPlayerId?: string        // 기본 "MARKET"
 *  5) expectedWriteLock?: string|null   // 선택: Economy writeLock 충돌 체크
 *  6) tokenType?: "SERVICE"|"ACCESS"    // 기본 "SERVICE"
 *  7) idempotency?: boolean             // 기본 true
 *
 * return:
 *  {
 *    txnId: string,
 *    currencyId: string,
 *    burnOwnerPlayerId: string,
 *    burnAmount: number,
 *    newBalance: number,
 *    writeLock: string|null,
 *    alreadyProcessed: boolean,
 *    processedAt: string
 *  }
 */

const { CurrenciesApi, Configuration: EconomyConfiguration } = require("@unity-services/economy-2.4");
const { DataApi, Configuration: CloudSaveConfiguration } = require("@unity-services/cloud-save-1.4");

const DEFAULT_CURRENCY_ID = "MARKETTOKEN";
const DEFAULT_BURN_OWNER = "MARKET";

// 멱등 레코드 저장소(서버 전용). Public로 둘 이유 없음.
const IDEMPOTENCY_CUSTOM_ID = "burntxn"; // [A-Za-z0-9_-], 1~50

function _nowIso() {
  return new Date().toISOString();
}

function _pickToken(context, tokenType) {
  if (tokenType === "ACCESS") return context.accessToken;
  return context.serviceToken;
}

function _assertString(v, name) {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`BurnCurrency: invalid ${name}`);
  }
  return v.trim();
}

function _assertPositiveNumber(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`BurnCurrency: ${name} must be a positive number`);
  }
  return n;
}

function _buildIdempotencyKey(txnId, currencyId, burnOwnerPlayerId) {
  // ':' 금지
  return `TXN_${txnId}_C_${currencyId}_O_${burnOwnerPlayerId}`;
}

async function _tryGetIdempotencyRecord(dataApi, projectId, key) {
  // private로 저장: getPrivateCustomItems(projectId, customId, keys?, after?)
  const res = await dataApi.getPrivateCustomItems(projectId, IDEMPOTENCY_CUSTOM_ID, [key]);
  const items = (res && res.data && res.data.results) ? res.data.results : [];
  if (!items.length) return null;

  const item = items[0];
  return item && item.value ? item.value : null;
}

async function _writeIdempotencyRecord(dataApi, projectId, key, value) {
  // setPrivateCustomItem(projectId, customId, setItemBody?)
  await dataApi.setPrivateCustomItem(projectId, IDEMPOTENCY_CUSTOM_ID, {
    key,
    value,
  });
}

module.exports = async ({ params, context, logger }) => {
  const projectId = context.projectId;

  const txnId = _assertString(params?.txnId, "txnId");
  const amount = _assertPositiveNumber(params?.amount, "amount");

  const currencyId = params?.currencyId ? _assertString(params.currencyId, "currencyId") : DEFAULT_CURRENCY_ID;
  const burnOwnerPlayerId = params?.burnOwnerPlayerId ?
    _assertString(params.burnOwnerPlayerId, "burnOwnerPlayerId") :
    DEFAULT_BURN_OWNER;

  const tokenType = params?.tokenType ? params.tokenType : "SERVICE";
  const token = _pickToken(context, tokenType);
  if (!token) {
    throw new Error(`BurnCurrency: missing token for tokenType=${tokenType}. Check context.accessToken/serviceToken.`);
  }

  const idempotency = (params?.idempotency !== undefined) ? !!params.idempotency : true;
  const expectedWriteLock =
    (params?.expectedWriteLock === undefined) ? undefined : (params.expectedWriteLock ?? null);

  // Cloud Save client (멱등 레코드)
  const cloudSaveApi = new DataApi(new CloudSaveConfiguration({ accessToken: token }));
  const idKey = _buildIdempotencyKey(txnId, currencyId, burnOwnerPlayerId);

  if (idempotency) {
    const existing = await _tryGetIdempotencyRecord(cloudSaveApi, projectId, idKey);
    if (existing) {
      return {
        ...existing,
        alreadyProcessed: true,
      };
    }
  }

  // Economy decrement (burnOwner에서 차감)
  const currenciesApi = new CurrenciesApi(new EconomyConfiguration({ accessToken: token }));

  let decRes;
  try {
    decRes = await currenciesApi.decrementPlayerCurrencyBalance({
      projectId,
      playerId: burnOwnerPlayerId,
      currencyId,
      currencyModifyBalanceRequest: {
        amount,
        ...(expectedWriteLock !== undefined ? { writeLock: expectedWriteLock } : {}),
      },
    });
  } catch (e) {
    logger.error(
      `BurnCurrency failed: burnOwner=${burnOwnerPlayerId}, currencyId=${currencyId}, amount=${amount}, txnId=${txnId}`
    );
    throw e;
  }

  const d = decRes?.data;
  const newBalance = (d && typeof d.balance === "number") ? d.balance : 0;
  const writeLock = d?.writeLock ?? null;

  const payload = {
    txnId,
    currencyId,
    burnOwnerPlayerId,
    burnAmount: amount,
    newBalance,
    writeLock,
    alreadyProcessed: false,
    processedAt: _nowIso(),
  };

  if (idempotency) {
    // 멱등 레코드 저장 실패는 위험: 재시도 시 중복 소각 가능.
    // Warning 로그로 폴백 발생을 명확히 남기고, 에러로 중단.
    try {
      await _writeIdempotencyRecord(cloudSaveApi, projectId, idKey, payload);
    } catch (e) {
      logger.warning(
        `BurnCurrency idempotency write failed (fallback 발생): key=${idKey}. ` +
        `This can cause double-burn if retried. txnId=${txnId}`
      );
      throw e;
    }
  }

  return payload;
};