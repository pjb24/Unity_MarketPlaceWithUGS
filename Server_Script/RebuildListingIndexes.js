/**
 * RebuildListingIndexes
 *
 * 목적:
 * - Cloud Save "Listing" 원본 데이터(예: market_listings)로부터
 *   검색/정렬/필터를 위한 인덱스 레코드(예: market_indexes)를 재생성한다.
 * - UGS Cloud Save는 RDB 인덱스가 없으므로, "키 설계"가 인덱스다.
 * - 본 스크립트는 Listing을 페이지 스캔하면서, Listing 상태에 맞는 인덱스 키를 만든다.
 *
 * 인덱스 설계(예시, 필요 시 규칙을 맞춰 변경):
 * - IDX_STATUS_CREATEDAT:<status>:<createdAtKey>:<listingKey>
 * - IDX_STATUS_PRICE:<status>:<priceKey>:<listingKey>
 * - IDX_SELLER_STATUS:<sellerId>:<status>:<createdAtKey>:<listingKey>
 * - (선택) IDX_SLOT_STATUS:<slot>:<status>:<createdAtKey>:<listingKey>
 * - (선택) IDX_RARITY_STATUS:<rarity>:<status>:<createdAtKey>:<listingKey>
 *
 * createdAtKey:
 * - 정렬용 문자열. ISO8601을 그대로 쓰면 사전순 정렬이 시간순과 동일하다.
 * - 단, ':' 문자는 customId 제약이 아니라 key에는 허용되지만,
 *   운영 도구/파이프라인에서 다루기 불편하면 '-' '_'로 치환을 권장.
 *
 * priceKey:
 * - 가격순 인덱스는 숫자 사전순 문제를 피하기 위해 0-padding 문자열을 사용한다.
 * - 예: MT가 정수 단위로 저장될 때, padLen=12면 "000000012345" 같은 형태.
 *
 * 동작:
 * 1) Listing 커스텀 컬렉션을 getCustomItems로 페이지 스캔
 * 2) 각 Listing에 대해 (ACTIVE 중심, 옵션으로 SOLD 포함 가능) 인덱스 키를 생성
 * 3) 인덱스 컬렉션에 setCustomItemBatch(최대 20개)로 upsert
 *
 * 주의:
 * - "기존 인덱스 삭제"는 안전하지 않다(대량 삭제 API 부재 + 실수 위험).
 *   대신, 새 인덱스만 생성/갱신하고, 오래된/고아 인덱스 정리는 별도 스크립트로 수행한다.
 * - Listing 데이터가 불완전하면 무음 폴백 금지. Warning 로그를 남기고 스킵한다.
 *
 * params (최대 10개):
 *  1) listingsCustomId: string (선택, 기본 "market_listings")
 *  2) indexCustomId: string (선택, 기본 "market_indexes")
 *  3) after: string (선택, listing 스캔 커서)
 *  4) maxPages: number (선택, 기본 20, 최대 200)
 *  5) maxListings: number (선택, 기본 500, 최대 5000) - 이번 실행에서 처리할 Listing 수 상한
 *  6) includeStatuses: string[] (선택, 기본 ["ACTIVE"]) - 예: ["ACTIVE","SOLD"]
 *  7) padLen: number (선택, 기본 12, 6~18 권장)
 *  8) dryRun: boolean (선택, 기본 false) - 실제 쓰기 없이 생성 키만 카운트
 *  9) enableSlotIndex: boolean (선택, 기본 true)
 * 10) enableRarityIndex: boolean (선택, 기본 true)
 *
 * return:
 * {
 *   listingsCustomId,
 *   indexCustomId,
 *   scannedPages,
 *   scannedListings,
 *   writtenIndexCount,
 *   skippedCount,
 *   warnings: string[],
 *   nextAfter: string | null,
 *   dryRun
 * }
 */

const { DataApi, Configuration } = require("@unity-services/cloud-save-1.4");

