using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using Unity.Services.Core;
using Unity.Services.Authentication;
using Unity.Services.CloudCode;
using Newtonsoft.Json.Linq;

public class MarketEnterFlow : MonoBehaviour
{
    public enum E_State
    {
        None = 0,
        Loading = 1,
        Ready = 2,
        Error = 3
    }

    [Header("Runtime")]
    [SerializeField] private E_State _state = E_State.None;
    public E_State State => _state;

    // Cloud Code script names (Dashboard에 퍼블리시된 스크립트 이름과 동일해야 함)
    private const string EP_GetServerTime = "GetServerTime";
    private const string EP_GetConfig = "GetConfig";
    private const string EP_GetWallet = "GetWallet";
    private const string EP_GetInventorySnapshot = "GetInventorySnapshot";
    private const string EP_QueryListings = "QueryListings";
    private const string EP_GetMyListings = "GetMyListings";
    private const string EP_GetTradeHistory = "GetTradeHistory";

    // ===== Public API =====

    /// <summary>
    /// 거래소 진입 시 호출.
    /// 필요한 데이터만 로드: 서버시간/설정/지갑/인벤스냅샷/마켓목록/내목록/거래내역
    /// </summary>
    public async Task<MarketEnterResult> EnterMarketAsync(CancellationToken ct = default)
    {
        _state = E_State.Loading;

        if (!EnsureReady())
        {
            _state = E_State.Error;
            return MakeError("UGS not ready. (fallback 발생)");
        }

        // 1) GetServerTime (args 없음)
        var serverTime = await TryCallAsync<GetServerTimeResult>(EP_GetServerTime, null, ct);
        if (!serverTime.Ok)
        {
            _state = E_State.Error;
            return MakeError($"GetServerTime failed: {serverTime.Error}");
        }

        // 2) GetConfig (keyPrefix optional)
        // GetConfig.js default keyPrefix="market." 이라 굳이 안 넘겨도 됨.
        var configArgs = new Dictionary<string, object>(); // { "keyPrefix", "market." } 필요 시 추가
        var config = await TryCallAsync<GetConfigResult>(EP_GetConfig, configArgs, ct);
        if (!config.Ok)
        {
            _state = E_State.Error;
            return MakeError($"GetConfig failed: {config.Error}");
        }

        // 3) 병렬 호출 args를 JS params 키 그대로 구성
        var walletArgs = new Dictionary<string, object>
        {
            // { "playerId", AuthenticationService.Instance.PlayerId }, // 생략하면 서버에서 context.playerId 사용
            // { "currencyIds", new [] { "MARKETTOKEN", "ENERGYCREDITS" } }, // 생략하면 서버 기본 사용
            // { "tokenType", "SERVICE" } // 기본 "SERVICE"
        };

        // 인벤 스냅샷은 지갑 포함 안 함(지갑은 GetWallet로 별도 조회)
        var invArgs = new Dictionary<string, object>
        {
            // { "groupKey", "FRAG_WPN_T1" },
            // { "kind", FRAG },
            // { "slot", WPN },
            // { "tier", 1 },
            // { "maxItems", 5000 },
            // { "maxKeysPerRequest", 100 },
            // { "includeRaw", true },
        };

        var queryListingsArgs = new Dictionary<string, object>
        {
            // { "status", "ACTIVE" },            // QueryListings는 ACTIVE만 지원
            // { "sort", "CREATED_AT" },          // "CREATED_AT" | "PRICE"
            // { "order", "ASC" },                // "ASC" | "DESC" (DESC는 Warning 후 ASC 기반 반환)
            // { "pageSize", 20 },                // 1~50
            // { "pageToken", "" },             // 다음 페이지면 string
            // { "indexesCustomId", "market_indexes" },
            // { "listingsCustomId", "market_listings" },
            // { "escrowCustomId", "escrow" }
        };

        var myListingsArgs = new Dictionary<string, object>
        {
            // { "sellerPlayerId", AuthenticationService.Instance.PlayerId }, // 생략하면 context.playerId
            { "status", "ACTIVE" },            // GetMyListings는 ACTIVE만 지원
            { "pageSize", 20 },
            { "pageToken", "" },
            // { "indexesCustomId", "market_indexes" },
            // { "listingsCustomId", "market_listings" },
            // { "escrowCustomId", "escrow" }
        };

        var tradeHistoryArgs = new Dictionary<string, object>
        {
            // { "playerId", AuthenticationService.Instance.PlayerId },
            // { "role", "" },                 // "BUY" | "SELL" | "ALL" (선택)
            // { "pageSize", 20 },             // (선택) 기본 20, 최대 50 (서버에서 clamp)
            // { "pageToken", "" },            // (선택) getCustomKeys(after)에 들어가는 after key
            // { "indexesCustomId", "" },      // (선택) 기본 "market_indexes"
            // { "tradesCustomId", "" },       // (선택) 기본 "market_trades"
            // { "escrowCustomId", "" },       // (선택) 기본 "escrow"
            // { "includeEscrowItem", false },    // (선택) escrow 아이템 첨부 조회 여부
        };

        var walletTask = TryCallAsync<GetWalletResult>(EP_GetWallet, walletArgs, ct);
        var invTask = TryCallAsync<GetInventorySnapshotResponseDto>(EP_GetInventorySnapshot, invArgs, ct);
        var listingsTask = TryCallAsync<QueryListingsResult>(EP_QueryListings, queryListingsArgs, ct);
        var myListingsTask = TryCallAsync<GetMyListingsResult>(EP_GetMyListings, myListingsArgs, ct);
        var tradeTask = TryCallAsync<GetTradeHistoryResult>(EP_GetTradeHistory, tradeHistoryArgs, ct);

        await Task.WhenAll(walletTask, invTask, listingsTask, myListingsTask, tradeTask);

        var result = new MarketEnterResult
        {
            ServerTime = serverTime.Value,
            Config = config.Value,

            Wallet = walletTask.Result.Ok ? walletTask.Result.Value : MakeEmptyWallet(AuthenticationService.Instance.PlayerId),
            InventorySnapshot = invTask.Result.Ok ? invTask.Result.Value : MakeEmptyInventorySnapshot(),
            MarketListings = listingsTask.Result.Ok ? listingsTask.Result.Value : MakeEmptyQueryListings(),
            MyListings = myListingsTask.Result.Ok ? myListingsTask.Result.Value : MakeEmptyMyListings(AuthenticationService.Instance.PlayerId),
            TradeHistory = tradeTask.Result.Ok ? tradeTask.Result.Value : MakeEmptyTradeHistory(AuthenticationService.Instance.PlayerId),

            HasPartialFailures = false,
            PartialFailures = new List<string>()
        };

        ApplyPartialFailure(walletTask.Result, "GetWallet", ref result);
        ApplyPartialFailure(invTask.Result, "GetInventorySnapshot", ref result);
        ApplyPartialFailure(listingsTask.Result, "QueryListings", ref result);
        ApplyPartialFailure(myListingsTask.Result, "GetMyListings", ref result);
        ApplyPartialFailure(tradeTask.Result, "GetTradeHistory", ref result);

        _state = E_State.Ready;
        return result;
    }

