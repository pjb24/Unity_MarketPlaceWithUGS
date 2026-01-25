using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Unity.Services.Authentication;
using Unity.Services.CloudCode;
using UnityEngine;

/// <summary>
/// MarketBuyFlow
///
/// 목적:
/// - Cloud Code의 BuyListing을 호출해 구매를 수행한다.
/// - 파라미터 키는 BuyListing.js와 1:1로 맞춘다.
/// - 실패/폴백은 클라에서 무음 처리하지 않고 로그로 남긴다.
/// </summary>
public sealed class MarketBuyFlow
{
    private const string FN_BuyListing = "BuyListing";

    public sealed class BuyRequest
    {
        public string ListingId;

        // BuyListing params
        public string BuyerPlayerId;            // optional (default context.playerId)
        public string ReturnZone;               // "BAG" | "STORAGE" (optional)
        public string CurrencyId;               // optional (default "MARKETTOKEN")
        public int? FeeBps;                     // optional (default 0)
        public string FeeReceiverPlayerId;      // optional (if null => burn)

        public string InventoryCustomId;        // optional (default "inventory")
        public string ListingsCustomId;         // optional (default "market_listings")
        public string EscrowCustomId;           // optional (default "market_escrow")
        public string IndexesCustomId;          // optional (default "market_indexes")
    }

    public sealed class BuyResult
    {
        public bool Ok;
        public string FailStep;     // "BUY"
        public string FailMessage;

        public BuyListingResult Bought;
    }

    public async Task<BuyResult> BuyAsync(BuyRequest req, CancellationToken ct)
    {
        if (req == null) throw new ArgumentNullException(nameof(req));
        if (string.IsNullOrEmpty(req.ListingId)) throw new ArgumentException("ListingId is required.");

        if (!AuthenticationService.Instance.IsSignedIn)
            throw new InvalidOperationException("Not signed in. Authenticate first.");

        var buyerId = AuthenticationService.Instance.PlayerId;

        // buyerPlayerId는 서버가 context.playerId와 동일해야 통과한다. (BuyListing.js 검증)
        if (!string.IsNullOrEmpty(req.BuyerPlayerId) && req.BuyerPlayerId != buyerId)
            throw new ArgumentException("BuyerPlayerId must match signed-in PlayerId.");

        var args = new Dictionary<string, object>
        {
            { "listingId", req.ListingId }
        };

        if (!string.IsNullOrEmpty(req.BuyerPlayerId)) args["buyerPlayerId"] = req.BuyerPlayerId;
        if (!string.IsNullOrEmpty(req.ReturnZone)) args["returnZone"] = req.ReturnZone;
        if (!string.IsNullOrEmpty(req.CurrencyId)) args["currencyId"] = req.CurrencyId;

        if (req.FeeBps.HasValue) args["feeBps"] = req.FeeBps.Value;
        if (!string.IsNullOrEmpty(req.FeeReceiverPlayerId)) args["feeReceiverPlayerId"] = req.FeeReceiverPlayerId;

        if (!string.IsNullOrEmpty(req.InventoryCustomId)) args["inventoryCustomId"] = req.InventoryCustomId;
        if (!string.IsNullOrEmpty(req.ListingsCustomId)) args["listingsCustomId"] = req.ListingsCustomId;
        if (!string.IsNullOrEmpty(req.EscrowCustomId)) args["escrowCustomId"] = req.EscrowCustomId;
        if (!string.IsNullOrEmpty(req.IndexesCustomId)) args["indexesCustomId"] = req.IndexesCustomId;

        try
        {
            ct.ThrowIfCancellationRequested();

            // 단일 엔드포인트 호출로 구매 완료(락/재화/에스크로/리스팅/인덱스 정리까지 서버에서 처리)
            var bought = await CloudCodeService.Instance.CallEndpointAsync<BuyListingResult>(FN_BuyListing, args);

            if (bought == null || string.IsNullOrEmpty(bought.listingId))
            {
                Debug.LogWarning("[MarketBuyFlow] BuyListing fallback 발생: result is null or missing listingId.");
                return new BuyResult
                {
                    Ok = false,
                    FailStep = "BUY",
                    FailMessage = "BuyListing returned invalid result.",
                    Bought = bought
                };
            }

            return new BuyResult
            {
                Ok = true,
                Bought = bought
            };
        }
        catch (CloudCodeRateLimitedException e)
        {
            Debug.LogWarning($"[MarketBuyFlow] Rate limited: {e}");
            return new BuyResult { Ok = false, FailStep = "BUY", FailMessage = e.Message };
        }
        catch (CloudCodeException e)
        {
            // BuyListing.js에서 락 경쟁/만료/상태불일치/잔액부족 등이 여기로 온다.
            // 메시지를 그대로 노출하면 운영엔 편하지만 UX는 따로 매핑해라.
            Debug.LogWarning($"[MarketBuyFlow] BuyListing failed: {e}");
            return new BuyResult { Ok = false, FailStep = "BUY", FailMessage = e.Message };
        }
        catch (OperationCanceledException)
        {
            Debug.LogWarning("[MarketBuyFlow] Buy canceled.");
            return new BuyResult { Ok = false, FailStep = "BUY", FailMessage = "canceled" };
        }
        catch (Exception e)
        {
            Debug.LogError($"[MarketBuyFlow] Exception: {e}");
            return new BuyResult { Ok = false, FailStep = "BUY", FailMessage = e.Message };
        }
    }
}
