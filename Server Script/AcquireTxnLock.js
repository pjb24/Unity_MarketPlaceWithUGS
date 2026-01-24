/**
 * AcquireTxnLock
 * - Cloud Save Custom Item을 이용한 분산 락
 * - crypto 모듈 미사용 (Cloud Code 런타임 호환)
 * - 경쟁 상황에서 "마지막 write 승자" 문제를 막기 위해
 *   write 후 재조회해서 token이 내 것인지 검증한다.
 *
 * 저장 위치:
 *  - customId: "txnlocks"
 *  - key: "LISTING_<listingId>" / "PLAYER_<playerId>" / "GLOBAL_<id>"
 *
 * 주의:
 *  - customId는 [A-Za-z0-9_-]만 허용. ':' 금지.
 *  - 메서드: getPrivateCustomItems / setPrivateCustomItem 사용.
 *
 * params:
 *  - scope: "LISTING" | "PLAYER" | "GLOBAL" (필수)
 *  - id: string (필수)  // listingId 또는 playerId 등
 *  - ttlSeconds: number (선택) 기본 10
 *
 * return:
 *  - lockKey, token, acquiredAt, expiresAt
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

const CUSTOM_ID = "txnlocks";
const DEFAULT_TTL_SECONDS = 10;

function _nowIso() {
  return new Date().toISOString();
}

function _genToken() {
  // 충돌 확률 충분히 낮은 토큰
  // txnlock-<epoch>-<rand>
  return `txnlock-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function _asInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
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

function _makeKey(scope, id) {
  // key는 콜론 대신 언더스코어 사용 (Cloud Save key는 문서상 더 관대하지만, 안전하게 제한)
  // listingId에 특수문자 들어오면 망가진다 → 최소 치환
  const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, "_");
  return `${scope}_${safeId}`;
}

module.exports = async ({ params, context, logger }) => {
  const scope = String(params?.scope ?? "").trim().toUpperCase();
  const id = String(params?.id ?? "").trim();
  const ttlSeconds = Math.max(1, _asInt(params?.ttlSeconds, DEFAULT_TTL_SECONDS));

  if (!scope) throw new Error("AcquireTxnLock: scope is required.");
  if (!id) throw new Error("AcquireTxnLock: id is required.");

  const { projectId, playerId } = context;

  const cloudSave = new DataApi(context);

  // 락 키 규칙: 짧고 충돌 없게 고정
  // LISTING:txnlock:LISTING:L123
  const lockKey = _makeKey(scope, id);

  const nowMs = Date.now();
  const token = _genToken();

  const newLock = {
    schema: 1,
    lockKey,
    token,
    ownerPlayerId: playerId,
    acquiredAtIso: _nowIso(),
    acquiredAtEpochMs: nowMs,
    expiresAtEpochMs: nowMs + ttlSeconds * 1000
  };

  // 1) 기존 락 조회
  let existingItem = null;

  try {
    const res = await cloudSave.getCustomItems(projectId, CUSTOM_ID, [lockKey]);
    existingItem = res?.data?.results?.[0] ?? null;
  } catch (e) {
    // 조회 자체 실패는 서버 문제. 그대로 throw.
    logger.warning("AcquireTxnLock: getCustomItems failed.", {
      customId: CUSTOM_ID,
      lockKey,
      "error.message": e?.message ?? "unknown",
      "error.status": e?.response?.status ?? null
    });
    throw e;
  }

  const existingValue = existingItem?.value ?? null;
  const existingWriteLock = existingItem?.writeLock ?? null;

  // 2) 유효한 락이 있으면 실패
  if (existingValue && !_isExpired(existingValue, nowMs)) {
    _throwBusy("AcquireTxnLock: lock is already held.");
  }

  // 3) 락 쓰기 (만료된 락이 있으면 writeLock으로 갱신 시도)
  try {
    const body = { key: lockKey, value: newLock };

    // SetItemBody에 writeLock을 넣으면 충돌 방지 가능
    if (existingWriteLock) body.writeLock = existingWriteLock;

    await cloudSave.setCustomItem(projectId, CUSTOM_ID, body);
  } catch (e) {
    // 동시 갱신 충돌(409 등) → busy 처리
    logger.warning("AcquireTxnLock: contention detected. Fallback to busy.", {
      customId: CUSTOM_ID,
      lockKey,
      "error.message": e?.message ?? "unknown",
      "error.status": e?.response?.status ?? null
    });
    if (e?.response?.status === 409) _throwBusy("AcquireTxnLock: contention detected.");
    throw e; // 400/401/500은 숨기지 말 것
  }

  // 4) 재조회해서 "내 토큰이 맞는지" 확인 (마지막 write 승자 문제 제거)
  try {
    const verifyRes = await cloudSave.getCustomItems(projectId, CUSTOM_ID, [lockKey]);
    const verifyItem = verifyRes?.data?.results?.[0] ?? null;
    const verifyToken = verifyItem?.value?.token ?? null;

    if (verifyToken !== token) {
      logger.warning("AcquireTxnLock: token mismatch after write. Lock lost.", {
        customId: CUSTOM_ID,
        lockKey,
        expectedToken: token,
        actualToken: verifyToken
      });
      _throwBusy("AcquireTxnLock: lost race after write.");
    }

    return {
      customId: CUSTOM_ID,
      lockKey,
      token,
      acquiredAtIso: newLock.acquiredAtIso,
      expiresAtEpochMs: newLock.expiresAtEpochMs,
      ttlSeconds
    };
  } catch (e) {
    logger.warning("AcquireTxnLock: verify failed. Treat as busy.", {
      CUSTOM_ID,
      lockKey,
      "error.message": e?.message ?? "unknown",
      "error.status": e?.response?.status ?? null
    });
    _throwBusy("AcquireTxnLock: verify failed.");
  }
};

module.exports.params = {
  scope: { type: "String", required: true },
  id: { type: "String", required: true },
  ttlSeconds: { type: "Number", required: false }
};