    /// <summary>
    /// QueryListings 페이지 조회.
    /// JS params: status, sort, order, pageSize, pageToken
    /// JS return: { items, nextPageToken, skipped }
    /// </summary>
    public async Task<QueryListingsResult> QueryListingsPageAsync(
        string status,
        string sort,
        string order,
        int pageSize,
        string pageToken,
        CancellationToken ct = default)
    {
        if (!EnsureReady())
        {
            Debug.LogWarning("[MarketEnterFlow] QueryListingsPageAsync fallback 발생: UGS not ready");
            return new QueryListingsResult { items = new List<ListingDto>(), nextPageToken = null, skipped = 0 };
        }

        var args = new Dictionary<string, object>
        {
            { "status", status },
            { "sort", sort },
            { "order", order },
            { "pageSize", pageSize },
            { "pageToken", pageToken }
        };

        var r = await TryCallAsync<QueryListingsResult>(EP_QueryListings, args, ct);
        if (r.Ok) return r.Value;

        Debug.LogWarning($"[MarketEnterFlow] QueryListingsPageAsync fallback 발생: {r.Error}");
        return new QueryListingsResult { items = new List<ListingDto>(), nextPageToken = null, skipped = 0 };
    }

    /// <summary>
    /// GetMyListings 페이지 조회.
    /// JS params: sellerPlayerId?, status, pageSize, pageToken
    /// JS return: { sellerPlayerId, status, items, nextPageToken, skipped }
    /// </summary>
    public async Task<GetMyListingsResult> GetMyListingsPageAsync(
        string status,
        int pageSize,
        string pageToken,
        string sellerPlayerId = null,
        CancellationToken ct = default)
    {
        if (!EnsureReady())
        {
            Debug.LogWarning("[MarketEnterFlow] GetMyListingsPageAsync fallback 발생: UGS not ready");
            return new GetMyListingsResult
            {
                sellerPlayerId = AuthenticationService.Instance.PlayerId,
                status = status,
                items = new List<ListingDto>(),
                nextPageToken = null,
                skipped = 0
            };
        }

        var args = new Dictionary<string, object>
        {
            { "status", status },
            { "pageSize", pageSize },
            { "pageToken", pageToken }
        };

        // sellerPlayerId는 서버에서 context.playerId로 처리하므로 null이면 안 보낸다.
        if (!string.IsNullOrEmpty(sellerPlayerId))
            args["sellerPlayerId"] = sellerPlayerId;

        var r = await TryCallAsync<GetMyListingsResult>(EP_GetMyListings, args, ct);
        if (r.Ok) return r.Value;

        Debug.LogWarning($"[MarketEnterFlow] GetMyListingsPageAsync fallback 발생: {r.Error}");
        return new GetMyListingsResult
        {
            sellerPlayerId = string.IsNullOrEmpty(sellerPlayerId) ? AuthenticationService.Instance.PlayerId : sellerPlayerId,
            status = status,
            items = new List<ListingDto>(),
            nextPageToken = null,
            skipped = 0
        };
    }

