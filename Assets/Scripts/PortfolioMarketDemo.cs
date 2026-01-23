using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using TMPro;
using Unity.Services.Authentication;
using Unity.Services.CloudCode;
using Unity.Services.Economy;
using Unity.Services.Economy.Model;
using UnityEngine;
using UnityEngine.UI;

public class PortfolioMarketDemo : MonoBehaviour
{
    [Header("Economy IDs")]
    [SerializeField] private string currencyId = "COIN";

    [Header("Random Give Pool (Resource IDs)")]
    [SerializeField] private string[] randomGiveItemIds = { "SWORD", "REDPOTION", "BLUEPOTION" };

    [Header("Top UI")]
    [SerializeField] private TextMeshProUGUI debugLine;
    [SerializeField] private TextMeshProUGUI coinText;
    [SerializeField] private TMP_InputField priceInput;
    [SerializeField] private Button refreshBtn;
    [SerializeField] private Button giveEquipmentBtn;
    [SerializeField] private Button addCoinBtn;
    [SerializeField] private Button claimBtn;

    [Header("Inventory UI")]
    [SerializeField] private Transform inventoryContent;
    [SerializeField] private InventoryRowUI inventoryRowPrefab;

    [Header("Market UI")]
    [SerializeField] private Transform marketContent;
    [SerializeField] private MarketRowUI marketRowPrefab;
    [SerializeField] private Button marketRefreshBtn;

    [Header("Market Options")]
    [SerializeField] private int marketLimit = 30;
    [SerializeField] private string marketSort = "NEWEST"; // NEWEST / PRICE_ASC / PRICE_DESC

    private bool isEconomyConfigSynced = false;

    private void Start()
    {
        if (refreshBtn != null) refreshBtn.onClick.AddListener(() => _ = RefreshAllAsync());
        if (giveEquipmentBtn != null) giveEquipmentBtn.onClick.AddListener(() => _ = GiveRandomItemAsync());
        if (addCoinBtn != null) addCoinBtn.onClick.AddListener(() => _ = AddCoinAsync(100));
        if (claimBtn != null) claimBtn.onClick.AddListener(() => _ = ClaimEarningsAsync());
        if (marketRefreshBtn != null) marketRefreshBtn.onClick.AddListener(() => _ = RefreshMarketAsync());
    }

    public async Task RefreshAllAsync()
    {
        if (!AuthenticationService.Instance.IsSignedIn)
        {
            SetMessage("로그인 필요");
            return;
        }

        await EnsureEconomyConfigSyncedAsync();

        await RefreshCoinsAsync();
        await RefreshInventoryAsync();
        await RefreshMarketAsync();
    }

    private async Task EnsureEconomyConfigSyncedAsync()
    {
        if (isEconomyConfigSynced) return;

        try
        {
            await EconomyService.Instance.Configuration.SyncConfigurationAsync();
            isEconomyConfigSynced = true;
            Debug.Log("[Economy] Configuration synced");
        }
        catch (Exception e)
        {
            Debug.LogException(e);
            SetMessage("Economy Sync 실패 (Publish/환경/프로젝트 확인)");
        }
    }

    private void SetMessage(string message)
    {
        if (debugLine != null) debugLine.text = message;
        Debug.Log(message);
    }

    private int GetSellPrice()
    {
        if (priceInput == null) return 100;
        if (int.TryParse(priceInput.text, out int price)) return Mathf.Max(1, price);
        return 100;
    }

    // -------------------------
    // Economy: Coin
    // -------------------------
    private async Task RefreshCoinsAsync()
    {
        try
        {
            var balances = await EconomyService.Instance.PlayerBalances.GetBalancesAsync();
            long coin = 0;

            foreach (var b in balances.Balances)
            {
                if (b.CurrencyId == currencyId)
                {
                    coin = b.Balance;
                    break;
                }
            }

            if (coinText != null) coinText.text = coin.ToString();
        }
        catch (EconomyException e)
        {
            Debug.LogException(e);
            SetMessage("코인 조회 실패 (Economy Publish/환경 확인)");
        }
    }

