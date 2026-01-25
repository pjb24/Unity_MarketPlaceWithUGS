using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Unity.Services.Authentication;
using Unity.Services.CloudCode;
using UnityEngine;

/// <summary>
/// MarketCancelFlow
///
/// 목적:
/// - Cloud Code의 GetListing(선택) + CancelListing 호출로 판매 취소를 수행한다.
/// - 파라미터 키는 CancelListing.js와 1:1로 맞춘다.
/// - 실패/폴백은 무음 처리하지 않고 Warning 로그를 남긴다.
/// </summary>
public sealed class MarketCancelFlow
{
    private const string FN_GetListing = "GetListing";
    private const string FN_CancelListing = "CancelListing";

    public sealed class CancelRequest
    {
        public string ListingId;

        // CancelListing params
        public string SellerPlayerId;       // optional (default context.playerId)
        public string ReturnZone;           // "BAG" | "STORAGE" (optional, default "BAG")

        public string InventoryCustomId;    // optional (default "inventory")
        public string ListingsCustomId;     // optional (default "market_listings")
        public string EscrowCustomId;       // optional (default "market_escrow")
        public string IndexesCustomId;      // optional (default "market_indexes")

        // UX용(서버 호출 전에 상태 확인하고 싶으면 true)
        public bool PreflightGetListing;    // GetListing(includeEscrow=false)
    }

    public sealed class CancelResult
    {
        public bool Ok;
        public string FailStep;     // "PREFLIGHT" | "CANCEL"
        public string FailMessage;

        public GetListingResult Prefetch;
        public CancelListingResult Canceled;
    }

    public async Task<CancelResult> CancelAsync(CancelRequest req, CancellationToken ct)
    {
        if (req == null) throw new ArgumentNullException(nameof(req));
        if (string.IsNullOrEmpty(req.ListingId)) throw new ArgumentException("ListingId is required.");

        if (!AuthenticationService.Instance.IsSignedIn)
            throw new InvalidOperationException("Not signed in. Authenticate first.");

        var sellerId = AuthenticationService.Instance.PlayerId;

        // sellerPlayerId를 넘기면 서버에서 owner 체크에 사용됨. (CancelListing.js)
        if (!string.IsNullOrEmpty(req.SellerPlayerId) && req.SellerPlayerId != sellerId)
            throw new ArgumentException("SellerPlayerId must match signed-in PlayerId.");

        GetListingResult pre = null;

        try
        {
            ct.ThrowIfCancellationRequested();

            if (req.PreflightGetListing)
            {
                // GetListing params: listingId, includeEscrow, includeEscrowItem, listingsCustomId, escrowCustomId
                var getArgs = new Dictionary<string, object>
                {
                    { "listingId", req.ListingId },
                    { "includeEscrow", false },
                    { "includeEscrowItem", false }
                };
                if (!string.IsNullOrEmpty(req.ListingsCustomId)) getArgs["listingsCustomId"] = req.ListingsCustomId;
                if (!string.IsNullOrEmpty(req.EscrowCustomId)) getArgs["escrowCustomId"] = req.EscrowCustomId;

                pre = await CloudCodeService.Instance.CallEndpointAsync<GetListingResult>(FN_GetListing, getArgs);

                if (pre == null || string.IsNullOrEmpty(pre.listingId))
                {
                    Debug.LogWarning("[MarketCancelFlow] Preflight fallback 발생: GetListing returned invalid result.");
                    return new CancelResult
                    {
                        Ok = false,
                        FailStep = "PREFLIGHT",
                        FailMessage = "GetListing returned invalid result.",
                        Prefetch = pre
                    };
                }
            }

            // CancelListing params:
            // listingId, sellerPlayerId, returnZone, inventoryCustomId, listingsCustomId, escrowCustomId, indexesCustomId
            var cancelArgs = new Dictionary<string, object>
            {
                { "listingId", req.ListingId }
            };

            // sellerPlayerId는 기본값 context.playerId라서 생략 가능하지만, 명확하게 넣는 쪽이 디버깅이 쉬움
            cancelArgs["sellerPlayerId"] = sellerId;

            if (!string.IsNullOrEmpty(req.ReturnZone)) cancelArgs["returnZone"] = req.ReturnZone;

            if (!string.IsNullOrEmpty(req.InventoryCustomId)) cancelArgs["inventoryCustomId"] = req.InventoryCustomId;
            if (!string.IsNullOrEmpty(req.ListingsCustomId)) cancelArgs["listingsCustomId"] = req.ListingsCustomId;
            if (!string.IsNullOrEmpty(req.EscrowCustomId)) cancelArgs["escrowCustomId"] = req.EscrowCustomId;
            if (!string.IsNullOrEmpty(req.IndexesCustomId)) cancelArgs["indexesCustomId"] = req.IndexesCustomId;

            var canceled = await CloudCodeService.Instance.CallEndpointAsync<CancelListingResult>(FN_CancelListing, cancelArgs);

            if (canceled == null || string.IsNullOrEmpty(canceled.listingId))
            {
                Debug.LogWarning("[MarketCancelFlow] CancelListing fallback 발생: result is null or missing listingId.");
                return new CancelResult
                {
                    Ok = false,
                    FailStep = "CANCEL",
                    FailMessage = "CancelListing returned invalid result.",
                    Prefetch = pre,
                    Canceled = canceled
                };
            }

            return new CancelResult
            {
                Ok = true,
                Prefetch = pre,
                Canceled = canceled
            };
        }
        catch (CloudCodeRateLimitedException e)
        {
            Debug.LogWarning($"[MarketCancelFlow] Rate limited: {e}");
            return new CancelResult { Ok = false, FailStep = "CANCEL", FailMessage = e.Message, Prefetch = pre };
        }
        catch (CloudCodeException e)
        {
            // not owner / not ACTIVE / listing not found / etc
            Debug.LogWarning($"[MarketCancelFlow] CancelListing failed: {e}");
            return new CancelResult { Ok = false, FailStep = "CANCEL", FailMessage = e.Message, Prefetch = pre };
        }
        catch (OperationCanceledException)
        {
            Debug.LogWarning("[MarketCancelFlow] Cancel canceled.");
            return new CancelResult { Ok = false, FailStep = "CANCEL", FailMessage = "canceled", Prefetch = pre };
        }
        catch (Exception e)
        {
            Debug.LogError($"[MarketCancelFlow] Exception: {e}");
            return new CancelResult { Ok = false, FailStep = "CANCEL", FailMessage = e.Message, Prefetch = pre };
        }
    }
}
