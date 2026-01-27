// ===== DTOs (JS return 키/구조에 정확히 맞춤) =====

using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using static ItemTemplateDto;

[Serializable]
public sealed class MarketEnterResult
{
    public GetServerTimeResult ServerTime;
    public GetConfigResult Config;

    public GetWalletResult Wallet;
    public GetInventorySnapshotResponseDto InventorySnapshot;
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
// GetInventorySnapshot 응답 DTO (Cloud Code return 매칭)
// - ok=false 인 경우: errorCode/errorMessage만 유효
// - ok=true 인 경우: scope/indexKeyUsed/instanceKeys/view/counts/hash 등이 유효
[Serializable]
public sealed class GetInventorySnapshotResponseDto
{
    public bool ok;


    // error
    public string errorCode;
    public string errorMessage;


    // meta
    public string scope; // "PROTECTED_PLAYER_DATA"
    public string indexKeyUsed; // "IDX_ALL" or "IDX_<groupKey>"
    public string groupKeyUsed; // null or "FRAG_WPN_T1" ...


    public string nowIso;
    public long nowEpochMs;


    public List<string> instanceKeys;


    // snapshot (includeRaw=true 일 때만 내려올 수 있음)
    public InventorySnapshotSnapshotDto snapshot;


    // view (항상 내려오는 것으로 설계)
    public InventorySnapshotViewDto view;


    public InventorySnapshotCountsDto counts;


    public uint snapshotHash32;
    public string snapshotHashHex;
}


[Serializable]
public sealed class InventorySnapshotSnapshotDto
{
    // JS에서 instances가 "원본 인스턴스 객체 배열"이라 스키마가 유동적임.
    // 강타입으로 묶으면 깨질 확률이 높아서 object로 둔다.
    // Cloud Save value 원문 (FRAG/EQ 섞임)
    public List<JToken> instances;
}

[Serializable]
public class InventoryInstanceBaseDto
{
    // ===== common identifiers =====
    public string groupKey; // "FRAG_WPN_T1", "EQ_WPN_T1" ...

    // instance ids (instance JSON)
    public string instanceId;   // instanceId
    public string instanceKey;

    public string kind; // "FRAG" | "EQ"
    public string templateKey; // instance JSON에서만 존재, "FRAG_WPN_T1_001" ...

    // ===== common item header =====
    public int schema;
    public string slot; // "WPN" | "ARM" | "ACC"
    public int tier;
    public string rarity;

    public int quantity; // instance JSON에서만 존재(없으면 0), stackable 대응

    // ===== common meta / lifecycle =====
    public InstanceLifecycleDto lifecycle; // instance JSON 루트에 존재 가능

    public string note; // instance JSON 루트에 존재 가능
}

[Serializable]
public sealed class InstanceLifecycleDto
{
    public string createdAt;
    public string createdBy;
    public string updatedAt;
}

[Serializable]
public sealed class FragPayloadDto
{
    public FragFlagsDto flags;

    public string kind; // "FRAG"

    public InstanceLifecycleDto lifecycle;
    public LocationDto location;
    public MarketDto market;
    public ProofDto proof;

    public string rarity;
    public int schema;

    public string skillId;
    public string slot;

    // ★ 가변 스탯
    public FragStatsDynamicDto stats;

    public int tier;
}

/// <summary>
/// stats: {
///   base: { ... 가변 ... },
///   potentialCaps: { ... 가변 ... },
///   ... (추가 블록 가능)
/// }
/// </summary>
[Serializable]
public sealed class FragStatsDynamicDto
{
    // JSON key가 "base"라 @base로 받음
    public Dictionary<string, double> @base;
    public Dictionary<string, double> potentialCaps;

    // 서버가 stats에 새 블록을 추가하면 여기로 흡수
    [JsonExtensionData]
    public IDictionary<string, object> _extra;
}

[Serializable]
public sealed class FragFlagsDto
{
    public bool marketExpiredBonusEligible;
}

[Serializable]
public sealed class FragInstanceDto : InventoryInstanceBaseDto
{
    public FragPayloadDto payload;
}

[Serializable]
public sealed class EqInstanceDto : InventoryInstanceBaseDto
{
    public EqPayloadDto payload;
}

[Serializable]
public sealed class EqPayloadDto
{
    public EqAwakenDto awaken;
    public EqCraftDto craft;
    public EqEnhanceDto enhance;