    /// <summary>
    /// GetTradeHistory 페이지 조회.
    /// JS params: playerId?, role, order, pageSize, pageToken
    /// JS return: { playerId, role, items, nextPageToken, skipped }
    /// </summary>
    public async Task<GetTradeHistoryResult> GetTradeHistoryPageAsync(
        string role,
        string order,
        int pageSize,
        string pageToken,
        string playerId = null,
        CancellationToken ct = default)
    {
        if (!EnsureReady())
        {
            Debug.LogWarning("[MarketEnterFlow] GetTradeHistoryPageAsync fallback 발생: UGS not ready");
            return new GetTradeHistoryResult
            {
                playerId = AuthenticationService.Instance.PlayerId,
                role = role,
                items = new List<TradeRecordDto>(),
                nextPageToken = null,
                skipped = 0
            };
        }

        var args = new Dictionary<string, object>
        {
            { "role", role },
            { "order", order },
            { "pageSize", pageSize },
            { "pageToken", pageToken }
        };

        if (!string.IsNullOrEmpty(playerId))
            args["playerId"] = playerId;

        var r = await TryCallAsync<GetTradeHistoryResult>(EP_GetTradeHistory, args, ct);
        if (r.Ok) return r.Value;

        Debug.LogWarning($"[MarketEnterFlow] GetTradeHistoryPageAsync fallback 발생: {r.Error}");
        return new GetTradeHistoryResult
        {
            playerId = string.IsNullOrEmpty(playerId) ? AuthenticationService.Instance.PlayerId : playerId,
            role = role,
            items = new List<TradeRecordDto>(),
            nextPageToken = null,
            skipped = 0
        };
    }

    // ===== Internal =====

    private bool EnsureReady()
    {
        if (UnityServices.State != ServicesInitializationState.Initialized)
        {
            Debug.LogWarning("[MarketEnter] UnityServices not initialized. (fallback 발생)");
            return false;
        }

        if (!AuthenticationService.Instance.IsSignedIn)
        {
            Debug.LogWarning("[MarketEnter] Not signed in. (fallback 발생)");
            return false;
        }

        return true;
    }

