/**
 * ForceCloseListing
 *
 * 목적:
 * - 운영/관리 목적으로 특정 Listing을 강제 종료한다.
 * - Listing 상태를 강제로 CANCELED 또는 EXPIRED로 전환하고,
 *   연결된 Escrow(HELD)를 tombstone(RETURNED, item=null) 처리한다.
 * - 실제 아이템을 판매자 인벤으로 되돌리는 작업은 여기서 하지 않는다(AGGRESSIVE 복구 금지).
 *   아이템 반환은 별도 ReturnItemFromEscrow/운영 복구 플로우로 처리한다.
 *
 * Cloud Save v1.4 사용:
 * - getCustomItem / getCustomItems 로 Listing/Escrow 조회
 * - setCustomItem 로 Listing 업데이트
 * - setCustomItem 로 Escrow tombstone 업데이트
 *
 * 안전 정책:
 * - 필수 필드 누락/상태 불일치 시 무음 폴백 금지. 반드시 Warning 로그를 남기고,
 *   가능한 범위에서 "상태 정리"만 수행한다.
 *
 * params (최대 10개):
 *  1) listingKey: string (필수)          // listingsCustomId 내부 key
 *  2) closeToStatus: "CANCELED" | "EXPIRED" (선택, 기본 "CANCELED")
 *  3) reasonCode: string (선택, 기본 "OPS_FORCE_CLOSE")
 *  4) note: string (선택, 기본 null)    // 운영 메모
 *  5) listingsCustomId: string (선택, 기본 "market_listings")
 *  6) escrowCustomId: string (선택, 기본 "market_escrow")
 *  7) nowIso: string (선택, 기본 서버 now)
 *  8) expectedStatus: string (선택, 기본 null)  // 예: "ACTIVE" 지정 시 아니면 경고 후 진행
 *  9) dryRun: boolean (선택, 기본 false)
 * 10) requireEscrowHeld: boolean (선택, 기본 false) // true면 escrow.status!=HELD 시 경고 후 tombstone 생략
 *
 * return:
 * {
 *   listingKey,
 *   closeToStatus,
 *   reasonCode,
 *   nowIso,
 *   listingUpdated: boolean,
 *   escrowUpdated: boolean,
 *   warnings: string[]
 * }
 */

const { DataApi, Configuration } = require("@unity-services/cloud-save-1.4");

module.exports = async function(params, context) {
  const listingKey = params.listingKey ? params.listingKey.toString() : "";
  if (!listingKey) throw new Error("listingKey is required.");

  const closeToStatus = (params.closeToStatus || "CANCELED").toString();
  if (closeToStatus !== "CANCELED" && closeToStatus !== "EXPIRED") {
    throw new Error(`Invalid closeToStatus: ${closeToStatus}`);
  }

  const reasonCode = (params.reasonCode || "OPS_FORCE_CLOSE").toString();
  const note = params.note !== undefined && params.note !== null ? String(params.note) : null;

  const listingsCustomId = (params.listingsCustomId || "market_listings").toString();
  const escrowCustomId = (params.escrowCustomId || "market_escrow").toString();

  const nowIso = (params.nowIso ? new Date(params.nowIso) : new Date()).toISOString();

  const expectedStatus = params.expectedStatus !== undefined && params.expectedStatus !== null ? String(params.expectedStatus) : null;
  const dryRun = !!params.dryRun;
  const requireEscrowHeld = !!params.requireEscrowHeld;

  const warnings = [];

  function warn(msg) {
    warnings.push(msg);
    console.warn(msg);
  }

  const projectId = context.projectId;
  const accessToken = context.accessToken;
  if (!accessToken) throw new Error("Missing context.accessToken.");

  const cloudSaveApi = new DataApi(new Configuration({ accessToken }));

  // 1) Listing 조회
  let listingItem;
  try {
    const res = await cloudSaveApi.getCustomItem(projectId, listingsCustomId, listingKey);
    listingItem = res.data;
  } catch (e) {
    throw new Error(`Listing not found. listingsCustomId=${listingsCustomId} listingKey=${listingKey}`);
  }

  const listingValue = listingItem?.value;
  const listingWriteLock = listingItem?.writeLock;

  if (!listingValue || typeof listingValue !== "object") {
    throw new Error(`Listing value corrupted. listingKey=${listingKey}`);
  }

  if (expectedStatus && listingValue.status !== expectedStatus) {
    warn(
      `[ForceCloseListing][WARN] Listing status mismatch. listingKey=${listingKey} expected=${expectedStatus} actual=${listingValue.status}`
    );
  }

  const escrowKey = listingValue.escrowKey ? String(listingValue.escrowKey) : null;
  if (!escrowKey) {
    warn(`[ForceCloseListing][WARN] Listing missing escrowKey. listingKey=${listingKey} listingId=${listingValue.listingId || "?"}`);
  }

  // 2) Listing 강제 종료 업데이트
  const updatedListing = {
    ...listingValue,
    status: closeToStatus,
    updatedAt: nowIso,
    closedAt: nowIso,
    close: {
      type: "FORCE",
      reason: reasonCode,
      note: note,
      by: context.playerId || "SERVER",
      at: nowIso
    }
  };

  if (closeToStatus === "CANCELED" && !updatedListing.canceledAt) updatedListing.canceledAt = nowIso;
  if (closeToStatus === "EXPIRED" && !updatedListing.expiredAt) updatedListing.expiredAt = nowIso;

  let listingUpdated = false;
  if (!dryRun) {
    await cloudSaveApi.setCustomItem(projectId, listingsCustomId, listingKey, {
      value: updatedListing,
      writeLock: listingWriteLock || undefined
    });
    listingUpdated = true;
  }

  // 3) Escrow tombstone 처리(가능하면)
  let escrowUpdated = false;
  if (escrowKey) {
    let escrowItem = null;
    try {
      const res = await cloudSaveApi.getCustomItem(projectId, escrowCustomId, escrowKey);
      escrowItem = res.data;
    } catch (e) {
      warn(`[ForceCloseListing][WARN] Escrow not found. escrowKey=${escrowKey}`);
      escrowItem = null;
    }

    if (escrowItem && escrowItem.value && typeof escrowItem.value === "object") {
      const escrowValue = escrowItem.value;

      if (requireEscrowHeld && escrowValue.status !== "HELD") {
        warn(
          `[ForceCloseListing][WARN] Escrow status is not HELD; requireEscrowHeld=true so skip tombstone. escrowKey=${escrowKey} status=${escrowValue.status}`
        );
      } else {
        const tombstoneEscrow = {
          ...escrowValue,
          status: "RETURNED",
          updatedAt: nowIso,
          closedAt: nowIso,
          item: null,
          close: {
            type: "FORCE",
            reason: reasonCode,
            note: note,
            listingKey: listingKey,
            listingId: listingValue.listingId || null,
            by: context.playerId || "SERVER",
            at: nowIso
          }
        };

        if (!dryRun) {
          await cloudSaveApi.setCustomItem(projectId, escrowCustomId, escrowKey, {
            value: tombstoneEscrow,
            writeLock: escrowItem.writeLock || undefined
          });
          escrowUpdated = true;
        }
      }
    } else if (escrowItem) {
      warn(`[ForceCloseListing][WARN] Escrow value corrupted. escrowKey=${escrowKey}`);
    }
  }

  return {
    listingKey,
    closeToStatus,
    reasonCode,
    nowIso,
    listingUpdated,
    escrowUpdated,
    warnings,
    dryRun
  };
};