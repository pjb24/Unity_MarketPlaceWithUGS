using System;
using System.Collections.Generic;

[Serializable]
public sealed class AcquireTxnLockResult
{
    public string customId;
    public string lockKey;
    public string token;
    public string acquiredAtIso;
    public long expiresAtEpochMs;
    public int ttlSeconds;
}

[Serializable]
public sealed class ReleaseTxnLockResult
{
    public bool released;
    public string reason;   // OK | NOT_FOUND | EXPIRED | TOKEN_MISMATCH | BUSY | ERROR
    public string customId;
    public string lockKey;

    // TOKEN_MISMATCH일 때 details가 올 수 있음(서버가 더 줘도 무시됨)
    public object details;
}

[Serializable]
public sealed class ValidateItemTradableResult
{
    public bool ok;
    public bool tradable;
    public string storageUsed;
    public string keyUsed;
    public string failCode; // OK, NOT_FOUND, LOCKED 등
    public string msg;
    public object details;
}

// CreateListing 응답 DTO
// - ok=false: errorCode/errorMessage만 유효
// - ok=true : listingId/listingKey/listing/indexKeys/dryRun 유효
[Serializable]
public sealed class CreateListingResult
{
    public bool ok;

    // error
    public string errorCode;
    public string errorMessage;

    // success
    public string listingId;
    public string listingKey;
    public MarketListingDto listing;
    public List<string> indexKeys;
    public bool dryRun;
}

[Serializable]
public sealed class MarketListingDto
{
    public string listingId;
    public string status; // "ACTIVE" 등
    public string sellerPlayerId;

    public string itemInstanceId; // prefix 없음
    public double price;
    public string currencyId;

    public string createdAt; // ISO
    public string createdAtKey; // UTC 정렬 키 (yyyyMMddHHmmssSSS)
    public string updatedAt; // ISO

    public string expiresAt;     // ISO
    public string expiresAtKey;  // UTC 정렬 키 (yyyyMMddHHmmssSSS)
}

[Serializable]
public sealed class WriteLedgerEntryResult
{
    public bool written;
    public bool deduped;
    public string entryKey;
    public List<string> indexKeys;
}
