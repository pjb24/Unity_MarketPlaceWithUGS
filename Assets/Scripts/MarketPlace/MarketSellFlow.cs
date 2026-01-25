using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Unity.Services.Authentication;
using Unity.Services.CloudCode;
using UnityEngine;

public class MarketSellFlow
{
    // Cloud Code Script Names (Dashboard에 퍼블리시된 이름과 동일해야 함)
    private const string FN_AcquireTxnLock = "AcquireTxnLock";
    private const string FN_ReleaseTxnLock = "ReleaseTxnLock";
    private const string FN_ValidateItemTradable = "ValidateItemTradable";
    private const string FN_CreateListing = "CreateListing";
    private const string FN_WriteLedgerEntry = "WriteLedgerEntry";

    public sealed class SellRequest
    {
        public string ItemInstanceId;
        public double Price;

        public int? ExpiresInSeconds;       // CreateListing: expiresInSeconds
        public string InventoryCustomId;    // default "inventory"
        public string ListingsCustomId;     // default "market_listings"
        public string EscrowCustomId;       // default "market_escrow"
        public string IndexesCustomId;      // default "market_indexes"

        public bool WriteAuditLedger;       // delta=0 ledger 남길지 여부
        public string MtCurrencyId;         // WriteLedgerEntry에 넣을 currencyId (예: "MT")
    }

    public sealed class SellResult
    {
        public bool Ok;
        public string FailStep;         // "LOCK" | "VALIDATE" | "CREATE" | "LEDGER" | "UNLOCK"
        public string FailMessage;

        public AcquireTxnLockResult Lock;
        public ValidateItemTradableResult Validate;
        public CreateListingResult Listing;
        public WriteLedgerEntryResult Ledger;
    }

