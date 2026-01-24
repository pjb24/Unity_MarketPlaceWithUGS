/**
 * BuyListing (Cloud Code / UGS)
 *
 * 목적:
 * - 구매자가 ACTIVE 상태의 리스팅을 구매한다.
 * - 중복 구매(레이스)를 막기 위해 LISTING 단위 분산 락(txnlocks Custom Item)을 획득한다.
 * - Economy(v2.4)로 구매자 재화 차감(decrement) → 판매자 재화 지급(increment) 순서로 처리한다.
 * - 에스크로(Custom Item)에 보관된 아이템을 구매자 인벤(Private Custom Item)에 복구하고,
 *   tradeLock(ESCROW)을 해제 + location을 지정 존으로 복구한다.
 * - 리스팅(Custom Item)은 status=SOLD 로 업데이트하고, ACTIVE 인덱스(Custom Item)를 삭제한다.
 * - 에스크로는 삭제하지 않고 status=TRANSFERRED + item=null tombstone 처리(감사용).
 *
 * 전제:
 * - BuyListing은 "구매자"가 호출한다. (context.playerId === buyerPlayerId)
 * - 판매자 인벤은 CreateListing 시점에 이미 제거되어 있으므로, 구매 완료 시 판매자 인벤 접근이 필요 없다.
 *
 * 데이터 저장 위치(기본값):
 * - 구매자 인벤(Private Custom Items): customId = "inventory", key = "ITEM_<itemInstanceId>"
 * - 에스크로(Custom Items): customId = "market_escrow", key = "ESCROW_<listingId>"
 * - 리스팅(Custom Items): customId = "market_listings", key = "LISTING_<listingId>"
 * - 인덱스(Custom Items): customId = "market_indexes"
 * - 트랜잭션 락(Custom Items): customId = "txnlocks", key = "LISTING_<listingId>"
 *
 * 인덱스 키 규칙(CreateListing과 동일):
 * - IDX_STATUS_CREATEDAT_ACTIVE_<yyyymmdd>_<listingId>
 * - IDX_STATUS_PRICE_ACTIVE_<priceBucket12>_<listingId>
 * - IDX_SELLER_STATUS_<sellerPlayerId>_ACTIVE_<listingId>
 *
 * params (최대 10개):
 *  1) listingId: string (필수)
 *  2) buyerPlayerId: string (선택, 기본 context.playerId)
 *  3) returnZone: "BAG" | "STORAGE" (선택, 기본 "BAG")
 *  4) currencyId: string (선택, 기본 "MT")
 *  5) feeBps: number (선택, 기본 0)  // 1 bps = 0.01%
 *  6) feeReceiverPlayerId: string (선택) // 있으면 fee를 해당 플레이어에 지급, 없으면 fee는 소각(=유출)
 *  7) inventoryCustomId: string (선택, 기본 "inventory")
 *  8) listingsCustomId: string (선택, 기본 "market_listings")
 *  9) escrowCustomId: string (선택, 기본 "market_escrow")
 * 10) indexesCustomId: string (선택, 기본 "market_indexes")
 *
 * return:
 * - listingId, status, price, currencyId, feeAmount, sellerReceives, soldAt, itemInstanceId
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");
const { CurrenciesApi } = require("@unity-services/economy-2.4");

module.exports = async function BuyListing(params, context, logger) {
  const {
    listingId,
    buyerPlayerId,
    returnZone,
    currencyId,
    feeBps,
    feeReceiverPlayerId,
    inventoryCustomId,
    listingsCustomId,
    escrowCustomId,
    indexesCustomId
  } = params || {};

  if (!listingId || typeof listingId !== "string") {
    throw new Error("BuyListing: listingId is required (string).");
  }

  const _buyerPlayerId = buyerPlayerId || context.playerId;
  const _returnZone = returnZone || "BAG";
  const _currencyId = currencyId || "MT";

  const _feeBps = (typeof feeBps === "number" && Number.isFinite(feeBps) && feeBps >= 0) ?
    Math.floor(feeBps) :
    0;

  const _inventoryCustomId = inventoryCustomId || "inventory";
  const _listingsCustomId = listingsCustomId || "market_listings";
  const _escrowCustomId = escrowCustomId || "market_escrow";
  const _indexesCustomId = indexesCustomId || "market_indexes";

  if (_buyerPlayerId !== context.playerId) {
    throw new Error("BuyListing: buyerPlayerId must match context.playerId.");
  }

  const cloudSave = new DataApi(context);
  const economy = new CurrenciesApi(context);

  const projectId = context.projectId;

  const listingKey = `LISTING_${listingId}`;
  const escrowKey = `ESCROW_${listingId}`;

  // txn lock
  const lockCustomId = "txnlocks";
  const lockKey = `LISTING_${listingId}`;
  const lockTtlSeconds = 10;

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const lockToken = `T${nowMs.toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`.toUpperCase();
  const lockExpiresAt = new Date(nowMs + lockTtlSeconds * 1000).toISOString();

  const acquireTxnLock = async () => {
    // 0) 기존 락 확인(있고 만료 전이면 실패)
    try {
      const existingRes = await cloudSave.getCustomItems(projectId, lockCustomId, [lockKey]);
      const rows = (existingRes?.data?.results || []);
      const row = rows.find(r => r.key === lockKey);
      if (row && row.value && typeof row.value === "object") {
        const v = row.value;
        if (v.status === "ACQUIRED" && typeof v.expiresAt === "string" && v.expiresAt > nowIso) {
          throw new Error("LOCKED");
        }
      }
    } catch (e) {
      if (e?.message === "LOCKED") throw new Error("BuyListing: listing is busy (lock held).");
      // get 실패는 무시(락이 없을 수도 있음). 무음 폴백 금지 → Warning 로그
      logger.warn(`BuyListing fallback: lock precheck failed. listingId=${listingId}. err=${e?.message || e}`);
    }

    // 1) 락 작성
    await cloudSave.setCustomItem(projectId, lockCustomId, {
      key: lockKey,
      value: {
        schema: 1,
        status: "ACQUIRED",
        token: lockToken,
        acquiredAt: nowIso,
        expiresAt: lockExpiresAt,
        ownerPlayerId: _buyerPlayerId
      }
    });

    // 2) 재조회로 내 락인지 검증(마지막 write 승자 문제 방지)
    const verifyRes = await cloudSave.getCustomItems(projectId, lockCustomId, [lockKey]);
    const verifyRows = (verifyRes?.data?.results || []);
    const verifyRow = verifyRows.find(r => r.key === lockKey);

    if (!verifyRow || !verifyRow.value || verifyRow.value.token !== lockToken) {
      throw new Error("BuyListing: failed to acquire txn lock (lost race).");
    }
  };

  const releaseTxnLock = async () => {
    try {
      await cloudSave.setCustomItem(projectId, lockCustomId, {
        key: lockKey,
        value: {
          schema: 1,
          status: "RELEASED",
          token: lockToken,
          releasedAt: new Date(Date.now()).toISOString(),
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          ownerPlayerId: _buyerPlayerId
        }
      });
    } catch (e) {
      logger.warn(`BuyListing fallback: failed to release txn lock. listingId=${listingId}. err=${e?.message || e}`);
    }
  };

  await acquireTxnLock();

  try {
    // 1) 리스팅 로드 + 검증
    const listingRes = await cloudSave.getCustomItems(projectId, _listingsCustomId, [listingKey]);
    const listingRows = (listingRes?.data?.results || []);
    const listingRow = listingRows.find(r => r.key === listingKey);

    if (!listingRow || typeof listingRow.value !== "object" || listingRow.value === null) {
      throw new Error(`BuyListing: listing not found (customId=${_listingsCustomId}, key=${listingKey}).`);
    }

    const listing = listingRow.value;

    if (listing.status !== "ACTIVE") {
      throw new Error(`BuyListing: listing is not ACTIVE. current=${listing.status}`);
    }

    if (typeof listing.expiresAt === "string" && listing.expiresAt <= nowIso) {
      throw new Error("BuyListing: listing is expired.");
    }

    const sellerPlayerId = listing.sellerPlayerId;
    const itemInstanceId = listing.itemInstanceId;
    const price = listing.price;
    const createdAt = listing.createdAt;

    if (!sellerPlayerId || typeof sellerPlayerId !== "string") {
      throw new Error("BuyListing: listing.sellerPlayerId missing.");
    }
    if (!itemInstanceId || typeof itemInstanceId !== "string") {
      throw new Error("BuyListing: listing.itemInstanceId missing.");
    }
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      throw new Error("BuyListing: listing.price invalid.");
    }
    if (sellerPlayerId === _buyerPlayerId) {
      throw new Error("BuyListing: buyer cannot purchase own listing.");
    }

    // 2) 에스크로 로드 + 검증
    const escrowRes = await cloudSave.getCustomItems(projectId, _escrowCustomId, [escrowKey]);
    const escrowRows = (escrowRes?.data?.results || []);
    const escrowRow = escrowRows.find(r => r.key === escrowKey);

    if (!escrowRow || typeof escrowRow.value !== "object" || escrowRow.value === null) {
      throw new Error(`BuyListing: escrow not found (customId=${_escrowCustomId}, key=${escrowKey}).`);
    }

    const escrow = escrowRow.value;

    if (escrow.status !== "HELD") {
      throw new Error(`BuyListing: escrow is not HELD. current=${escrow.status}`);
    }
    if (escrow.listingId !== listingId) {
      throw new Error("BuyListing: escrow.listingId mismatch.");
    }
    if (escrow.sellerPlayerId !== sellerPlayerId) {
      throw new Error("BuyListing: escrow.sellerPlayerId mismatch.");
    }
    if (!escrow.item || typeof escrow.item !== "object") {
      throw new Error("BuyListing: escrow.item missing.");
    }

    // 3) 수수료 계산
    const feeAmount = Math.floor((price * _feeBps) / 10000);
    const sellerReceives = price - feeAmount;

    if (sellerReceives < 0) {
      throw new Error("BuyListing: fee exceeds price.");
    }

    // 4) Economy 처리: 구매자 차감 → 판매자 지급 → (옵션) 수수료 지급
    // 주의: Economy SDK 2.4는 requestParameters 객체 형태를 사용한다.
    await economy.decrementPlayerCurrencyBalance({
      projectId,
      playerId: _buyerPlayerId,
      currencyId: _currencyId,
      currencyModifyBalanceRequest: { amount: price }
    });

    if (sellerReceives > 0) {
      await economy.incrementPlayerCurrencyBalance({
        projectId,
        playerId: sellerPlayerId,
        currencyId: _currencyId,
        currencyModifyBalanceRequest: { amount: sellerReceives }
      });
    }

    if (feeAmount > 0) {
      if (feeReceiverPlayerId && typeof feeReceiverPlayerId === "string") {
        await economy.incrementPlayerCurrencyBalance({
          projectId,
          playerId: feeReceiverPlayerId,
          currencyId: _currencyId,
          currencyModifyBalanceRequest: { amount: feeAmount }
        });
      } else {
        // 수수료 수신자가 없으면 의도된 소각(=시스템 유출). 폴백이 아니므로 warn 대상 아님.
      }
    }

    // 5) 아이템을 구매자 인벤으로 복구
    const item = escrow.item;

    // tradeLock / location 복구 + 폴백(Warning)
    if (!item.market || typeof item.market !== "object") {
      logger.warn(`BuyListing fallback: item.market missing in escrow. listingId=${listingId}`);
      item.market = { tradable: true, tradeLock: { isLocked: true, reason: "ESCROW", until: null } };
    }
    if (!item.market.tradeLock || typeof item.market.tradeLock !== "object") {
      logger.warn(`BuyListing fallback: item.market.tradeLock missing in escrow. listingId=${listingId}`);
      item.market.tradeLock = { isLocked: true, reason: "ESCROW", until: null };
    }

    item.market.tradeLock = { isLocked: false, reason: null, until: null };
    item.location = { zone: _returnZone };
    if (!item.lifecycle || typeof item.lifecycle !== "object") item.lifecycle = {};
    item.lifecycle.updatedAt = nowIso;

    const itemKey = `ITEM_${itemInstanceId}`;

    // 기존 키 존재 시 경고 후 덮어쓰기(충돌은 실제 운영에서 금지하는 게 맞지만, 무음 폴백은 금지)
    try {
      const existingRes = await cloudSave.getPrivateCustomItems(projectId, _inventoryCustomId, [itemKey]);
      const existingRows = (existingRes?.data?.results || []);
      if (existingRows.find(r => r.key === itemKey)) {
        logger.warn(`BuyListing fallback: inventory already has key. overwrite. key=${itemKey}`);
      }
    } catch (e) {
      logger.warn(`BuyListing fallback: failed to pre-check inventory key. key=${itemKey}. err=${e?.message || e}`);
    }

    await cloudSave.setPrivateCustomItem(projectId, _inventoryCustomId, { key: itemKey, value: item });

    // 6) 리스팅 SOLD 업데이트
    const soldListing = {
      ...listing,
      status: "SOLD",
      buyerPlayerId: _buyerPlayerId,
      soldAt: nowIso
    };
    await cloudSave.setCustomItem(projectId, _listingsCustomId, { key: listingKey, value: soldListing });

    // 7) 에스크로 tombstone 처리(삭제 대신)
    const escrowTombstone = {
      ...escrow,
      status: "TRANSFERRED",
      buyerPlayerId: _buyerPlayerId,
      transferredAt: nowIso,
      item: null
    };
    await cloudSave.setCustomItem(projectId, _escrowCustomId, { key: escrowKey, value: escrowTombstone });

    // 8) ACTIVE 인덱스 삭제(실패 시 Warning)
    try {
      const ymd = (typeof createdAt === "string" && createdAt.length >= 10) ?
        createdAt.slice(0, 10).replace(/-/g, "") :
        "00000000";
      const priceBucket = Math.floor(price).toString().padStart(12, "0");

      const idxStatusCreatedKey = `IDX_STATUS_CREATEDAT_ACTIVE_${ymd}_${listingId}`;
      const idxStatusPriceKey = `IDX_STATUS_PRICE_ACTIVE_${priceBucket}_${listingId}`;
      const idxSellerStatusKey = `IDX_SELLER_STATUS_${sellerPlayerId}_ACTIVE_${listingId}`;

      await cloudSave.deleteCustomItem(idxStatusCreatedKey, projectId, _indexesCustomId);
      await cloudSave.deleteCustomItem(idxStatusPriceKey, projectId, _indexesCustomId);
      await cloudSave.deleteCustomItem(idxSellerStatusKey, projectId, _indexesCustomId);
    } catch (e) {
      logger.warn(`BuyListing fallback: failed to delete index keys. listingId=${listingId}. err=${e?.message || e}`);
    }

    return {
      listingId,
      status: "SOLD",
      price,
      currencyId: _currencyId,
      feeAmount,
      sellerReceives,
      soldAt: nowIso,
      itemInstanceId
    };
  } finally {
    await releaseTxnLock();
  }
};