module.exports = async function(params, context) {
  const listingsCustomId = (params.listingsCustomId || "market_listings").toString();
  const indexCustomId = (params.indexCustomId || "market_indexes").toString();

  let after = params.after ? params.after.toString() : undefined;

  const maxPagesRaw = typeof params.maxPages === "number" ? params.maxPages : 20;
  const maxPages = Math.max(1, Math.min(200, Math.floor(maxPagesRaw)));

  const maxListingsRaw = typeof params.maxListings === "number" ? params.maxListings : 500;
  const maxListings = Math.max(1, Math.min(5000, Math.floor(maxListingsRaw)));

  const includeStatuses = Array.isArray(params.includeStatuses) && params.includeStatuses.length > 0 ?
    params.includeStatuses.map((s) => String(s)) :
    ["ACTIVE"];

  const padLenRaw = typeof params.padLen === "number" ? params.padLen : 12;
  const padLen = Math.max(6, Math.min(18, Math.floor(padLenRaw)));

  const dryRun = !!params.dryRun;
  const enableSlotIndex = params.enableSlotIndex !== undefined ? !!params.enableSlotIndex : true;
  const enableRarityIndex = params.enableRarityIndex !== undefined ? !!params.enableRarityIndex : true;

  const warnings = [];

  function warn(msg) {
    warnings.push(msg);
    console.warn(msg);
  }

  const projectId = context.projectId;
  const accessToken = context.accessToken;
  if (!accessToken) throw new Error("Missing context.accessToken.");

  const cloudSaveApi = new DataApi(new Configuration({ accessToken }));

  let scannedPages = 0;
  let scannedListings = 0;
  let writtenIndexCount = 0;
  let skippedCount = 0;

  const indexWrites = [];

  function safeStr(v, fallback = "") {
    return v === null || v === undefined ? fallback : String(v);
  }

  function normalizeKeyPart(s) {
    // 키 파트에 공백/슬래시 등 위험 문자를 최대한 줄임(완전한 sanitize가 필요하면 규칙 강화)
    return safeStr(s).trim().replace(/\s+/g, "_").replace(/[\/\\?#]+/g, "_");
  }

  function isoKey(iso) {
    // ISO8601은 사전순 정렬 == 시간순 정렬이므로 그대로 사용 가능.
    // 다만 키 가독성/도구 호환 위해 ':'를 '-'로 치환
    return safeStr(iso).replace(/:/g, "-");
  }

  function priceKey(priceNumber) {
    const n = typeof priceNumber === "number" ? priceNumber : Number(priceNumber);
    if (!Number.isFinite(n) || n < 0) return null;

    // 소수 가격을 쓰면 문제가 커지므로, 여기서는 "정수 스케일"로 저장된다고 가정.
    // 소수 지원이면: priceMinorUnit(예: cents)로 저장하고 pad 적용해야 함.
    const asInt = Math.floor(n);
    const s = String(asInt);
    if (s.length > padLen) {
      // padLen을 넘는 가격은 정렬키가 깨질 수 있으니 경고 후 truncate 금지(오류 데이터 취급)
      return null;
    }
    return s.padStart(padLen, "0");
  }

  async function flushIndexBatches() {
    if (dryRun) {
      indexWrites.length = 0;
      return;
    }

    for (let i = 0; i < indexWrites.length; i += 20) {
      const slice = indexWrites.slice(i, i + 20);
      await cloudSaveApi.setCustomItemBatch(projectId, indexCustomId, { data: slice });
      writtenIndexCount += slice.length;
    }
    indexWrites.length = 0;
  }

  function enqueueIndex(key, value) {
    indexWrites.push({ key, value });
    if (indexWrites.length >= 20) return true;
    return false;
  }

  while (scannedPages < maxPages && scannedListings < maxListings) {
    scannedPages += 1;

    const res = await cloudSaveApi.getCustomItems(projectId, listingsCustomId, undefined, after);
    const payload = res.data;

    const items = Array.isArray(payload?.results) ? payload.results : [];
    after = payload?.links?.after || undefined;

    if (items.length === 0) break;

    for (const it of items) {
      if (scannedListings >= maxListings) break;

      const listingKey = it?.key;
      const listing = it?.value;

      scannedListings += 1;

      if (!listingKey || !listing || typeof listing !== "object") {
        skippedCount += 1;
        warn(`[RebuildListingIndexes][WARN] Skip invalid listing record. key=${String(listingKey)}`);
        continue;
      }

      const status = safeStr(listing.status);
      if (!includeStatuses.includes(status)) continue;

      const createdAt = listing.createdAt || listing.lifecycle?.createdAt;
      if (!createdAt) {
        skippedCount += 1;
        warn(`[RebuildListingIndexes][WARN] Missing createdAt. listingKey=${listingKey} status=${status}`);
        continue;
      }

      const createdAtKey = isoKey(createdAt);

      const sellerId = listing.sellerPlayerId || listing.sellerAccountId || listing.sellerId;
      if (!sellerId) {
        skippedCount += 1;
        warn(`[RebuildListingIndexes][WARN] Missing sellerId. listingKey=${listingKey} status=${status}`);
        continue;
      }

      // 가격
      const price = listing.price ?? listing.priceMT ?? listing.askPrice;
      const pKey = priceKey(price);
      if (pKey === null) {
        skippedCount += 1;
        warn(`[RebuildListingIndexes][WARN] Invalid price for price index. listingKey=${listingKey} price=${String(price)}`);
        // 가격 인덱스만 스킵하고 createdAt/seller 인덱스는 만들 수도 있지만,
        // 정렬/검색 일관성을 위해 여기서는 Listing 자체를 스킵한다.
        continue;
      }

      const sellerKey = normalizeKeyPart(sellerId);

      // 필터용 속성(선택)
      const slot = listing.slot || listing.itemSlot || listing.item?.slot;
      const rarity = listing.rarity || listing.itemRarity || listing.item?.rarity;

      // 1) 최신순/상태 인덱스
      // - key 마지막에 listingKey를 넣어 유니크 보장
      const k1 = `IDX_STATUS_CREATEDAT:${status}:${createdAtKey}:${listingKey}`;
      const vBase = {
        listingKey,
        status,
        createdAt,
        price: typeof price === "number" ? price : Number(price),
        sellerId: sellerId
      };

      if (enqueueIndex(k1, vBase)) await flushIndexBatches();

      // 2) 가격순/상태 인덱스
      const k2 = `IDX_STATUS_PRICE:${status}:${pKey}:${listingKey}`;
      if (enqueueIndex(k2, vBase)) await flushIndexBatches();

      // 3) 판매자/상태 인덱스 (내 등록 목록 등)
      const k3 = `IDX_SELLER_STATUS:${sellerKey}:${status}:${createdAtKey}:${listingKey}`;
      if (enqueueIndex(k3, vBase)) await flushIndexBatches();

      // 4) 슬롯/상태 인덱스 (선택)
      if (enableSlotIndex && slot) {
        const slotKey = normalizeKeyPart(slot);
        const k4 = `IDX_SLOT_STATUS:${slotKey}:${status}:${createdAtKey}:${listingKey}`;
        if (enqueueIndex(k4, { ...vBase, slot })) await flushIndexBatches();
      } else if (enableSlotIndex && !slot) {
        // slot 인덱스가 켜져 있는데 slot이 없으면 경고 (무음 폴백 금지)
        warn(`[RebuildListingIndexes][WARN] Slot index enabled but listing missing slot. listingKey=${listingKey}`);
      }

      // 5) 등급/상태 인덱스 (선택)
      if (enableRarityIndex && rarity) {
        const rarityKey = normalizeKeyPart(rarity);
        const k5 = `IDX_RARITY_STATUS:${rarityKey}:${status}:${createdAtKey}:${listingKey}`;
        if (enqueueIndex(k5, { ...vBase, rarity })) await flushIndexBatches();
      } else if (enableRarityIndex && !rarity) {
        warn(`[RebuildListingIndexes][WARN] Rarity index enabled but listing missing rarity. listingKey=${listingKey}`);
      }

      // 너무 많은 인덱스 생성으로 초과 처리 방지(배치 상한에 걸리면 탈출)
      if (dryRun) {
        // dryRun은 writtenIndexCount를 안 올리므로,
        // 대략치로 현재 쌓인 indexWrites로 제한
        if (indexWrites.length >= 20) indexWrites.length = 0;
      }
    }

    if (!after) break;
  }

  await flushIndexBatches();

  return {
    listingsCustomId,
    indexCustomId,
    scannedPages,
    scannedListings,
    writtenIndexCount: dryRun ? 0 : writtenIndexCount,
    skippedCount,
    warnings,
    nextAfter: after || null,
    dryRun
  };
};