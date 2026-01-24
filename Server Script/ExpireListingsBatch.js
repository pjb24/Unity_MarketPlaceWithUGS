/**
 * ExpireListingsBatch
 *
 * 목적:
 * - Cloud Save "Custom Data"에 저장된 거래소 Listing 중, 만료 시간이 지난 ACTIVE Listing을 일괄 EXPIRED 처리한다.
 * - Listing 업데이트는 Cloud Save v1.4의 setCustomItemBatch(최대 20개 원자적 배치)를 활용한다.
 * - 에스크로(escrowKey)가 Listing에 포함되어 있으면, escrow 레코드도 tombstone 처리(status=RETURNED, item=null)한다.
 * - Listing에 escrowKey / expiresAt 등의 필수 정보가 없으면 "조용한 폴백" 없이 Warning 로그로 남기고,
 *   해당 Listing은 안전하게 스킵한다(데이터 손상 방지).
 *
 * 전제(권장 Listing 스키마 최소 필드):
 * - listingId: string
 * - status: "ACTIVE" | "SOLD" | "CANCELED" | "EXPIRED"
 * - expiresAt: ISO8601 string (예: "2026-01-24T12:34:56.789Z")
 * - updatedAt: ISO8601 string
 * - escrowKey?: string (에스크로 Custom Data의 key)
 *
 * params (최대 10개):
 *  1) listingsCustomId: string (선택, 기본 "market_listings")
 *  2) escrowCustomId: string (선택, 기본 "market_escrow")
 *  3) nowIso: string (선택, 기본 서버 now)
 *  4) batchSize: number (선택, 기본 50, 최대 500 권장)
 *  5) after: string (선택, Cloud Save getCustomItems pagination cursor)
 *  6) maxPages: number (선택, 기본 10, 과도 스캔 방지)
 *  7) dryRun: boolean (선택, 기본 false) - 실제 쓰기 없이 대상만 산출
 *
 * return:
 * {
 *   nowIso,
 *   listingsCustomId,
 *   escrowCustomId,
 *   scannedPages,
 *   scannedItems,
 *   expiredCount,
 *   skippedCount,
 *   warnings: string[],
 *   nextAfter: string | null
 * }
 */

const { DataApi, Configuration } = require("@unity-services/cloud-save-1.4");