    // eqStats가 있든 없든, stats가 핵심(가변)
    public object eqStats;

    public EqExpiredDto expired;
    public EqFlagsDto flags;

    public string kind; // "EQ"

    public InstanceLifecycleDto lifecycle;
    public LocationDto location;
    public MarketDto market;

    public NftDto nft;
    public ProofDto proof;

    public string rarity;
    public RecordDto record;

    public int schema;

    public SeasonDto season;
    public SeasonEffectDto seasonEffect;

    public SkillPickDto skill;

    public string skillId; // null 가능

    public string slot;
    public string state;

    // ★ 가변 스탯: base/now/... 슬롯만 고정, 내부 키는 전부 가변
    public EqStatsDynamicDto stats;

    public int tier;
}

/// <summary>
/// stats: { base: {...}, now: {...}, awakenedFinal: {...}, potentialCaps: {...}, ... }
/// - 레벨1의 슬롯 이름은 고정일 수 있으나, 내부 스탯 키는 계속 늘어남.
/// - 서버가 레벨1에 새로운 슬롯을 추가할 수도 있으므로 ExtensionData로 흡수.
/// </summary>
[Serializable]
public sealed class EqStatsDynamicDto
{
    // JSON key가 "base"라 @base로 받음
    public Dictionary<string, double> @base;
    public Dictionary<string, double> now;
    public Dictionary<string, double> awakenedFinal;
    public Dictionary<string, double> potentialCaps;

    // 레벨1에 새로운 슬롯이 추가되면 여기로 흡수
    [JsonExtensionData]
    public IDictionary<string, object> _extra;
}

[Serializable]
public sealed class EqAwakenDto
{
    public string effectHash;
    public string effectId;
    public bool lockedAfterAwaken;
}

[Serializable]
public sealed class EqCraftSlotsDto
{
    public string core;
    public List<string> free;
}

[Serializable]
public sealed class EqCraftDto
{
    public string craftedAt;
    public EqCraftSlotsDto slots;
    public List<string> sourceFragmentInstanceIds;
}

[Serializable]
public sealed class EqEnhanceDto
{
    public int level;
    public int maxLevelBeforeAwaken;
}

[Serializable]
public sealed class EqExpiredDto
{
    public bool appliesOnlyWhenStateIsExpired;
    public string extraEffectHash;
    public string extraEffectId;
    public string mode;
}

[Serializable]
public sealed class EqFlagsDto
{
    public bool marketExpiredBonusEligible;
}

[Serializable]
public sealed class SeasonDto
{
    public string awakenedSeason;
    public string craftedSeason;
    public int expireAfterSeasons;
    public string expiredAtSeason;
    public string recordEligibleState;
    public string recordEligibleUntilSeason;
}

[Serializable]
public sealed class SeasonEffectDto
{
    public bool applied;
    public string appliedSeason;
    public string hash;

    // modifiers: {} 때문에 확장형으로
    public Dictionary<string, JToken> modifiers;

    public string ruleSetId;
}

[Serializable]
public sealed class SkillPickDto
{
    public List<string> candidates;
    public string chosen;
    public string chosenFromFragmentInstanceId;
    public bool locked;
    public string selectedAt;
    public string status;
}

[Serializable]
public sealed class LocationDto
{
    public string note;
    public string zone;
}

[Serializable]
public sealed class TradeLockDto
{
    public bool isLocked;
    public string reason;
    public string until;
}

[Serializable]
public sealed class MarketDto
{
    public bool tradable;
    public TradeLockDto tradeLock;
}

[Serializable]
public sealed class NftDto
{
    public bool eligible;
    public string tokenId;
}

[Serializable]
public sealed class ProofDto
{
    public string buildHash;
    public string snapshotHash;
}

[Serializable]
public sealed class RecordDto
{
    public bool eligible;
    public string eligibleReason;
}

[Serializable]
public sealed class InventorySnapshotViewDto
{
    public List<InventorySnapshotViewInstanceDto> instances;
}

[Serializable]
public sealed class InventorySnapshotViewInstanceDto
{
    public string id;


