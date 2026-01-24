/**
 * ReconcileListingState
 *
 * 목적:
 * - 거래소 Listing(Custom Data)과 Escrow(Custom Data)의 불일치 상태를 탐지/복구한다.
 * - 대표 불일치 케이스:
 *   1) Listing이 ACTIVE인데 escrowKey가 없거나, escrow 레코드가 없음  -> Listing을 EXPIRED(만료) 또는 CANCELED(비정상)로 전환
 *   2) Escrow가 HELD인데 연결된 Listing이 없거나 ACTIVE가 아님     -> Escrow를 tombstone(RETURNED, item=null) 처리
 *   3) Listing이 ACTIVE인데 expiresAt이 지남                        -> Listing을 EXPIRED로 전환(ExpireListingsBatch 성격 일부 포함)
 * - Cloud Save v1.4:
 *   - getCustomItems(projectId, customId, keys?, after?)로 페이지 스캔/키 단건군 조회
 *   - setCustomItemBatch(projectId, customId, { data: [...] })로 최대 20개 원자적 배치 업데이트
 *
 * 안전 정책:
 * - 데이터가 불완전하면 "무음 폴백" 금지. 반드시 console.warn으로 원인/대상 키를 남기고 스킵/완화 처리한다.
 * - SAFE 모드 기본: '소유권 이전' 같은 공격적 복구는 하지 않고, Listing 상태 정리 + Escrow tombstone만 수행한다.
 *
 * params (최대 10개):
 *  1) listingsCustomId: string (선택, 기본 "market_listings")
 *  2) escrowCustomId: string (선택, 기본 "market_escrow")
 *  3) nowIso: string (선택, 기본 서버 now)
 *  4) batchSize: number (선택, 기본 50, 최대 500 권장)
 *  5) afterListing: string (선택, listing 스캔 커서)
 *  6) afterEscrow: string (선택, escrow 스캔 커서)
 *  7) maxPages: number (선택, 기본 10, 최대 100)
 *  8) dryRun: boolean (선택, 기본 false) - 실제 쓰기 없이 탐지 결과만 산출
 *  9) reconcileMode: "SAFE" | "AGGRESSIVE" (선택, 기본 "SAFE") - 현재 구현은 SAFE 중심
 * 10) scanOrphanEscrow: boolean (선택, 기본 true) - orphan escrow 스캔/정리 수행
 *
 * return:
 * {
 *   nowIso,
 *   listingsCustomId,
 *   escrowCustomId,
 *   reconcileMode,
 *   dryRun,
 *   scannedListingPages,
 *   scannedEscrowPages,
 *   scannedListings,
 *   scannedEscrows,
 *   fixedListings,
 *   fixedEscrows,
 *   skipped,
 *   warnings: string[],
 *   nextAfterListing: string | null,
 *   nextAfterEscrow: string | null
 * }
 */

const { DataApi, Configuration } = require("@unity-services/cloud-save-1.4");