module.exports = async function(params, context) {
  const listingsCustomId = (params.listingsCustomId || "market_listings").toString();
  const escrowCustomId = (params.escrowCustomId || "market_escrow").toString();

  const nowIso = (params.nowIso ? new Date(params.nowIso) : new Date()).toISOString();

  const batchSizeRaw = typeof params.batchSize === "number" ? params.batchSize : 50;
  const batchSize = Math.max(1, Math.min(500, Math.floor(batchSizeRaw)));

  const maxPagesRaw = typeof params.maxPages === "number" ? params.maxPages : 10;
  const maxPages = Math.max(1, Math.min(100, Math.floor(maxPagesRaw)));

  const dryRun = !!params.dryRun;

  // Cloud Save pagination cursor ("after")
  let after = params.after ? params.after.toString() : undefined;

  const warnings = [];
  const projectId = context.projectId;

  // Cloud Code 런타임에서는 보통 context.accessToken이 제공된다.
  // (서버 권한 API는 Cloud Code가 서버 권한으로 실행될 때 정상 동작)
  const accessToken = context.accessToken;
  if (!accessToken) {
    throw new Error("Missing context.accessToken.");
  }

  const cloudSaveApi = new DataApi(new Configuration({ accessToken }));

  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) {
    throw new Error(`Invalid nowIso: ${nowIso}`);
  }

  let scannedPages = 0;
  let scannedItems = 0;
  let expiredCount = 0;
  let skippedCount = 0;

  // 만료 대상 누적(쓰기 배치 구성용)
  const listingUpdates = [];
  const escrowUpdates = [];

  // Cloud Save setCustomItemBatch는 최대 20개씩이므로,
  // 여기서는 batchSize까지 모으되 실제 쓰기는 20 단위로 쪼갠다.
  async function flushBatches() {
    if (dryRun) {
      listingUpdates.length = 0;
      escrowUpdates.length = 0;
      return;
    }

    // Listing 업데이트 먼저
    for (let i = 0; i < listingUpdates.length; i += 20) {
      const slice = listingUpdates.slice(i, i + 20);
      await cloudSaveApi.setCustomItemBatch(projectId, listingsCustomId, {
        data: slice
      });
    }

    // Escrow tombstone 업데이트
    for (let i = 0; i < escrowUpdates.length; i += 20) {
      const slice = escrowUpdates.slice(i, i + 20);
      await cloudSaveApi.setPrivateCustomItemBatch(projectId, escrowCustomId, {
        data: slice
      });
    }

    listingUpdates.length = 0;
    escrowUpdates.length = 0;
  }

  // 배치 스캔
  while (scannedPages < maxPages && expiredCount < batchSize) {
    scannedPages += 1;

    // getCustomItems: pages of 20, alphabetically, cursor=after
    const res = await cloudSaveApi.getCustomItems(projectId, listingsCustomId, undefined, after);
    const data = res.data;

    const items = Array.isArray(data?.results) ? data.results : [];
    after = data?.links?.after || undefined;

    if (items.length === 0) break;

    for (const it of items) {
      if (expiredCount >= batchSize) break;

      scannedItems += 1;

      const key = it?.key;
      const value = it?.value;

      if (!key || !value || typeof value !== "object") {
        skippedCount += 1;
        const msg = `[ExpireListingsBatch][WARN] Skip invalid listing item. key=${String(key)}`;
        warnings.push(msg);
        console.warn(msg);
        continue;
      }

      const listing = value;

      if (listing.status !== "ACTIVE") continue;

      if (!listing.expiresAt) {
        skippedCount += 1;
        const msg = `[ExpireListingsBatch][WARN] ACTIVE listing missing expiresAt. listingKey=${key}`;
        warnings.push(msg);
        console.warn(msg);
        continue;
      }

      const expiresMs = Date.parse(listing.expiresAt);
      if (Number.isNaN(expiresMs)) {
        skippedCount += 1;
        const msg = `[ExpireListingsBatch][WARN] ACTIVE listing has invalid expiresAt. listingKey=${key} expiresAt=${listing.expiresAt}`;
        warnings.push(msg);
        console.warn(msg);
        continue;
      }

      if (expiresMs > nowMs) continue;

      // 만료 처리 대상
      const updatedListing = {
        ...listing,
        status: "EXPIRED",
        updatedAt: nowIso,
        expiredAt: nowIso
      };

      listingUpdates.push({
        key,
        value: updatedListing,
        // writeLock을 사용 중이면 listing.writeLock 같은 형태로 넣어야 한다.
        // 여기서는 스키마 강제하지 않음.
        writeLock: listing.writeLock || undefined
      });

      // escrow tombstone 처리(있을 때만)
      if (listing.escrowKey) {
        escrowUpdates.push({
          key: listing.escrowKey,
          value: {
            status: "RETURNED",
            updatedAt: nowIso,
            item: null,
            listingId: listing.listingId || null
          },
          writeLock: undefined
        });
      } else {
        const msg = `[ExpireListingsBatch][WARN] Listing expired but missing escrowKey. listingKey=${key} listingId=${listing.listingId || "?"}`;
        warnings.push(msg);
        console.warn(msg);
      }

      expiredCount += 1;

      // setCustomItemBatch는 최대 20개씩이라 너무 쌓이면 중간 flush
      if (listingUpdates.length >= 20) {
        await flushBatches();
      }
    }

    if (!after) break; // 더 없음
  }

  // 남은 것 flush
  await flushBatches();

  return {
    nowIso,
    listingsCustomId,
    escrowCustomId,
    scannedPages,
    scannedItems,
    expiredCount,
    skippedCount,
    warnings,
    nextAfter: after || null,
    dryRun
  };
};