    public string kind; // "FRAG" | "EQ"
    public string slot; // "WPN" | "ARM" | "ACC"
    public int tier;
    public string rarity; // "COMMON" | "RARE" | "EPIC" | "LEGENDARY"


    public string groupKey;
    public string templateKey;


    public int quantity;


    // 거래소 상태 필드(인벤 설계에 따라 null 가능)
    public bool? tradable;
    public InventoryTradeLockDto tradeLock;
    public string location; // "BAG" | "MARKET_ESCROW" | ...
}

[Serializable]
public sealed class InventoryTradeLockDto
{
    public bool isLocked;
    public string reason;
    public string until; // ISO string or null
}


[Serializable]
public sealed class InventorySnapshotCountsDto
{
    public int indexed;
    public int selected;
    public int loaded;
    public int missing;
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
    public bool ok;

    // error (ok=false)
    public string errorCode;
    public string errorMessage;

    // meta (ok=true)
    public string playerId;
    public string role;                 // "BUY" | "SELL" | "ALL"
    public string nextPageToken;         // 더 없으면 null
    public int skipped;                 // 서버에서 제외된 항목 수

    // data
    public List<TradeRecordDto> items;
}

// TradeRecordDto.cs
// market_trades Custom Item value 구조 (필수 필드만 선언)
// 서버가 더 많은 필드를 내려줘도 JsonUtility에서 무시된다.
[Serializable]
public sealed class TradeRecordDto
{
    // 핵심 필드(스크립트에서 직접 참조/가공)
    public string templateKey; // trade.templateKey 우선, 없으면 escrowItem.templateKey로 보강, 둘 다 없으면 null

    // identifiers
    public string tradeId;
    public string listingId;

    // players
    public string sellerPlayerId;
    public string buyerPlayerId;

    // item
    // itemInstanceId == escrow key (prefix 없음)
    public string itemInstanceId;

    // price / currency
    public string currencyId;
    public int price;

    // settlement amounts
    public int sellerCredit;   // 판매자 수령액
    public int poolCredit;     // 시즌/풀 적립
    public int burnAmount;     // 소각량

    // fee
    public float feeRateTotal; // 전체 수수료 비율 (ex 0.1)
    public float feeRatePool;  // 풀 적립 비율 (ex 0.06)

    // time
    public string createdAt;      // ISO8601
    public string createdAtKey;   // 정렬용 key (yyyyMMddHHmmssSSS)

    // settlement meta
    public TradeSettlementDto settlement;
}

[Serializable]
public sealed class TradeSettlementDto
{
    // proceeds 저장 위치
    public string proceedsCustomId; // "market_proceeds"
    public string proceedsKey;      // "PROCEEDS_<sellerPlayerId>_<currencyId>"
}

// listing.value 구조(최소 필드만 선언; 서버가 더 줘도 무시됨)
[Serializable]
public sealed class ListingDto
{
    public string listingId;
    public string sellerPlayerId;
    public string itemInstanceId;

    public string currencyId;

    public double price;
    public string status;

    public string createdAt;
    public string createdAtKey;
    public string updatedAt;
    public string expiresAt;
    public string expiresAtKey;

    // 추가: 서버가 listing.value에 아이템 원본을 같이 넣어주는 경우 수신
    public InventoryItemInstanceDto escrowItem;
}

// Protected Items / Escrow(Custom Items)에서 보관되는 "아이템 인스턴스" 최소 스키마
// 제공된 Value(JSON)를 그대로 받도록 구조를 맞춤
[Serializable]
public sealed class InventoryItemInstanceDto
{
    public int schema;

    public string groupKey;
    public string instanceId;
    public string instanceKey;
    public string kind;      // "EQ" | "FRAG"
    public string slot;      // "WPN" | "ARM" | "ACC"
    public int tier;
    public string seq3;      // "001" 등
    public string rarity;    // "COMMON" 등
    public int quantity;

    public string templateKey;
    public string note;

    public InventoryLifecycleDto lifecycle;

    // payload는 매우 크고 가변적이므로 강타입으로 묶지 않는다.
    public InventoryPayloadDto payload;
}

[Serializable]
public sealed class InventoryLifecycleDto
{
    public string createdAt;
    public string createdBy;
    public string updatedAt;
}

// payload는 제공된 JSON 구조를 그대로 받을 수 있게 세분화
[Serializable]
public sealed class InventoryPayloadDto
{
    public int schema;

