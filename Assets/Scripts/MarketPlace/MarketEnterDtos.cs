// ===== DTOs (JS return 키/구조에 정확히 맞춤) =====

using System;
using System.Collections.Generic;

[Serializable]
public sealed class MarketEnterResult
{
    public GetServerTimeResult ServerTime;
    public GetConfigResult Config;

    public GetWalletResult Wallet;
    public GetInventorySnapshotResult InventorySnapshot;
    public QueryListingsResult MarketListings;
    public GetMyListingsResult MyListings;
    public GetTradeHistoryResult TradeHistory;

    public bool HasPartialFailures;
    public List<string> PartialFailures;
}

// GetServerTime.js -> { serverTime: { iso, epochMillis, epochSeconds } }
[Serializable]
public sealed class GetServerTimeResult
{
    public ServerTimeDto serverTime;
}

[Serializable]
public sealed class ServerTimeDto
{
    public string iso;
    public long epochMillis;
    public long epochSeconds;
}

// GetConfig.js -> { config: { market, currency, locks }, meta: { source, usedFallbackKeys, environmentId } }
[Serializable]
public sealed class GetConfigResult
{
    public ConfigDto config;
    public ConfigMetaDto meta;
}

[Serializable]
public sealed class ConfigDto
{
    public MarketConfigDto market;
    public CurrencyConfigDto currency;
    public LocksConfigDto locks;
}

[Serializable]
public sealed class MarketConfigDto
{
    public double feeRateTotal;
    public double feeRatePool;
    public double feeRateBurn;

    public int listingExpireDays;

    public double priceMin;
    public double priceMax;
    public double priceBucketStep;
}

[Serializable]
public sealed class CurrencyConfigDto
{
    public string mtCurrencyId;
    public string ecCurrencyId;
    public int mtDecimals;
    public int ecDecimals;
}

[Serializable]
public sealed class LocksConfigDto
{
    public int listingLockTtlSeconds;
    public int playerLockTtlSeconds;
}

[Serializable]
public sealed class ConfigMetaDto
{
    public string source; // "REMOTE_CONFIG" | "DEFAULTS"
    public List<string> usedFallbackKeys;
    public string environmentId;
}

// GetWallet.js -> { playerId, currencies: { [currencyId]: { balance, writeLock } }, fetchedAt }
[Serializable]
public sealed class GetWalletResult
{
    public string playerId;
    public Dictionary<string, CurrencyBalanceDto> currencies;
    public string fetchedAt;
}

[Serializable]
public sealed class CurrencyBalanceDto
{
    public double balance;
    public string writeLock; // null 가능
}

// GetInventorySnapshot.js -> 많은 필드 그대로
[Serializable]
public sealed class GetInventorySnapshotResult
{
    public string customId;
    public List<string> keys;

    public string nowIso;
    public long nowEpochMs;

    public SnapshotDto snapshot;
    public SnapshotViewDto view;

    public CountsDto counts;

    public uint snapshotHash32;
    public string snapshotHashHex;
}

[Serializable]
public sealed class SnapshotDto
{
    // 원본(raw). 서버가 array/dict 어느 형태로 저장했는지 알 수 있으니 object로 둔다.
    public object frags;
    public object eqs;

    // includeWallet=true일 때만 { balances: [...] } 형태.
    public WalletSnapshotDto wallet;
}

[Serializable]
public sealed class WalletSnapshotDto
{
    public List<WalletBalanceRowDto> balances;
}

[Serializable]
public sealed class WalletBalanceRowDto
{
    public string currencyId;
    public double balance;
    public string writeLock;
}

[Serializable]
public sealed class SnapshotViewDto
{
    public List<MarketViewItemDto> frags;
    public List<MarketViewItemDto> eqs;
}

[Serializable]
public sealed class MarketViewItemDto
{
    public string id;
    public string kind;
    public string slot;
    public string rarity;

    public bool? tradable;
    public TradeLockDto tradeLock;

    public string location;
}

[Serializable]
public sealed class TradeLockDto
{
    public bool? isLocked;
    public string reason;
    public string until;
}

[Serializable]
public sealed class CountsDto
{
    public int frags;
    public int eqs;
    public int total;
}

// QueryListings.js -> { items, nextPageToken, skipped }
[Serializable]
public sealed class QueryListingsResult
{
    public List<ListingDto> items;
    public string nextPageToken;
    public int skipped;
}

// GetMyListings.js -> { sellerPlayerId, status, items, nextPageToken, skipped }
[Serializable]
public sealed class GetMyListingsResult
{
    public string sellerPlayerId;
    public string status;
    public List<ListingDto> items;
    public string nextPageToken;
    public int skipped;
}

// GetTradeHistory.js -> { playerId, role, items, nextPageToken, skipped }
[Serializable]
public sealed class GetTradeHistoryResult
{
    public string playerId;
    public string role; // BUYER|SELLER|BOTH
    public List<TradeDto> items;
    public string nextPageToken; // "B:<token>" / "S:<token>" / "S:" 등
    public int skipped;
}

// listing.value 구조(최소 필드만 선언; 서버가 더 줘도 무시됨)
[Serializable]
public sealed class ListingDto
{
    public string listingId;
    public string sellerPlayerId;
    public string itemInstanceId;

    public double price;
    public string status;

    public string createdAt;
    public string expiresAt;
}

// trade.value 구조(최소 필드만 선언; 서버가 더 줘도 무시됨)
[Serializable]
public sealed class TradeDto
{
    public string tradeId;

    public string listingId;
    public string buyerPlayerId;
    public string sellerPlayerId;

    public double price;
    public double feeTotal;

    public string completedAt;
    public string status;
}