    private async Task<CallResult<T>> TryCallAsync<T>(string endpoint, Dictionary<string, object> args, CancellationToken ct)
    {
        try
        {
            ct.ThrowIfCancellationRequested();

            // Unity Runtime 문서 방식: CallEndpointAsync(functionName, args)
            // args는 params로 JSON serialize되어 스크립트에 전달된다.
            var payload = args ?? new Dictionary<string, object>();
            var value = await CloudCodeService.Instance.CallEndpointAsync<T>(endpoint, payload);
            return CallResult<T>.Success(value);
        }
        
        catch (CloudCodeRateLimitedException ex)
        {
            return CallResult<T>.Fail($"RateLimited: {ex.Message}");
        }
        catch (CloudCodeException ex)
        {
            return CallResult<T>.Fail($"CloudCodeException: {ex.Message}");
        }
        catch (RequestFailedException ex)
        {
            return CallResult<T>.Fail($"RequestFailed: Code={ex.ErrorCode} Message={ex.Message}");
        }
        catch (OperationCanceledException)
        {
            return CallResult<T>.Fail("Canceled");
        }
        catch (Exception ex)
        {
            return CallResult<T>.Fail($"Exception: {ex}");
        }
    }

    private void ApplyPartialFailure<T>(CallResult<T> call, string label, ref MarketEnterResult result)
    {
        if (call.Ok) return;

        result.HasPartialFailures = true;
        result.PartialFailures.Add($"{label}: {call.Error}");

        // 폴백은 무조건 Warning 로그
        Debug.LogWarning($"[MarketEnter] fallback 발생: {label} failed. err={call.Error}");
    }

    private MarketEnterResult MakeError(string reason)
    {
        Debug.LogError($"[MarketEnter] EnterMarket failed: {reason}");
        return new MarketEnterResult
        {
            HasPartialFailures = true,
            PartialFailures = new List<string> { reason }
        };
    }

    private GetWalletResult MakeEmptyWallet(string playerId)
    {
        return new GetWalletResult
        {
            playerId = playerId,
            currencies = new Dictionary<string, CurrencyBalanceDto>(),
            fetchedAt = DateTime.UtcNow.ToString("o")
        };
    }

    private GetInventorySnapshotResponseDto MakeEmptyInventorySnapshot()
    {
        return new GetInventorySnapshotResponseDto
        {
            ok = false,

            errorCode = null,
            errorMessage = null,

            scope = "PROTECTED_PLAYER_DATA",
            indexKeyUsed = null,
            groupKeyUsed = null,

            nowIso = null,
            nowEpochMs = 0,

            instanceKeys = new List<string>(),

            snapshot = new InventorySnapshotSnapshotDto
            {
                instances = new List<JToken>()
            },

            view = new InventorySnapshotViewDto
            {
                instances = new List<InventorySnapshotViewInstanceDto>()
            },

            counts = new InventorySnapshotCountsDto
            {
                indexed = 0,
                selected = 0,
                loaded = 0,
                missing = 0
            },

            snapshotHash32 = 0,
            snapshotHashHex = null
        };
    }

    private QueryListingsResult MakeEmptyQueryListings()
    {
        return new QueryListingsResult
        {
            items = new List<ListingDto>(),
            nextPageToken = null,
            skipped = 0
        };
    }

    private GetMyListingsResult MakeEmptyMyListings(string sellerPlayerId)
    {
        return new GetMyListingsResult
        {
            sellerPlayerId = sellerPlayerId,
            status = "ACTIVE",
            items = new List<ListingDto>(),
            nextPageToken = null,
            skipped = 0
        };
    }

    private GetTradeHistoryResult MakeEmptyTradeHistory(string playerId)
    {
        return new GetTradeHistoryResult
        {
            playerId = playerId,
            role = "BOTH",
            items = new List<TradeRecordDto>(),
            nextPageToken = null,
            skipped = 0
        };
    }

    private readonly struct CallResult<T>
    {
        public readonly bool Ok;
        public readonly T Value;
        public readonly string Error;

        private CallResult(bool ok, T value, string error)
        {
            Ok = ok;
            Value = value;
            Error = error;
        }

        public static CallResult<T> Success(T value) => new CallResult<T>(true, value, null);
        public static CallResult<T> Fail(string error) => new CallResult<T>(false, default, error);
    }
}
