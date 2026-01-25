/**
 * ReleaseTxnLock
 * - AcquireTxnLock과 동일한 저장소/키 규칙 사용
 * - token 일치 시에만 해제 (force 제외)
 * - 경쟁 상황에서 "마지막 write 승자" 문제를 피하려면:
 *   (1) getCustomItems로 현재 락 + writeLock 확보
 *   (2) token 검증
 *   (3) setCustomItem로 "released tombstone"을 writeLock 포함해 덮어쓰기
 *       (delete API가 런타임/SDK 버전에 따라 없거나, delete가 read-your-writes 보장이 약해질 수 있음)
 *
 * 저장 위치:
 *  - customId: "txnlocks"
 *  - key: "LISTING_<listingId>" / "PLAYER_<playerId>" / "GLOBAL_<id>"
 *
 * params:
 *  - scope: "LISTING" | "PLAYER" | "GLOBAL" (필수)
 *  - id: string (필수)
 *  - token: string (필수)   // AcquireTxnLock에서 받은 토큰
 *  - force: boolean (선택)  // 운영/서버 내부 전용. 토큰 불일치여도 해제
 *
 * return:
 *  - released: boolean
 *  - reason: "OK" | "NOT_FOUND" | "EXPIRED" | "TOKEN_MISMATCH" | "BUSY" | "ERROR"
 *  - lockKey
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

const CUSTOM_ID = "txnlocks";

function _nowIso() {
  return new Date().toISOString();
}

function _asBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function _makeKey(scope, id) {
  const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, "_");
  return `${scope}_${safeId}`;
}

function _isExpired(lockValue, nowMs) {
  const exp = Number(lockValue?.expiresAtEpochMs ?? 0);
  return exp <= nowMs;
}

function _throwBusy(detail) {
  const err = new Error(detail || "LOCK_BUSY");
  err.status = 409;
  throw err;
}

module.exports = async ({ params, context, logger }) => {
  const scope = String(params?.scope ?? "").trim().toUpperCase();
  const id = String(params?.id ?? "").trim();
  const token = String(params?.token ?? "").trim();
  const force = _asBool(params?.force ?? false);

  if (!scope) throw new Error("ReleaseTxnLock: scope is required.");
  if (!id) throw new Error("ReleaseTxnLock: id is required.");
  if (!token && !force) throw new Error("ReleaseTxnLock: token is required (unless force=true).");

  const { projectId, playerId } = context;
  const cloudSave = new DataApi(context);

  const lockKey = _makeKey(scope, id);
  const nowMs = Date.now();

  // 1) 현재 락 조회 (+ writeLock 확보)
  let existingItem = null;
  try {
    const res = await cloudSave.getCustomItems(projectId, CUSTOM_ID, [lockKey]);
    existingItem = res?.data?.results?.[0] ?? null;
  } catch (e) {
    logger.warning("ReleaseTxnLock: getCustomItems failed.", {
      customId: CUSTOM_ID,
      lockKey,
      "error.message": e?.message ?? "unknown",
      "error.status": e?.response?.status ?? null
    });
    throw e;
  }

  const existingValue = existingItem?.value ?? null;
  const existingWriteLock = existingItem?.writeLock ?? null;

  // 2) 없으면 폴백 (NOT_FOUND). 무음 금지 → Warning
  if (!existingValue) {
    logger.warning("ReleaseTxnLock fallback: lock not found.", {
      customId: CUSTOM_ID,
      lockKey
    });
    return { released: false, reason: "NOT_FOUND", lockKey };
  }

  // 3) 이미 만료된 락이면 EXPIRED로 처리. (해제는 하되, 의미상 expired)
  const expired = _isExpired(existingValue, nowMs);

  // 4) 토큰 검증 (force 아니면 필수)
  const existingToken = String(existingValue?.token ?? "");
  const owner = String(existingValue?.ownerPlayerId ?? "");
  if (!force && existingToken !== token) {
    return {
      released: false,
      reason: "TOKEN_MISMATCH",
      lockKey,
      details: {
        ownerPlayerId: owner,
        expiresAtEpochMs: existingValue?.expiresAtEpochMs ?? null
      }
    };
  }

  if (force) {
    logger.warning("ReleaseTxnLock: FORCE release requested.", {
      customId: CUSTOM_ID,
      lockKey,
      requesterPlayerId: playerId,
      ownerPlayerId: owner
    });
  }

  // 5) 해제는 tombstone overwrite로 처리 (writeLock 포함)
  //    - delete가 가능하면 delete로 바꿔도 되지만, 여기서는 Acquire와 동일하게 writeLock 기반 충돌방지 유지.
  //    - 다른 요청이 동시에 갱신하면 409 → BUSY로 반환(재시도 유도)
  const releasedValue = {
    schema: 1,
    lockKey,
    token: existingToken, // 감사용으로 남겨도 되고, ""로 지워도 됨
    ownerPlayerId: owner,
    releasedAtIso: _nowIso(),
    releasedAtEpochMs: nowMs,
    expiresAtEpochMs: nowMs // 즉시 만료 처리
  };

  try {
    const body = { key: lockKey, value: releasedValue };
    if (existingWriteLock) body.writeLock = existingWriteLock;

    await cloudSave.setCustomItem(projectId, CUSTOM_ID, body);
  } catch (e) {
    logger.warning("ReleaseTxnLock: contention detected.", {
      customId: CUSTOM_ID,
      lockKey,
      "error.message": e?.message ?? "unknown",
      "error.status": e?.response?.status ?? null
    });
    if (e?.response?.status === 409) _throwBusy("ReleaseTxnLock: contention detected.");
    throw e;
  }

  // 6) 선택: 재조회 검증(정합성 강하게)
  try {
    const verifyRes = await cloudSave.getCustomItems(projectId, CUSTOM_ID, [lockKey]);
    const verifyItem = verifyRes?.data?.results?.[0] ?? null;
    const verifyExp = Number(verifyItem?.value?.expiresAtEpochMs ?? 0);

    if (verifyExp > nowMs) {
      logger.warning("ReleaseTxnLock fallback: release verify failed. Lock still valid.", {
        customId: CUSTOM_ID,
        lockKey,
        verifyExpiresAtEpochMs: verifyExp
      });
      _throwBusy("ReleaseTxnLock: verify failed.");
    }
  } catch (e) {
    logger.warning("ReleaseTxnLock: verify failed. Treat as busy.", {
      customId: CUSTOM_ID,
      lockKey,
      "error.message": e?.message ?? "unknown",
      "error.status": e?.response?.status ?? null
    });
    _throwBusy("ReleaseTxnLock: verify failed.");
  }

  return {
    released: true,
    reason: expired ? "EXPIRED" : "OK",
    customId: CUSTOM_ID,
    lockKey
  };
};

module.exports.params = {
  scope: { type: "String", required: true },
  id: { type: "String", required: true },
  token: { type: "String", required: false },
  force: { type: "Boolean", required: false }
};