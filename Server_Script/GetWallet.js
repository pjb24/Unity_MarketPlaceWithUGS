/**
 * GetWallet
 *
 * 목적:
 * - Economy Player Currencies API로 플레이어 재화 잔액(MT, EC)을 조회한다.
 * - 누락된 재화는 0으로 폴백하되, 반드시 Warning 로그를 남긴다. (무음 폴백 금지)
 *
 * params:
 *  - playerId?: string            // 기본: context.playerId
 *  - currencyIds?: string[]       // 기본: [MARKETTOKEN, ENERGYCREDITS]
 *  - tokenType?: "SERVICE"|"ACCESS" // 기본: "SERVICE"
 *
 * return:
 *  {
 *    playerId: string,
 *    currencies: {
 *      [currencyId]: { balance: number, writeLock?: string }
 *    },
 *    fetchedAt: string
 *  }
 */

const { CurrenciesApi } = require("@unity-services/economy-2.4");

const CURRENCY_ID_MT = "MARKETTOKEN";
const CURRENCY_ID_EC = "ENERGYCREDITS";

function _nowIso() {
  return new Date().toISOString();
}

function _pickToken(context, tokenType) {
  if (tokenType === "ACCESS") return context.accessToken;
  return context.serviceToken; // 기본: 서버 권한(크로스플레이어 접근 포함)
}

async function _fetchAllCurrencyBalances(currenciesApi, projectId, playerId) {
  // getPlayerCurrencies는 currencyId 오름차순, after/limit 기반 페이징.
  const results = [];
  let after = undefined;
  const limit = 100; // 기본 20이므로 크게 잡고, 그래도 부족하면 after로 반복

  for (;;) {
    const res = await currenciesApi.getPlayerCurrencies({
      projectId,
      playerId,
      limit,
      after,
    });

    const page = (res && res.data && res.data.results) ? res.data.results : [];
    results.push(...page);

    if (!page.length) break;

    // 다음 페이지: 마지막 currencyId를 after로 넣는다.
    const last = page[page.length - 1];
    const lastId = last && last.currencyId;
    if (!lastId) break;

    // 페이지가 꽉 찼을 때만 다음을 시도 (안 그러면 끝)
    if (page.length < limit) break;

    after = lastId;
  }

  return results;
}

module.exports = async ({ params, context, logger }) => {
  const projectId = context.projectId;
  const targetPlayerId = (params && params.playerId) ? params.playerId : context.playerId;

  const tokenType = (params && params.tokenType) ? params.tokenType : "SERVICE";
  const token = _pickToken(context, tokenType);

  if (!token) {
    throw new Error(`GetWallet: missing token for tokenType=${tokenType}. Check context.accessToken/serviceToken.`);
  }

  const currencyIds = (params && Array.isArray(params.currencyIds) && params.currencyIds.length > 0) ?
    params.currencyIds : [CURRENCY_ID_MT, CURRENCY_ID_EC];

  const currenciesApi = new CurrenciesApi(context);

  const fetchedAt = _nowIso();

  const allBalances = await _fetchAllCurrencyBalances(currenciesApi, projectId, targetPlayerId);

  // Map: currencyId -> balance info
  const map = new Map();
  for (const b of allBalances) {
    if (!b || !b.currencyId) continue;
    map.set(b.currencyId, {
      balance: typeof b.balance === "number" ? b.balance : 0,
      writeLock: b.writeLock ?? null,
    });
  }

  const currencies = {};
  for (const id of currencyIds) {
    const found = map.get(id);
    if (!found) {
      logger.warning(`GetWallet fallback: currency not found. currencyId=${id}, playerId=${targetPlayerId}. Returning balance=0.`);
      currencies[id] = { balance: 0, writeLock: null };
      continue;
    }
    currencies[id] = found;
  }

  return {
    playerId: targetPlayerId,
    currencies,
    fetchedAt,
  };
};