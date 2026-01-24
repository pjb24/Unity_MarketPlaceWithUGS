/**
 * WriteLedgerEntry
 * - Cloud Save Custom Item에 append-only 원장 기록 + 인덱스 아이템 동시 생성
 * - txnId + entryId(또는 nonce)로 멱등 보장 (중복 기록 방지)
 *
 * CustomIds:
 *  - "ledger_entries" : 실제 원장 엔트리 저장
 *  - "ledger_index"   : 조회용 인덱스(계정/재화/시간, txnId)
 *
 * params:
 *  - txnId: string (필수)          // 거래 트랜잭션 ID
 *  - entryId: string (선택)        // 같은 txnId 내 여러 원장 엔트리 구분. 없으면 자동 생성(하지만 멱등성 약해짐)
 *  - accountId: string (필수)      // 소유자(플레이어/시스템 계정)
 *  - currencyId: string (필수)     // "MT" 등
 *  - delta: number (필수)          // 증감(+/-). 정수/소수 가능(룰은 상위에서 확정)
 *  - reason: string (필수)         // "TRADE_BUY", "TRADE_SELL", "FEE_POOL", "BURN" 등
 *  - refType: string (선택)        // "LISTING"|"TRADE"|...
 *  - refId: string (선택)          // listingId/tradeId 등
 *  - meta: object (선택)           // 감사/디버깅용
 *
 * return:
 *  - written: boolean
 *  - deduped: boolean
 *  - entryKey
 *  - indexKeys: string[]
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

const LEDGER_CUSTOM_ID = "ledger_entries";
const INDEX_CUSTOM_ID = "ledger_index";

function _nowIso() { return new Date().toISOString(); }

function _safeKeyPart(v) {
  return String(v ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
}

function _asNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function _requiredStr(name, v) {
  const s = String(v ?? "").trim();
  if (!s) throw new Error(`WriteLedgerEntry: ${name} is required.`);
  return s;
}

function _optionalStr(v) {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function _genEntryId() {
  // 멱등성을 강하게 하려면 호출자가 entryId를 넣어야 한다.
  // 없을 때만 임시 생성(재시도 시 중복 가능성 있음)
  return `le-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function _bucketMinute(epochMs) {
  // 인덱스 키 길이/분산을 위해 분 단위 버킷
  return Math.floor(epochMs / 60000);
}

module.exports = async ({ params, context, logger }) => {
  const txnId = _requiredStr("txnId", params?.txnId);
  const accountId = _requiredStr("accountId", params?.accountId);
  const currencyId = _requiredStr("currencyId", params?.currencyId);
  const reason = _requiredStr("reason", params?.reason);

  const delta = _asNumber(params?.delta);
  if (delta == null) throw new Error("WriteLedgerEntry: delta must be a finite number.");
  if (delta === 0) {
    logger.warning("WriteLedgerEntry fallback: delta is 0. Writing ledger entry anyway.", {
      txnId,
      accountId,
      currencyId,
      reason
    });
  }

  const entryId = _optionalStr(params?.entryId) ?? _genEntryId();
  const refType = _optionalStr(params?.refType);
  const refId = _optionalStr(params?.refId);
  const meta = (params?.meta && typeof params.meta === "object") ? params.meta : null;

  const { projectId, playerId } = context;
  const cloudSave = new DataApi(context);

  const nowMs = Date.now();
  const nowIso = _nowIso();

  // 1) 멱등 키: txnId + entryId
  // - 같은 txnId 재시도에도 entryId가 동일하면 중복 기록 안 함.
  const dedupeKey = `DEDUP_${_safeKeyPart(txnId)}_${_safeKeyPart(entryId)}`;

  // 2) 원장 엔트리 키(append-only)
  // - 시간/계정/재화로 조회 가능하게 키에 넣고,
  // - 충돌 방지를 위해 txnId/entryId도 포함.
  const entryKey =
    `E_${_safeKeyPart(accountId)}_${_safeKeyPart(currencyId)}_${nowMs}_${_safeKeyPart(txnId)}_${_safeKeyPart(entryId)}`;

  // 3) 인덱스 키들
  const minuteBucket = _bucketMinute(nowMs);

  // 계정+재화+시간(버킷) 기준 목록
  const idxAcctCurTime =
    `I_ACCTCUR_TIME_${_safeKeyPart(accountId)}_${_safeKeyPart(currencyId)}_${minuteBucket}_${nowMs}_${_safeKeyPart(txnId)}_${_safeKeyPart(entryId)}`;

  // txnId 기준으로 빠르게 역추적
  const idxTxn =
    `I_TXN_${_safeKeyPart(txnId)}_${_safeKeyPart(accountId)}_${_safeKeyPart(currencyId)}_${nowMs}_${_safeKeyPart(entryId)}`;

  const ledgerValue = {
    schema: 1,
    entryKey,
    txnId,
    entryId,
    accountId,
    currencyId,
    delta,
    reason,
    refType,
    refId,
    meta,
    createdAtIso: nowIso,
    createdAtEpochMs: nowMs,
    writerPlayerId: playerId
  };

  // 멱등 플래그(짧게 저장)
  const dedupeValue = {
    schema: 1,
    txnId,
    entryId,
    entryKey,
    createdAtIso: nowIso,
    createdAtEpochMs: nowMs
  };

  // A) 멱등 체크(이미 있으면 deduped 반환)
  try {
    const dedupeRes = await cloudSave.getCustomItems(projectId, INDEX_CUSTOM_ID, [dedupeKey]);
    const existed = (dedupeRes?.data?.results?.[0]?.value ?? null) != null;
    if (existed) {
      return {
        written: false,
        deduped: true,
        entryKey: dedupeRes.data.results[0].value.entryKey ?? null,
        indexKeys: []
      };
    }
  } catch (e) {
    logger.warning("WriteLedgerEntry: dedupe read failed.", {
      customId: INDEX_CUSTOM_ID,
      dedupeKey,
      "error.message": e?.message ?? "unknown",
      "error.status": e?.response?.status ?? null
    });
    // dedupe read 실패는 서버 문제일 수 있으니 그대로 throw (중복 기록 위험)
    throw e;
  }

  // B) 원장/인덱스 기록
  // 순서:
  //  1) dedupeKey 먼저 set (writeLock 없이도 충돌 가능 -> 409면 누군가가 먼저 쓴 것 -> deduped로 처리)
  //  2) ledger entry set
  //  3) index 2개 set
  try {
    // 1) dedupe set
    try {
      await cloudSave.setCustomItem(projectId, INDEX_CUSTOM_ID, { key: dedupeKey, value: dedupeValue });
    } catch (e) {
      // 경쟁 상황(거의 동시에 같은 txnId+entryId가 들어온 경우)
      if (e?.response?.status === 409) {
        logger.warning("WriteLedgerEntry fallback: dedupe contention. Treat as deduped.", {
          customId: INDEX_CUSTOM_ID,
          dedupeKey
        });
        return { written: false, deduped: true, entryKey: null, indexKeys: [] };
      }
      throw e;
    }

    // 2) ledger entry set (append-only)
    await cloudSave.setCustomItem(projectId, LEDGER_CUSTOM_ID, { key: entryKey, value: ledgerValue });

    // 3) indexes set
    await cloudSave.setCustomItem(projectId, INDEX_CUSTOM_ID, {
      key: idxAcctCurTime,
      value: { schema: 1, type: "ACCTCUR_TIME", entryKey, accountId, currencyId, createdAtEpochMs: nowMs }
    });

    await cloudSave.setCustomItem(projectId, INDEX_CUSTOM_ID, {
      key: idxTxn,
      value: { schema: 1, type: "TXN", entryKey, txnId, accountId, currencyId, createdAtEpochMs: nowMs }
    });

    return {
      written: true,
      deduped: false,
      entryKey,
      indexKeys: [dedupeKey, idxAcctCurTime, idxTxn]
    };
  } catch (e) {
    // 이 지점에서 partial write가 발생할 수 있다(예: dedupe는 써졌는데 entry 쓰기 실패).
    // 무음 금지: 경고 로그로 명확히 남겨라.
    logger.warning("WriteLedgerEntry fallback: partial write risk.", {
      txnId,
      entryId,
      accountId,
      currencyId,
      reason,
      entryKey,
      "error.message": e?.message ?? "unknown",
      "error.status": e?.response?.status ?? null
    });
    throw e;
  }
};

module.exports.params = {
  txnId: { type: "String", required: true },
  entryId: { type: "String", required: false },
  accountId: { type: "String", required: true },
  currencyId: { type: "String", required: true },
  delta: { type: "Number", required: true },
  reason: { type: "String", required: true },
  refType: { type: "String", required: false },
  refId: { type: "String", required: false },
  meta: { type: "Object", required: false }
};