    public async Task<SellResult> SellAsync(SellRequest req, CancellationToken ct)
    {
        if (req == null) throw new ArgumentNullException(nameof(req));
        if (string.IsNullOrEmpty(req.ItemInstanceId)) throw new ArgumentException("ItemInstanceId is required.");
        if (req.Price <= 0) throw new ArgumentException("Price must be > 0.");

        if (!AuthenticationService.Instance.IsSignedIn)
            throw new InvalidOperationException("Not signed in. Authenticate first.");

        string sellerPlayerId = AuthenticationService.Instance.PlayerId;
        AcquireTxnLockResult lockRes = null;

        try
        {
            ct.ThrowIfCancellationRequested();

            // 1) PLAYER 락
            lockRes = await CallAsync<AcquireTxnLockResult>(
                FN_AcquireTxnLock,
                new Dictionary<string, object>
                {
                    { "scope", "PLAYER" },
                    { "id", sellerPlayerId },
                    { "ttlSeconds", 20 } // 판매 등록은 Cloud Save 쓰기가 여러 번이니 조금 여유
                },
                ct
            );

            // 2) 거래 가능 검증 (expectedZone=BAG 고정)
            var validate = await CallAsync<ValidateItemTradableResult>(
                FN_ValidateItemTradable,
                new Dictionary<string, object>
                {
                    { "itemInstanceId", req.ItemInstanceId },
                    { "playerId", sellerPlayerId },
                    { "expectedZone", "BAG" },

                    // 필요 시 커스텀 가능(서버 기본값이 있으니 보통 생략 가능)
                    // { "allowKinds", new [] { "FRAG", "EQ" } },
                    // { "inventoryCustomId", req.InventoryCustomId ?? "inventory" },
                    // { "inventoryKey", req.ItemInstanceId },
                    // { "inventoryContainerKey", null },
                },
                ct
            );

            if (!validate.ok || !validate.tradable)
            {
                return new SellResult
                {
                    Ok = false,
                    FailStep = "VALIDATE",
                    FailMessage = $"ValidateItemTradable failed. reasonCode={validate.reasonCode}",
                    Lock = lockRes,
                    Validate = validate
                };
            }

            // 3) 리스팅 생성
            // 주의: CreateListing은 내부에서 인벤 로드/검증/에스크로/리스팅/인덱스/인벤삭제까지 수행한다.
            // 따라서 MoveItemToEscrow를 먼저 호출하면 CreateListing이 (zone/lock) 조건 때문에 실패한다.
            var createArgs = new Dictionary<string, object>
            {
                { "itemInstanceId", req.ItemInstanceId },
                { "price", req.Price }
            };

            if (req.ExpiresInSeconds.HasValue) createArgs["expiresInSeconds"] = req.ExpiresInSeconds.Value;
            if (!string.IsNullOrEmpty(req.InventoryCustomId)) createArgs["inventoryCustomId"] = req.InventoryCustomId;
            if (!string.IsNullOrEmpty(req.ListingsCustomId)) createArgs["listingsCustomId"] = req.ListingsCustomId;
            if (!string.IsNullOrEmpty(req.EscrowCustomId)) createArgs["escrowCustomId"] = req.EscrowCustomId;
            if (!string.IsNullOrEmpty(req.IndexesCustomId)) createArgs["indexesCustomId"] = req.IndexesCustomId;

            // sellerPlayerId는 서버 기본값(context.playerId)이 있으니 보통 생략해도 됨
            // createArgs["sellerPlayerId"] = sellerPlayerId;

            var listing = await CallAsync<CreateListingResult>(FN_CreateListing, createArgs, ct);

            // 4) (선택) 원장 기록: 판매 등록 “행위 로그” 용도
            WriteLedgerEntryResult ledger = null;
            if (req.WriteAuditLedger)
            {
                if (string.IsNullOrEmpty(req.MtCurrencyId))
                {
                    Debug.LogWarning("[MarketSellFlow] WriteAuditLedger=true but MtCurrencyId is empty. Ledger skipped (fallback).");
                }
                else
                {
                    // delta=0이면 서버에서 Warning을 남긴다(WriteLedgerEntry 구현상). 의도된 감사 로그라면 감수.
                    var txnId = $"LISTING_CREATE_{listing.listingId}";
                    var entryId = "LISTING_CREATE";

                    ledger = await CallAsync<WriteLedgerEntryResult>(
                        FN_WriteLedgerEntry,
                        new Dictionary<string, object>
                        {
                            { "txnId", txnId },
                            { "entryId", entryId },
                            { "accountId", sellerPlayerId },
                            { "currencyId", req.MtCurrencyId },
                            { "delta", 0.0 },
                            { "reason", "LISTING_CREATE" },
                            { "refType", "LISTING" },
                            { "refId", listing.listingId },
                            { "meta", new Dictionary<string, object>
                                {
                                    { "itemInstanceId", req.ItemInstanceId },
                                    { "price", req.Price },
                                    { "expiresAt", listing.expiresAt }
                                }
                            }
                        },
                        ct
                    );
                }
            }

            return new SellResult
            {
                Ok = true,
                Lock = lockRes,
                Validate = validate,
                Listing = listing,
                Ledger = ledger
            };
        }
        catch (CloudCodeRateLimitedException e)
        {
            Debug.LogWarning($"[MarketSellFlow] Rate limited: {e}");
            return new SellResult { Ok = false, FailStep = "RATE_LIMIT", FailMessage = e.Message, Lock = lockRes };
        }
        catch (CloudCodeException e)
        {
            Debug.LogError($"[MarketSellFlow] CloudCodeException: {e}");
            return new SellResult { Ok = false, FailStep = "CLOUD_CODE", FailMessage = e.Message, Lock = lockRes };
        }
        catch (Exception e)
        {
            Debug.LogError($"[MarketSellFlow] Exception: {e}");
            return new SellResult { Ok = false, FailStep = "UNKNOWN", FailMessage = e.Message, Lock = lockRes };
        }
        finally
        {
            // 5) 락 해제: 실패해도 무음 금지 (Warning 로그)
            if (lockRes != null && !string.IsNullOrEmpty(lockRes.token))
            {
                try
                {
                    ct.ThrowIfCancellationRequested();

                    var rel = await CallAsync<ReleaseTxnLockResult>(
                        FN_ReleaseTxnLock,
                        new Dictionary<string, object>
                        {
                            { "scope", "PLAYER" },
                            { "id", AuthenticationService.Instance.PlayerId },
                            { "token", lockRes.token },
                            { "force", false }
                        },
                        CancellationToken.None // 해제는 best-effort
                    );

                    if (!rel.released)
                        Debug.LogWarning($"[MarketSellFlow] ReleaseTxnLock fallback 발생: reason={rel.reason}, lockKey={rel.lockKey}");
                }
                catch (Exception ex)
                {
                    Debug.LogWarning($"[MarketSellFlow] ReleaseTxnLock fallback 발생: {ex}");
                }
            }
        }
    }

    private static async Task<TResult> CallAsync<TResult>(string function, Dictionary<string, object> args, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        // Unity Cloud Code docs: CloudCodeService.Instance.CallEndpointAsync<TResult>(function, args)
        // args는 JSON으로 직렬화되어 params로 전달된다. :contentReference[oaicite:17]{index=17}
        var res = await CloudCodeService.Instance.CallEndpointAsync<TResult>(function, args);
        ct.ThrowIfCancellationRequested();
        return res;
    }
}