module.exports = async function(params, context) {
  const listingsCustomId = (params.listingsCustomId || "market_listings").toString();
  const escrowCustomId = (params.escrowCustomId || "market_escrow").toString();

  const nowIso = (params.nowIso ? new Date(params.nowIso) : new Date()).toISOString();
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) throw new Error(`Invalid nowIso: ${nowIso}`);

  const batchSizeRaw = typeof params.batchSize === "number" ? params.batchSize : 50;
  const batchSize = Math.max(1, Math.min(500, Math.floor(batchSizeRaw)));

  const maxPagesRaw = typeof params.maxPages === "number" ? params.maxPages : 10;
  const maxPages = Math.max(1, Math.min(100, Math.floor(maxPagesRaw)));

  const dryRun = !!params.dryRun;
  const reconcileMode = (params.reconcileMode || "SAFE").toString();
  const scanOrphanEscrow = params.scanOrphanEscrow !== undefined ? !!params.scanOrphanEscrow : true;

  let afterListing = params.afterListing ? params.afterListing.toString() : undefined;
  let afterEscrow = params.afterEscrow ? params.afterEscrow.toString() : undefined;

  const warnings = [];

  const projectId = context.projectId;
  const accessToken = context.accessToken;
  if (!accessToken) throw new Error("Missing context.accessToken.");

  const cloudSaveApi = new DataApi(new Configuration({ accessToken }));

  let scannedListingPages = 0;
  let scannedEscrowPages = 0;
  let scannedListings = 0;
  let scannedEscrows = 0;

  let fixedListings = 0;
  let fixedEscrows = 0;
  let skipped = 0;

  const listingUpdates = [];
  const escrowUpdates = [];

  function warn(msg) {
    warnings.push(msg);
    console.warn(msg);
  }

  function parseIsoMs(iso, label, key) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) {
      warn(`[ReconcileListingState][WARN] Invalid ${label}. key=${key} value=${iso}`);
      return null;
    }
    return ms;
  }

  async function flushCustomBatches() {
    if (dryRun) {
      listingUpdates.length = 0;
      escrowUpdates.length = 0;
      return;
    }

    for (let i = 0; i < listingUpdates.length; i += 20) {
      const slice = listingUpdates.slice(i, i + 20);
      await cloudSaveApi.setCustomItemBatch(projectId, listingsCustomId, { data: slice });
    }

    for (let i = 0; i < escrowUpdates.length; i += 20) {
      const slice = escrowUpdates.slice(i, i + 20);
      await cloudSaveApi.setCustomItemBatch(projectId, escrowCustomId, { data: slice });
    }

    listingUpdates.length = 0;
    escrowUpdates.length = 0;
  }

  function enqueueListingFix(itemKey, listingValue, writeLock, newStatus, reasonCode) {
    const updated = {
      ...listingValue,
      status: newStatus,
      updatedAt: nowIso,
      reconciledAt: nowIso,
      reconcile: {
        mode: reconcileMode,
        reason: reasonCode
      }
    };

    if (newStatus === "EXPIRED" && !updated.expiredAt) updated.expiredAt = nowIso;
    if (newStatus === "CANCELED" && !updated.canceledAt) updated.canceledAt = nowIso;

    listingUpdates.push({
      key: itemKey,
      value: updated,
      writeLock: writeLock || undefined
    });

    fixedListings += 1;
  }

  function enqueueEscrowTombstone(escrowKey, escrowValue, writeLock, reasonCode) {
    const tombstone = {
      ...(escrowValue && typeof escrowValue === "object" ? escrowValue : {}),
      status: "RETURNED",
      updatedAt: nowIso,
      reconciledAt: nowIso,
      reconcile: {
        mode: reconcileMode,
        reason: reasonCode
      },
      item: null
    };

    escrowUpdates.push({
      key: escrowKey,
      value: tombstone,
      writeLock: writeLock || undefined
    });

    fixedEscrows += 1;
  }

  // 1) Listing 스캔: ACTIVE인데 escrow 불일치 / 만료 지남 등을 정리
  // - batchSize만큼 "fix 후보"가 차면 중단
  const listingFixCandidates = []; // { listingKey, listingValue, listingWriteLock, escrowKey }
  while (scannedListingPages < maxPages && (fixedListings + fixedEscrows) < batchSize) {
    scannedListingPages += 1;

    const res = await cloudSaveApi.getCustomItems(projectId, listingsCustomId, undefined, afterListing);
    const payload = res.data;

    const items = Array.isArray(payload?.results) ? payload.results : [];
    afterListing = payload?.links?.after || undefined;

    if (items.length === 0) break;

    for (const it of items) {
      if ((fixedListings + fixedEscrows) >= batchSize) break;

      scannedListings += 1;

      const listingKey = it?.key;
      const listingValue = it?.value;
      const listingWriteLock = it?.writeLock;

      if (!listingKey || !listingValue || typeof listingValue !== "object") {
        skipped += 1;
        warn(`[ReconcileListingState][WARN] Skip invalid listing record. key=${String(listingKey)}`);
        continue;
      }

      // ACTIVE만 정리 대상
      if (listingValue.status !== "ACTIVE") continue;

      // expiresAt 검증
      if (!listingValue.expiresAt) {
        skipped += 1;
        warn(`[ReconcileListingState][WARN] ACTIVE listing missing expiresAt. listingKey=${listingKey}`);
        continue;
      }

      const expiresMs = parseIsoMs(listingValue.expiresAt, "expiresAt", listingKey);
      if (expiresMs === null) {
        skipped += 1;
        continue;
      }

      // 만료가 지났으면 무조건 EXPIRED로 정리(escrow 유무와 무관)
      if (expiresMs <= nowMs) {
        enqueueListingFix(listingKey, listingValue, listingWriteLock, "EXPIRED", "RECON_EXPIRED_BY_TIME");
        // escrowKey가 있으면 escrow도 같이 점검/정리 대상으로 넣음(없으면 경고)
        if (listingValue.escrowKey) {
          listingFixCandidates.push({
            listingKey,
            listingValue,
            listingWriteLock,
            escrowKey: listingValue.escrowKey
          });
        } else {
          warn(`[ReconcileListingState][WARN] Listing expired but missing escrowKey. listingKey=${listingKey} listingId=${listingValue.listingId || "?"}`);
        }

        if (listingUpdates.length >= 20) await flushCustomBatches();
        continue;
      }

      // 만료 전 ACTIVE인데 escrowKey가 없으면 비정상 -> CANCELED
      if (!listingValue.escrowKey) {
        enqueueListingFix(listingKey, listingValue, listingWriteLock, "CANCELED", "RECON_ACTIVE_MISSING_ESCROWKEY");
        warn(`[ReconcileListingState][WARN] ACTIVE listing missing escrowKey -> CANCELED. listingKey=${listingKey} listingId=${listingValue.listingId || "?"}`);
        if (listingUpdates.length >= 20) await flushCustomBatches();
        continue;
      }

      // escrow 존재 여부는 키 묶어서 조회 후 처리
      listingFixCandidates.push({
        listingKey,
        listingValue,
        listingWriteLock,
        escrowKey: listingValue.escrowKey
      });

      // 후보가 많이 쌓이면 escrow 조회/처리
      if (listingFixCandidates.length >= 20) break;
    }

    if (listingFixCandidates.length >= 20) break;
    if (!afterListing) break;
  }

  // Listing 후보의 escrowKey들을 실제로 조회해서, "ACTIVE인데 escrow 없음" 등을 처리
  async function reconcileListingCandidates() {
    if (listingFixCandidates.length === 0) return;

    const escrowKeys = listingFixCandidates
      .map((c) => c.escrowKey)
      .filter((k) => typeof k === "string" && k.length > 0);

    // getCustomItems(keys=[])는 pages of 20이므로 20개까지만
    const uniqueKeys = Array.from(new Set(escrowKeys)).slice(0, 20);
    const escrowRes = await cloudSaveApi.getCustomItems(projectId, escrowCustomId, uniqueKeys);
    const escrowItems = Array.isArray(escrowRes.data?.results) ? escrowRes.data.results : [];

    const escrowMap = new Map(); // key -> { value, writeLock }
    for (const e of escrowItems) {
      if (e?.key) escrowMap.set(e.key, { value: e.value, writeLock: e.writeLock });
    }

    for (const c of listingFixCandidates) {
      if ((fixedListings + fixedEscrows) >= batchSize) break;

      const listingKey = c.listingKey;
      const listingValue = c.listingValue;

      const escrowKey = c.escrowKey;
      const escrow = escrowMap.get(escrowKey);

      // escrow 레코드 없음: ACTIVE(또는 EXPIRED로 이미 바뀌었어도) 상태 불일치 -> Listing을 CANCELED/EXPIRED로 정리 + 경고
      if (!escrow) {
        // Listing이 이미 EXPIRED 처리된 경우면 추가로 CANCELED로 바꾸지 않음
        // (Listing 업데이트가 큐에 들어갔을 수도 있어 value 기반으로 결정하긴 어려움)
        // 여기선 "현재 value.status" 기준으로 처리
        if (listingValue.status === "ACTIVE") {
          enqueueListingFix(listingKey, listingValue, c.listingWriteLock, "CANCELED", "RECON_ACTIVE_ESCROW_MISSING");
        }
        warn(`[ReconcileListingState][WARN] Listing escrow missing. listingKey=${listingKey} escrowKey=${escrowKey} -> listing fixed`);
        continue;
      }

      const escrowValue = escrow.value;
      if (!escrowValue || typeof escrowValue !== "object") {
        // escrow 내용이 깨짐 -> escrow tombstone + listing cancel
        enqueueEscrowTombstone(escrowKey, escrowValue, escrow.writeLock, "RECON_ESCROW_CORRUPTED");
        if (listingValue.status === "ACTIVE") {
          enqueueListingFix(listingKey, listingValue, c.listingWriteLock, "CANCELED", "RECON_ESCROW_CORRUPTED");
        }
        warn(`[ReconcileListingState][WARN] Escrow corrupted. escrowKey=${escrowKey} listingKey=${listingKey}`);
        continue;
      }

      // escrow.status가 HELD가 아니면, listing이 ACTIVE인 건 비정상 -> listing cancel
      if (escrowValue.status && escrowValue.status !== "HELD") {
        if (listingValue.status === "ACTIVE") {
          enqueueListingFix(listingKey, listingValue, c.listingWriteLock, "CANCELED", "RECON_ACTIVE_ESCROW_NOT_HELD");
          warn(`[ReconcileListingState][WARN] ACTIVE listing but escrow not HELD. listingKey=${listingKey} escrowKey=${escrowKey} escrowStatus=${escrowValue.status}`);
        }
        continue;
      }

      // escrow가 listingId/listingKey 정보를 갖고 있는데 mismatch면 tombstone으로 정리
      if (escrowValue.listingKey && escrowValue.listingKey !== listingKey) {
        enqueueEscrowTombstone(escrowKey, escrowValue, escrow.writeLock, "RECON_ESCROW_LISTINGKEY_MISMATCH");
        if (listingValue.status === "ACTIVE") {
          enqueueListingFix(listingKey, listingValue, c.listingWriteLock, "CANCELED", "RECON_ESCROW_LISTINGKEY_MISMATCH");
        }
        warn(`[ReconcileListingState][WARN] Escrow listingKey mismatch. escrowKey=${escrowKey} escrow.listingKey=${escrowValue.listingKey} expected=${listingKey}`);
      }

      // batch flush
      if (listingUpdates.length >= 20 || escrowUpdates.length >= 20) {
        await flushCustomBatches();
      }
    }

    listingFixCandidates.length = 0;
  }

  await reconcileListingCandidates();

  // 2) Orphan Escrow 스캔: HELD인데 Listing이 없거나 ACTIVE가 아니면 tombstone
  if (scanOrphanEscrow && (fixedListings + fixedEscrows) < batchSize) {
    const escrowKeysToCheck = []; // { escrowKey, escrowValue, escrowWriteLock, listingKeyHint }
    while (scannedEscrowPages < maxPages && (fixedListings + fixedEscrows) < batchSize) {
      scannedEscrowPages += 1;

      const res = await cloudSaveApi.getCustomItems(projectId, escrowCustomId, undefined, afterEscrow);
      const payload = res.data;

      const items = Array.isArray(payload?.results) ? payload.results : [];
      afterEscrow = payload?.links?.after || undefined;

      if (items.length === 0) break;

      for (const it of items) {
        if ((fixedListings + fixedEscrows) >= batchSize) break;

        scannedEscrows += 1;

        const escrowKey = it?.key;
        const escrowValue = it?.value;
        const escrowWriteLock = it?.writeLock;

        if (!escrowKey || !escrowValue || typeof escrowValue !== "object") {
          skipped += 1;
          warn(`[ReconcileListingState][WARN] Skip invalid escrow record. key=${String(escrowKey)}`);
          continue;
        }

        if (escrowValue.status !== "HELD") continue;

        // 연결 정보가 없으면 일단 tombstone (HELD 고아)
        const listingKeyHint = escrowValue.listingKey || null;
        if (!listingKeyHint) {
          enqueueEscrowTombstone(escrowKey, escrowValue, escrowWriteLock, "RECON_ORPHAN_ESCROW_NO_LISTINGKEY");
          warn(`[ReconcileListingState][WARN] Orphan HELD escrow without listingKey -> tombstone. escrowKey=${escrowKey}`);
          if (escrowUpdates.length >= 20) await flushCustomBatches();
          continue;
        }

        escrowKeysToCheck.push({ escrowKey, escrowValue, escrowWriteLock, listingKeyHint });

        if (escrowKeysToCheck.length >= 20) break;
      }

      if (escrowKeysToCheck.length >= 20) break;
      if (!afterEscrow) break;
    }

    // listingKeyHint들을 조회해서 존재/상태 확인
    if (escrowKeysToCheck.length > 0) {
      const listingKeys = escrowKeysToCheck.map((e) => e.listingKeyHint).slice(0, 20);
      const listingRes = await cloudSaveApi.getCustomItems(projectId, listingsCustomId, listingKeys);
      const listingItems = Array.isArray(listingRes.data?.results) ? listingRes.data.results : [];

      const listingMap = new Map(); // listingKey -> listingValue
      for (const li of listingItems) {
        if (li?.key) listingMap.set(li.key, li.value);
      }

      for (const e of escrowKeysToCheck) {
        if ((fixedListings + fixedEscrows) >= batchSize) break;

        const lv = listingMap.get(e.listingKeyHint);

        // Listing 없음 -> orphan escrow tombstone
        if (!lv || typeof lv !== "object") {
          enqueueEscrowTombstone(e.escrowKey, e.escrowValue, e.escrowWriteLock, "RECON_ORPHAN_ESCROW_LISTING_MISSING");
          warn(`[ReconcileListingState][WARN] Orphan escrow listing missing -> tombstone. escrowKey=${e.escrowKey} listingKey=${e.listingKeyHint}`);
          continue;
        }

        // Listing이 ACTIVE가 아니면 -> escrow tombstone
        if (lv.status !== "ACTIVE") {
          enqueueEscrowTombstone(e.escrowKey, e.escrowValue, e.escrowWriteLock, "RECON_ORPHAN_ESCROW_LISTING_NOT_ACTIVE");
          warn(`[ReconcileListingState][WARN] Orphan escrow listing not ACTIVE -> tombstone. escrowKey=${e.escrowKey} listingKey=${e.listingKeyHint} listingStatus=${lv.status}`);
        }

        if (escrowUpdates.length >= 20) await flushCustomBatches();
      }
    }
  }

  await flushCustomBatches();

  // AGGRESSIVE 모드에 대한 추가 동작은 여기서 확장(현재는 SAFE 중심)
  if (reconcileMode !== "SAFE" && reconcileMode !== "AGGRESSIVE") {
    warn(`[ReconcileListingState][WARN] Unknown reconcileMode=${reconcileMode}. Treated as SAFE behavior.`);
  }

  return {
    nowIso,
    listingsCustomId,
    escrowCustomId,
    reconcileMode,
    dryRun,
    scannedListingPages,
    scannedEscrowPages,
    scannedListings,
    scannedEscrows,
    fixedListings,
    fixedEscrows,
    skipped,
    warnings,
    nextAfterListing: afterListing || null,
    nextAfterEscrow: afterEscrow || null
  };
};