    private async Task AddCoinAsync(long amount)
    {
        try
        {
            await EnsureEconomyConfigSyncedAsync();

            int delta = ToSafeInt(amount);
            await EconomyService.Instance.PlayerBalances.IncrementBalanceAsync(currencyId, delta);
            await RefreshCoinsAsync();
            SetMessage($"코인 +{amount}");
        }
        catch (EconomyException e)
        {
            Debug.LogException(e);
            SetMessage("코인 증가 실패 (Economy Publish/통화 ID 확인)");
        }
    }

    private int ToSafeInt(long value)
    {
        if (value > int.MaxValue) return int.MaxValue;
        if (value < int.MinValue) return int.MinValue;
        return (int)value;
    }

    // -------------------------
    // Economy: Inventory
    // -------------------------
    private async Task RefreshInventoryAsync()
    {
        try
        {
            ClearChildren(inventoryContent);

            GetInventoryResult inv = await EconomyService.Instance.PlayerInventory.GetInventoryAsync();
            List<PlayersInventoryItem> items = inv.PlayersInventoryItems;

            foreach (var item in items)
            {
                if (inventoryRowPrefab == null || inventoryContent == null)
                {
                    Debug.Log($"Inventory: {item.InventoryItemId} / {item.PlayersInventoryItemId}");
                    continue;
                }

                InventoryRowUI row = Instantiate(inventoryRowPrefab, inventoryContent);
                row.Bind(item, GetSellPrice, CreateListingAsync);
            }

            SetMessage($"인벤 로드 완료: {items.Count}개");
        }
        catch (EconomyException e)
        {
            Debug.LogException(e);
            SetMessage("인벤 조회 실패 (Economy Publish/로그인 상태 확인)");
        }
    }

    // -------------------------
    // Give Random: SWORD / REDPOTION / BLUEPOTION
    // -------------------------
    private async Task GiveRandomItemAsync()
    {
        if (!AuthenticationService.Instance.IsSignedIn)
        {
            SetMessage("로그인 먼저");
            return;
        }

        await EnsureEconomyConfigSyncedAsync();

        if (randomGiveItemIds == null || randomGiveItemIds.Length == 0)
        {
            SetMessage("randomGiveItemIds 비어있음");
            return;
        }

        string templateId = PickRandomId(randomGiveItemIds);
        Debug.Log($"[GiveRandom] templateId='{templateId}'");

        try
        {
            PlayersInventoryItem created =
                await EconomyService.Instance.PlayerInventory.AddInventoryItemAsync(templateId);

            SetMessage($"지급 성공: {created.InventoryItemId} / {created.PlayersInventoryItemId}");
            await RefreshInventoryAsync();
        }
        catch (EconomyException e)
        {
            Debug.LogException(e);
            SetMessage($"지급 실패: '{templateId}' (Resource ID/Publish/환경 확인)");
        }
        catch (Exception e)
        {
            Debug.LogException(e);
            SetMessage("지급 실패: 기타 예외");
        }
    }

    private string PickRandomId(string[] ids)
    {
        int index = UnityEngine.Random.Range(0, ids.Length);
        return (ids[index] ?? "").Trim();
    }

    // -------------------------
    // Cloud Code: Marketplace
    // -------------------------
    private async Task CreateListingAsync(string playersInventoryItemId, int price)
    {
        try
        {
            // ★ snake_case로 변경
            var args = new Dictionary<string, object>
            {
                { "players_inventory_item_id", playersInventoryItemId },
                { "price", price },
                { "currency_id", currencyId }
            };

            CreateListingResult res = await CloudCodeService.Instance.CallEndpointAsync<CreateListingResult>(
                "Mkt_CreateListing",
                args
            );

            SetMessage($"등록 완료: {res.listingId}");
            await RefreshAllAsync();
        }
        catch (Exception e)
        {
            Debug.LogException(e);
            SetMessage("등록 실패 (Cloud Code/권한/스크립트명/환경 확인)");
        }
    }

