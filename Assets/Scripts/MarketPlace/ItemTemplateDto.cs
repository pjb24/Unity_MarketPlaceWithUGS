using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;

[Serializable]
public class ItemTemplateDto
{
    // Root (공통)
    public string groupKey;
    public string key;
    public string kind;   // "EQ" | "FRAG"

    public int schema;
    public string slot;   // "WPN" | "ARM" | "ACC" ...
    public int tier;
    public string rarity; // "COMMON" ...

    public MetaDto meta;
    public PayloadDto payload;

    // DTO에 정의되지 않은 필드가 들어와도 여기에 저장되어 역직렬화 실패를 막는다.
    [JsonExtensionData]
    public IDictionary<string, JToken> _extraRoot;

    [Serializable]
    public struct MetaDto
    {
        public string authorNote;
        public string createdAt;
        public string updatedAt;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extraMeta;
    }

    [Serializable]
    public struct PayloadDto
    {
        // Payload (공통)
        public int schema;
        public string kind;   // "EQ" | "FRAG"
        public string slot;
        public int tier;
        public string rarity;

        public LifecycleDto lifecycle;
        public LocationDto location;
        public MarketDto market;
        public ProofDto proof;
        public FlagsDto flags;

        // FRAG 전용
        public string skillId;
        public FragStatsDto stats; // FRAG도 stats를 쓰므로 공통처럼 두되, EQ에서도 쓰는 구조라 확장 포함

        // EQ 전용 (있으면 채워짐, 없으면 default)
        public string state;
        public EnhanceDto enhance;
        public CraftDto craft;
        public AwakenDto awaken;
        public ExpiredDto expired;
        public SeasonDto season;
        public SeasonEffectDto seasonEffect;
        public SkillChoiceDto skill;
        public NftDto nft;
        public RecordDto record;

        // EQ stats에서 now/awakenedFinal 같은 추가 키가 와도 안전하게 커버
        public EqStatsDto eqStats;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extraPayload;
    }

    // ---------- Common sub-DTOs ----------

    [Serializable]
    public struct LifecycleDto
    {
        public string createdAt;
        public string createdBy;
        public string updatedAt;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    [Serializable]
    public struct LocationDto
    {
        public string zone; // "BAG" ...
        public string note;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    [Serializable]
    public struct MarketDto
    {
        public bool tradable;
        public TradeLockDto tradeLock;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    [Serializable]
    public struct TradeLockDto
    {
        public bool isLocked;
        public string reason;
        public string until;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    [Serializable]
    public struct ProofDto
    {
        public string buildHash;
        public string snapshotHash;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    [Serializable]
    public struct FlagsDto
    {
        public bool? marketExpiredBonusEligible;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    // ---------- FRAG stats (base/potentialCaps) ----------

    [Serializable]
    public struct FragStatsDto
    {
        [JsonProperty("base")]
        public Dictionary<string, double> baseStats;

        public Dictionary<string, double> potentialCaps;

        // EQ 데이터가 stats 안에 now/awakenedFinal 등을 넣는 경우도 흡수
        public Dictionary<string, double> now;
        public Dictionary<string, double> awakenedFinal;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    // ---------- EQ 전용 ----------

    [Serializable]
    public struct EnhanceDto
    {
        public int level;
        public int maxLevelBeforeAwaken;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    [Serializable]
    public struct CraftDto
    {
        public string craftedAt;
        public CraftSlotsDto slots;
        public List<string> sourceFragmentInstanceIds;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    [Serializable]
    public struct CraftSlotsDto
    {
        public string core;
        public List<string> free;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    [Serializable]
    public struct AwakenDto
    {
        public string effectHash;
        public string effectId;
        public bool lockedAfterAwaken;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    [Serializable]
    public struct ExpiredDto
    {
        public bool appliesOnlyWhenStateIsExpired;
        public string extraEffectHash;
        public string extraEffectId;
        public string mode;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    [Serializable]
    public struct SeasonDto
    {
        public string craftedSeason;
        public string awakenedSeason;
        public int expireAfterSeasons;
        public string expiredAtSeason;
        public string recordEligibleState;
        public string recordEligibleUntilSeason;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    [Serializable]
    public struct SeasonEffectDto
    {
        public bool applied;
        public string appliedSeason;
        public string hash;
        public Dictionary<string, double> modifiers;
        public string ruleSetId;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    [Serializable]
    public struct SkillChoiceDto
    {
        public List<string> candidates;
        public string chosen;
        public string chosenFromFragmentInstanceId;
        public bool locked;
        public string selectedAt;
        public string status;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    [Serializable]
    public struct NftDto
    {
        public bool eligible;
        public string tokenId;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    [Serializable]
    public struct RecordDto
    {
        public bool eligible;
        public string eligibleReason;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }

    // EQ의 stats가 구조적으로 더 크면 여기로 받을 수 있게 추가
    // (payload.stats로도 대부분 커버되지만, 필요하면 eqStats를 사용)
    [Serializable]
    public struct EqStatsDto
    {
        [JsonProperty("base")]
        public Dictionary<string, double> baseStats;

        public Dictionary<string, double> now;
        public Dictionary<string, double> awakenedFinal;

        [JsonExtensionData]
        public IDictionary<string, JToken> _extra;
    }
}
