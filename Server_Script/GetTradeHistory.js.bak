/**
 * GetTradeHistory (Cloud Code / UGS, Cloud Save v1.4 DataApi)
 *
 * 목적:
 * - 내 거래 내역(구매/판매)을 페이지 단위로 조회한다.
 * - Cloud Save Custom Item은 서버 “prefix list”가 없으므로,
 *   DataApi.getCustomKeys()로 indexesCustomId 전체 키(알파벳 ASC, 100개 단위)를 받아오고
 *   서버에서 keyPrefix(들)로 필터링해 “거래 인덱스 키”만 모은다.
 * - 인덱스 키에서 tradeId를 추출한 뒤,
 *   DataApi.getCustomItems()로 tradesCustomId의 TRADE_<tradeId>를 배치 조회한다.
 * - 아이템 id(=itemInstanceId)는 prefix 금지.
 * - 아이템 이동은 Custom Items 내부에서 customId 변경으로 수행(이 스크립트는 조회만 한다).
 * - 경매장에 등록된 아이템은 customId="escrow"에 존재(필요 시 includeEscrowItem로 첨부 조회).
 * - 데이터 불일치(인덱스는 있는데 trade가 없음, role 불일치 등)는 무음 폴백 금지:
 *   Warning 로그를 남기고 해당 항목은 결과에서 제외한다(=부분 성공).
 *
 * 데이터 저장 위치(기본값):
 * - 거래 인덱스(Custom Items): customId = "market_indexes"
 *   - 판매자 인덱스: IDX_TRADE_SELLER_<playerId>_<createdAtKey>_<tradeId>
 *   - 구매자 인덱스: IDX_TRADE_BUYER_<playerId>_<createdAtKey>_<tradeId>
 *   (createdAtKey는 문자열 정렬 가능한 형식 권장: yyyymmddhhmmss 등)
 * - 거래 레코드(Custom Items): customId = "market_trades", key = "TRADE_<tradeId>"
 * - 에스크로 아이템(Custom Items): customId = "escrow", key = "<itemInstanceId>"  // prefix 없음
 *
 * 페이지네이션 제약 (DataApi 기준):
 * - getCustomKeys: customId 전체 키를 알파벳 ASC로만 제공(100개 단위).
 * - 서버 prefix 필터가 없으므로, 원하는 prefix를 모을 때까지 여러 페이지를 스캔해야 한다.
 *
 * params (최대 10개):
 *  1) playerId: string (선택, 기본 context.playerId)
 *  2) role: "BUY" | "SELL" | "ALL" (선택, 기본 "ALL")
 *  3) pageSize: number (선택, 기본 20, 최대 50)
 *  4) pageToken: string (선택) // getCustomKeys(after)에 넣는 “after 키”
 *  5) indexesCustomId: string (선택, 기본 "market_indexes")
 *  6) tradesCustomId: string (선택, 기본 "market_trades")
 *  7) escrowCustomId: string (선택, 기본 "escrow")
 *  8) includeEscrowItem: boolean (선택, 기본 false)
 *
 * return:
 * - ok=true: playerId, role, items: trade[], nextPageToken, skipped
 *   (includeEscrowItem=true면 trade에 escrowItem 필드를 붙여 반환)
 * - ok=false: errorCode, errorMessage
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

module.exports = async function GetTradeHistory({ params, context, logger }) {
  try {
  const {
    playerId,
    role,
    pageSize,
    pageToken,
      indexesCustomId = "market_indexes",
      tradesCustomId = "market_trades",
      escrowCustomId = "escrow",
      includeEscrowItem = false,
    } = params ?? {};

    const _playerId = (typeof playerId === "string" && playerId.length > 0) ? playerId : context.playerId;
    const _role = (typeof role === "string" && role.length > 0) ? role : "ALL";

  if (_role !== "BUY" && _role !== "SELL" && _role !== "ALL") {
      return fail("INVALID_ROLE", "role must be BUY, SELL, or ALL");
  }

  const _pageSizeRaw = (typeof pageSize === "number" && Number.isFinite(pageSize)) ? Math.floor(pageSize) : 20;
  const _pageSize = Math.max(1, Math.min(_pageSizeRaw, 50));

    if (typeof indexesCustomId !== "string" || indexesCustomId.length === 0) return fail("INVALID_INDEXES_CUSTOM_ID", "indexesCustomId must be a string");
    if (typeof tradesCustomId !== "string" || tradesCustomId.length === 0) return fail("INVALID_TRADES_CUSTOM_ID", "tradesCustomId must be a string");
    if (typeof escrowCustomId !== "string" || escrowCustomId.length === 0) return fail("INVALID_ESCROW_CUSTOM_ID", "escrowCustomId must be a string");
    if (typeof includeEscrowItem !== "boolean") return fail("INVALID_INCLUDE_ESCROW_ITEM", "includeEscrowItem must be a boolean");
    if (pageToken != null && typeof pageToken !== "string") return fail("INVALID_PAGE_TOKEN", "pageToken must be a string when provided");

    const api = new DataApi({ accessToken: context.accessToken });
  const projectId = context.projectId;

  const prefixSeller = `IDX_TRADE_SELLER_${_playerId}_`;
  const prefixBuyer = `IDX_TRADE_BUYER_${_playerId}_`;

  const prefixes = (_role === "SELL")
    ? [prefixSeller]
    : (_role === "BUY")
      ? [prefixBuyer]
      : [prefixSeller, prefixBuyer];

  // 1) 인덱스 키 수집 (getCustomKeys는 서버 prefix 필터 없음 -> 스캔)
  const matchedIndexKeys = [];
  let skipped = 0;

  let after = (typeof pageToken === "string" && pageToken.length > 0) ? pageToken : undefined;
  let nextPageToken = null;

  const MAX_KEY_PAGES_TO_SCAN = 20; // 20 * 100 = 2000 keys
  let scannedPages = 0;

  while (matchedIndexKeys.length < _pageSize && scannedPages < MAX_KEY_PAGES_TO_SCAN) {
    scannedPages += 1;

    let keysRes;
    try {
        keysRes = await api.getCustomKeys(projectId, indexesCustomId, after);
    } catch (e) {
        return fail("FAILED_GET_CUSTOM_KEYS", `getCustomKeys failed. err=${safeErrorMessage(e)}`);
    }

    const rows = (keysRes?.data?.results || []);
    if (rows.length === 0) {
      nextPageToken = null;
      break;
    }

    const lastKey = rows[rows.length - 1]?.key;
    if (typeof lastKey === "string" && lastKey.length > 0) {
      nextPageToken = lastKey;
    }

    for (const r of rows) {
      const k = r?.key;
      if (typeof k !== "string") continue;

      let ok = false;
      for (const p of prefixes) {
        if (k.startsWith(p)) { ok = true; break; }
      }
      if (!ok) continue;

      matchedIndexKeys.push(k);
      if (matchedIndexKeys.length >= _pageSize) break;
    }

    after = (typeof lastKey === "string" && lastKey.length > 0) ? lastKey : undefined;
  }

  if (scannedPages >= MAX_KEY_PAGES_TO_SCAN && matchedIndexKeys.length < _pageSize) {
      logger.warning(`GetTradeHistory FALLBACK: scanned too many key pages without collecting enough index keys. scannedPages=${scannedPages}, collected=${matchedIndexKeys.length}`);
  }

  // 2) tradeId 추출 + (SELL/BUY) 역할도 같이 기록
  const indexEntries = []; // { key, tradeId, kind:"SELL"|"BUY" }
  for (const k of matchedIndexKeys) {
    const kind = k.startsWith(prefixSeller) ? "SELL" : (k.startsWith(prefixBuyer) ? "BUY" : null);
    if (!kind) {
      skipped += 1;
        logger.warning(`GetTradeHistory FALLBACK: index key prefix mismatch. key=${k}`);
      continue;
    }

    const lastUnderscore = k.lastIndexOf("_");
    if (lastUnderscore <= 0 || lastUnderscore === k.length - 1) {
      skipped += 1;
        logger.warning(`GetTradeHistory FALLBACK: malformed index key. key=${k}`);
      continue;
    }

    const tradeId = k.substring(lastUnderscore + 1);
    if (!tradeId) {
      skipped += 1;
        logger.warning(`GetTradeHistory FALLBACK: failed to parse tradeId. key=${k}`);
      continue;
    }

    indexEntries.push({ key: k, tradeId, kind });
  }

    const tradeKeys = indexEntries.map(x => `TRADE_${x.tradeId}`);

  // 3) trade 레코드 배치 조회 (getCustomItems 20개 단위)
  const tradeMap = new Map();

  const CHUNK = 20;
  for (let i = 0; i < tradeKeys.length; i += CHUNK) {
    const chunkKeys = tradeKeys.slice(i, i + CHUNK);

    let res;
    try {
        res = await api.getCustomItems(projectId, tradesCustomId, chunkKeys);
    } catch (e) {
        return fail("FAILED_GET_TRADES", `getCustomItems(trades) failed. err=${safeErrorMessage(e)}`);
    }

    const rows = (res?.data?.results || []);
    for (const r of rows) {
      if (r && typeof r.key === "string") tradeMap.set(r.key, r.value);
    }
  }

  // 4) (옵션) escrow 아이템 배치 조회 준비
  const escrowMap = new Map();
    if (includeEscrowItem) {
    const escrowIdSet = new Set();

    for (const entry of indexEntries) {
      const t = tradeMap.get(`TRADE_${entry.tradeId}`);
        if (!isPlainObject(t)) continue;

      const itemInstanceId = t.itemInstanceId;
      if (typeof itemInstanceId === "string" && itemInstanceId.length > 0) {
        escrowIdSet.add(itemInstanceId);
      }
    }

    const escrowIds = Array.from(escrowIdSet);
    for (let i = 0; i < escrowIds.length; i += CHUNK) {
      const chunkKeys = escrowIds.slice(i, i + CHUNK);

      let res;
      try {
          res = await api.getCustomItems(projectId, escrowCustomId, chunkKeys);
      } catch (e) {
          return fail("FAILED_GET_ESCROW", `getCustomItems(escrow) failed. err=${safeErrorMessage(e)}`);
      }

      const rows = (res?.data?.results || []);
      for (const r of rows) {
        if (r && typeof r.key === "string") escrowMap.set(r.key, r.value);
      }
    }
  }

  // 5) 결과 구성(인덱스 순서 유지) + 정합성 검증
  const items = [];

  for (const entry of indexEntries) {
      const tradeKey = `TRADE_${entry.tradeId}`;
      const t = tradeMap.get(tradeKey);

      if (!isPlainObject(t)) {
      skipped += 1;
        logger.warning(`GetTradeHistory FALLBACK: trade missing for index. tradeKey=${tradeKey}`);
      continue;
    }

    // 인덱스 종류(SELL/BUY)와 레코드의 player 필드가 있으면 교차 검증 (있을 때만)
    if (entry.kind === "SELL" && typeof t.sellerPlayerId === "string" && t.sellerPlayerId !== _playerId) {
      skipped += 1;
        logger.warning(`GetTradeHistory FALLBACK: seller mismatch. tradeId=${entry.tradeId}, seller=${t.sellerPlayerId}, expected=${_playerId}`);
      continue;
    }
    if (entry.kind === "BUY" && typeof t.buyerPlayerId === "string" && t.buyerPlayerId !== _playerId) {
      skipped += 1;
        logger.warning(`GetTradeHistory FALLBACK: buyer mismatch. tradeId=${entry.tradeId}, buyer=${t.buyerPlayerId}, expected=${_playerId}`);
      continue;
    }

      if (includeEscrowItem) {
      const itemInstanceId = t.itemInstanceId;

      if (typeof itemInstanceId === "string" && itemInstanceId.length > 0) {
        const escrowItem = escrowMap.get(itemInstanceId);
          if (!isPlainObject(escrowItem)) {
            logger.warning(`GetTradeHistory FALLBACK: escrow item not found (may be moved out after completion). tradeId=${entry.tradeId}, itemInstanceId=${itemInstanceId}, escrowCustomId=${escrowCustomId}`);
          items.push({ ...t, escrowItem: null });
        } else {
          items.push({ ...t, escrowItem });
        }
      } else {
          logger.warning(`GetTradeHistory FALLBACK: trade missing itemInstanceId while includeEscrowItem=true. tradeId=${entry.tradeId}`);
        items.push({ ...t, escrowItem: null });
      }
    } else {
      items.push(t);
    }
  }

  return {
      ok: true,
    playerId: _playerId,
    role: _role,
    items,
    nextPageToken: nextPageToken || null,
      skipped,
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
  playerId: { type: "String", required: false },
  role: { type: "String", required: false },
  pageSize: { type: "Number", required: false },
  pageToken: { type: "String", required: false },
  indexesCustomId: { type: "String", required: false },
  tradesCustomId: { type: "String", required: false },
  escrowCustomId: { type: "String", required: false },
  includeEscrowItem: { type: "Boolean", required: false },
};