    private async Task RefreshMarketAsync()
    {
        try
        {
            ClearChildren(marketContent);

            var args = new Dictionary<string, object>
            {
                { "limit", marketLimit },
                { "sort", marketSort }
            };

            MarketListResult res = await CloudCodeService.Instance.CallEndpointAsync<MarketListResult>(
                "Mkt_GetActiveListings",
                args
            );

            if (res.listings == null)
            {
                SetMessage("거래소 목록 0개");
                return;
            }

            foreach (var listing in res.listings)
            {
                if (marketRowPrefab == null || marketContent == null)
                {
                    Debug.Log($"Listing: {listing.listingId} price={listing.price}");
                    continue;
                }

                MarketRowUI row = Instantiate(marketRowPrefab, marketContent);
                row.Bind(listing, BuyListingAsync, CancelListingAsync);
            }

            SetMessage($"거래소 로드: {res.listings.Length}개");
        }
        catch (Exception e)
        {
            Debug.LogException(e);
            SetMessage("거래소 조회 실패 (Cloud Code/스크립트명 확인)");
        }
    }

    private async Task BuyListingAsync(string listingId)
    {
        try
        {
            // ★ snake_case로 변경
            var args = new Dictionary<string, object> { { "listing_id", listingId } };

            BuyResult res = await CloudCodeService.Instance.CallEndpointAsync<BuyResult>(
                "Mkt_BuyListing",
                args
            );

            SetMessage($"구매 완료: newInstance={res.newPlayersInventoryItemId}");
            await RefreshAllAsync();
        }
        catch (Exception e)
        {
            Debug.LogException(e);
            SetMessage("구매 실패 (코인 부족/Listing 상태/Cloud Code 확인)");
        }
    }

    private async Task CancelListingAsync(string listingId)
    {
        try
        {
            // ★ snake_case로 변경
            var args = new Dictionary<string, object> { { "listing_id", listingId } };

            CancelResult res = await CloudCodeService.Instance.CallEndpointAsync<CancelResult>(
                "Mkt_CancelListing",
                args
            );

            SetMessage($"취소 완료: returnedInstance={res.returnedPlayersInventoryItemId}");
            await RefreshAllAsync();
        }
        catch (Exception e)
        {
            Debug.LogException(e);
            SetMessage("취소 실패 (판매자만 가능/상태 확인)");
        }
    }

    private async Task ClaimEarningsAsync()
    {
        try
        {
            // ★ snake_case로 변경
            var args = new Dictionary<string, object> { { "currency_id", currencyId } };

            ClaimResult res = await CloudCodeService.Instance.CallEndpointAsync<ClaimResult>(
                "Mkt_ClaimEarnings",
                args
            );

            SetMessage($"정산 수령: {res.claimed}");
            await RefreshAllAsync();
        }
        catch (Exception e)
        {
            Debug.LogException(e);
            SetMessage("정산 실패 (Cloud Code/스크립트명 확인)");
        }
    }

    private static void ClearChildren(Transform parent)
    {
        if (parent == null) return;

        for (int i = parent.childCount - 1; i >= 0; i--)
        {
            Destroy(parent.GetChild(i).gameObject);
        }
    }

    // -------------------------
    // DTOs
    // -------------------------
    [Serializable]
    public class CreateListingResult { public string listingId; }

    [Serializable]
    public class MarketListResult { public ListingDto[] listings; }

    [Serializable]
    public class ListingDto
    {
        public string listingId;
        public string status;
        public string sellerPlayerId;
        public string inventoryItemId;
        public Dictionary<string, object> instanceData;
        public string currencyId;
        public int price;
        public long createdAt;
    }

    [Serializable]
    public class BuyResult { public bool ok; public string newPlayersInventoryItemId; }

    [Serializable]
    public class CancelResult { public bool ok; public string returnedPlayersInventoryItemId; }

    [Serializable]
    public class ClaimResult { public bool ok; public int claimed; }
}