    public string kind;   // "EQ"
    public string slot;   // "WPN"
    public int tier;

    public string rarity; // "COMMON"
    public string skillId;

    public InventoryPayloadLifecycleDto lifecycle;
    public InventoryLocationDto location;
    public InventoryMarketDto market;

    public InventoryAwakenDto awaken;
    public InventoryCraftDto craft;
    public InventoryEnhanceDto enhance;

    public InventoryEqStatsDto eqStats;

    public InventoryExpiredRuleDto expired;
    public InventoryFlagsDto flags;
    public InventoryNftDto nft;
    public InventoryProofDto proof;
    public InventoryRecordDto record;
    public InventorySeasonDto season;
    public InventorySeasonEffectDto seasonEffect;
    public InventorySkillDto skill;

    public string state; // "NORMAL" 등

    // payload.stats는 null이거나 구조가 달라질 수 있어 object로 둔다.
    public object stats;
}

[Serializable]
public sealed class InventoryPayloadLifecycleDto
{
    public string createdAt;
    public string createdBy;
    public string updatedAt;
}

[Serializable]
public sealed class InventoryLocationDto
{
    public string zone;   // "BAG"
    public string note;   // null 가능
}

[Serializable]
public sealed class InventoryMarketDto
{
    public bool tradable;
    public InventoryTradeLockDto tradeLock;
}

[Serializable]
public sealed class InventoryAwakenDto
{
    public string effectId;
    public string effectHash; // null 가능
    public bool lockedAfterAwaken;
}

[Serializable]
public sealed class InventoryCraftDto
{
    public string craftedAt;
    public InventoryCraftSlotsDto slots;
    public string[] sourceFragmentInstanceIds;
}

[Serializable]
public sealed class InventoryCraftSlotsDto
{
    public string core;
    public string[] free;
}

[Serializable]
public sealed class InventoryEnhanceDto
{
    public int level;
    public int maxLevelBeforeAwaken;
}

// payload.eqStats.* 의 값은 "가변 스탯 맵"이므로 강타입 필드 금지
// Unity JsonUtility 기준: Dictionary 직접 역직렬화 불가 -> object로 수신
[Serializable]
public sealed class InventoryEqStatsDto
{
    public object @base; // JSON "base"
    public object now;
    public object awakenedFinal;
}

[Serializable]
public sealed class InventoryExpiredRuleDto
{
    public bool appliesOnlyWhenStateIsExpired;
    public string extraEffectHash; // null 가능
    public string extraEffectId;
    public string mode; // "ADD"
}

[Serializable]
public sealed class InventoryFlagsDto
{
    public bool marketExpiredBonusEligible;
}

[Serializable]
public sealed class InventoryNftDto
{
    public bool eligible;
    public string tokenId; // null 가능
}

[Serializable]
public sealed class InventoryProofDto
{
    public string snapshotHash;
    public string buildHash;
}

[Serializable]
public sealed class InventoryRecordDto
{
    public bool eligible;
    public string eligibleReason;
}

[Serializable]
public sealed class InventorySeasonDto
{
    public string craftedSeason;
    public int expireAfterSeasons;

    public string awakenedSeason;          // null 가능
    public string expiredAtSeason;         // null 가능
    public string recordEligibleState;
    public string recordEligibleUntilSeason; // null 가능
}

[Serializable]
public sealed class InventorySeasonEffectDto
{
    public bool applied;
    public string appliedSeason; // null 가능
    public string hash;          // null 가능

    // modifiers는 오브젝트(맵)인데 JsonUtility로는 Dictionary를 못 받는다.
    // 필요하면 Newtonsoft로 바꾸거나 서버에서 배열로 내려야 함.
    public object modifiers;

    public string ruleSetId;
}

[Serializable]
public sealed class InventorySkillDto
{
    public string[] candidates;
    public string chosen; // null 가능
    public string chosenFromFragmentInstanceId; // null 가능
    public bool locked;
    public string selectedAt; // null 가능
    public string status; // "PENDING"
}
