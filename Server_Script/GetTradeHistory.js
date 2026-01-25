/**
 * GetTradeHistory (Cloud Code / UGS)
 *
 * 목적:
 * - 플레이어(구매자/판매자)의 거래 내역을 페이지 단위로 조회한다.
 * - Cloud Save는 서버 쿼리가 없으므로, "거래 이벤트 로그"를 Custom Item으로 저장해두고
 *   인덱스 키(Custom Item key)로 조회한다.
 *
 * 저장 규칙(전제: BuyListing / CancelListing 등에서 같이 기록해둬야 함):
 * - 트레이드 로그(Custom Items): customId="market_trades", key="TRADE_<tradeId>"
 * - 트레이드 인덱스(Custom Items): customId="market_trade_indexes"
 *   - 구매자 기준: IDX_TRADE_BUYER_<buyerPlayerId>_<yyyymmddhhmmss>_<tradeId>
 *   - 판매자 기준: IDX_TRADE_SELLER_<sellerPlayerId>_<yyyymmddhhmmss>_<tradeId>
 *
 * 정렬/페이지:
 * - listCustomItems는 key 오름차순만 보장한다.
 * - 최신순(DESC)을 완벽히 원하면 키에 "역정렬용 타임스탬프"를 넣어 설계해야 한다.
 * - 현재 구현은 order=DESC를 받으면 Warning 로그 후 ASC 기반 페이지를 반환한다(무음 폴백 금지).
 *
 * 불일치 처리:
 * - 인덱스는 있는데 TRADE 본문이 없으면 Warning 로그 후 제외(부분 성공).
 *
 * params (최대 10개):
 *  1) playerId: string (선택, 기본 context.playerId)
 *  2) role: "BUYER" | "SELLER" | "BOTH" (선택, 기본 "BOTH")
 *  3) order: "ASC" | "DESC" (선택, 기본 "ASC")
 *  4) pageSize: number (선택, 기본 20, 최대 50)
 *  5) pageToken: string (선택) // Cloud Save nextPageToken
 *  6) tradeIndexesCustomId: string (선택, 기본 "market_trade_indexes")
 *  7) tradesCustomId: string (선택, 기본 "market_trades")
 *
 * return:
 * - playerId, role, items: trade[], nextPageToken, skipped
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

module.exports = async function GetTradeHistory(params, context, logger) {
  const {
    playerId,
    role,
    order,
    pageSize,
    pageToken,
    tradeIndexesCustomId,
    tradesCustomId
  } = params || {};

  const _playerId = playerId || context.playerId;
  const _role = role || "BOTH";
  const _order = order || "ASC";

  if (_role !== "BUYER" && _role !== "SELLER" && _role !== "BOTH") {
    throw new Error("GetTradeHistory: role must be BUYER, SELLER, or BOTH.");
  }
  if (_order !== "ASC" && _order !== "DESC") {
    throw new Error("GetTradeHistory: order must be ASC or DESC.");
  }

  const _pageSizeRaw = (typeof pageSize === "number" && Number.isFinite(pageSize)) ? Math.floor(pageSize) : 20;
  const _pageSize = Math.max(1, Math.min(_pageSizeRaw, 50));

  const _tradeIndexesCustomId = tradeIndexesCustomId || "market_trade_indexes";
  const _tradesCustomId = tradesCustomId || "market_trades";

  const cloudSave = new DataApi(context);
  const projectId = context.projectId;

  if (_order === "DESC") {
    logger.warning("GetTradeHistory fallback: order=DESC requested but Cloud Save listCustomItems does not support reverse order. Returning ASC-based page.");
  }

  // 1) 인덱스 keyPrefix 결정
  // BOTH는 서버에서 prefix OR 조회가 불가하므로, 한 페이지 내에서 BUYER 우선으로만 조회하고,
  // 다음 페이지 토큰으로 SELLER로 이어서 보는 방식(phase 토큰)을 사용한다.
  // phaseToken 포맷: "B:<pageToken>" | "S:<pageToken>" | "BS:<buyerToken>|<sellerToken>" (호환용)
  const parsePhaseToken = (t) => {
    if (!t || typeof t !== "string") return { phase: (_role === "SELLER") ? "S" : "B", token: null };

    if (t.startsWith("B:")) return { phase: "B", token: t.substring(2) || null };
    if (t.startsWith("S:")) return { phase: "S", token: t.substring(2) || null };

    // 과거/혼합 토큰(사용 안 해도 됨) 호환
    if (t.startsWith("BS:")) {
      const body = t.substring(3);
      const parts = body.split("|");
      const b = parts[0] || null;
      const s = parts[1] || null;
      // BUYER부터 재개
      return { phase: "B", token: b, otherToken: s };
    }

    // 알 수 없는 토큰은 폴백 처리(Warning) 후 무시
    logger.warning(`GetTradeHistory fallback: unknown pageToken format. token=${t}`);
    return { phase: (_role === "SELLER") ? "S" : "B", token: null };
  };

  const phaseInfo = parsePhaseToken(pageToken);

  const wantBuyer = (_role === "BUYER" || _role === "BOTH");
  const wantSeller = (_role === "SELLER" || _role === "BOTH");

  let phase = phaseInfo.phase;
  if (!wantBuyer && wantSeller) phase = "S";
  if (wantBuyer && !wantSeller) phase = "B";
  if (!wantBuyer && !wantSeller) throw new Error("GetTradeHistory: invalid role selection.");

  const buyerPrefix = `IDX_TRADE_BUYER_${_playerId}_`;
  const sellerPrefix = `IDX_TRADE_SELLER_${_playerId}_`;

  const keyPrefix = (phase === "S") ? sellerPrefix : buyerPrefix;

  // 2) 인덱스 페이지 조회
  let indexRows = [];
  let nextTokenRaw = null;

  try {
    const indexRes = await cloudSave.listCustomItems(projectId, _tradeIndexesCustomId, {
      limit: _pageSize,
      keyPrefix,
      pageToken: (phaseInfo.token && typeof phaseInfo.token === "string") ? phaseInfo.token : undefined
    });

    indexRows = (indexRes?.data?.results || []);
    nextTokenRaw = indexRes?.data?.nextPageToken || null;
  } catch (e) {
    throw new Error(`GetTradeHistory: failed to list trade index items. err=${e?.message || e}`);
  }

  // 3) tradeId 추출
  const tradeIds = [];
  for (const row of indexRows) {
    const k = row?.key;
    if (typeof k !== "string") continue;

    const lastUnderscore = k.lastIndexOf("_");
    if (lastUnderscore <= 0 || lastUnderscore === k.length - 1) {
      logger.warning(`GetTradeHistory fallback: malformed index key. key=${k}`);
      continue;
    }

    const id = k.substring(lastUnderscore + 1);
    if (!id) {
      logger.warning(`GetTradeHistory fallback: failed to parse tradeId. key=${k}`);
      continue;
    }

    tradeIds.push(id);
  }

  // 4) TRADE 본문 배치 조회
  const tradeKeys = tradeIds.map(id => `TRADE_${id}`);

  let tradeRows = [];
  if (tradeKeys.length > 0) {
    const tradeRes = await cloudSave.getCustomItems(projectId, _tradesCustomId, tradeKeys);
    tradeRows = (tradeRes?.data?.results || []);
  }

  const tradeMap = new Map();
  for (const r of tradeRows) {
    if (r && typeof r.key === "string") tradeMap.set(r.key, r.value);
  }

  const items = [];
  let skipped = 0;

  for (const id of tradeIds) {
    const tk = `TRADE_${id}`;
    const v = tradeMap.get(tk);

    if (!v || typeof v !== "object") {
      skipped += 1;
      logger.warning(`GetTradeHistory fallback: trade missing for index. tradeKey=${tk}`);
      continue;
    }

    // 최소 검증(필드 없으면 경고 + 포함은 가능하지만, 여기선 운영 안정성 위해 제외)
    if (!v.tradeId || v.tradeId !== id) {
      skipped += 1;
      logger.warning(`GetTradeHistory fallback: tradeId mismatch. expected=${id}, got=${v.tradeId}`);
      continue;
    }

    items.push(v);
  }

  // 5) nextPageToken 구성
  // - role=BOTH: BUYER 페이지가 끝났고 nextTokenRaw가 null이면 SELLER phase로 넘긴다.
  // - role=BUYER/SELLER: 해당 phase 그대로.
  let nextPageToken = null;

  if (_role === "BOTH") {
    if (phase === "B") {
      if (nextTokenRaw) {
        nextPageToken = `B:${nextTokenRaw}`;
      } else if (wantSeller) {
        nextPageToken = "S:"; // SELLER 처음부터
      } else {
        nextPageToken = null;
      }
    } else {
      if (nextTokenRaw) nextPageToken = `S:${nextTokenRaw}`;
      else nextPageToken = null;
    }
  } else {
    if (nextTokenRaw) nextPageToken = `${phase}:${nextTokenRaw}`;
    else nextPageToken = null;
  }

  return {
    playerId: _playerId,
    role: _role,
    items,
    nextPageToken,
    skipped
  };
};