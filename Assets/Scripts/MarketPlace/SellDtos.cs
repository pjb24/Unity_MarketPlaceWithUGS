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
    public string reasonCode;   // OK, NOT_FOUND, LOCKED 등
    public object details;
}

[Serializable]
public sealed class CreateListingResult
{
    public string listingId;
    public string listingKey;
    public string escrowKey;
    public string createdAt;
    public string expiresAt;
    public double price;
}

[Serializable]
public sealed class WriteLedgerEntryResult
{
    public bool written;
    public bool deduped;
    public string entryKey;
    public List<string> indexKeys;
}
