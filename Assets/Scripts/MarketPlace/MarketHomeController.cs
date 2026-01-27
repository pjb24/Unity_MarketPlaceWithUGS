using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// MarketHomeController
///
/// 목적:
/// - 거래소 진입 시 MarketEnterFlow를 통해 서버 데이터를 로드하고,
///   홈 화면(지갑/탭/리스팅 목록/내 리스팅/거래내역)을 Unity UI로 갱신한다.
/// - 페이지네이션(nextPageToken)을 유지하고, Refresh / LoadMore를 제공한다.
/// - 부분 실패 시 빈 데이터로 폴백하되, 반드시 Warning 로그로 폴백 발생을 알린다.
///
/// 전제:
/// - MarketEnterFlow는 Cloud Code 엔드포인트(GetServerTime~GetTradeHistory) DTO/파라미터가 맞춰져 있어야 한다.
/// - 이 컨트롤러는 Unity UI(Button/Text/ScrollRect)를 인스펙터로 연결해서 사용한다.
/// </summary>
public class MarketHomeController : MonoBehaviour
{
    public static MarketHomeController instance;

    public enum E_Tab
    {
        Market = 0,
        Sell = 1,
        TradeHistory = 2
    }

    [Header("Deps")]
    [SerializeField] private MarketEnterFlow _enterFlow;

    [Header("Top Bar")]
    [SerializeField] private TextMeshProUGUI _textMtBalance;
    [SerializeField] private TextMeshProUGUI _textServerTimeIso;

    [Header("Tabs")]
    [SerializeField] private Button _btnTabMarket;
    [SerializeField] private Button _btnTabSell;
    [SerializeField] private Button _btnTabTradeHistory;

    [Header("Actions")]
    [SerializeField] private Button _btnRefresh;
    [SerializeField] private Button _btnLoadMore;
    [SerializeField] private Button _btnClaim;

    [Header("List UI")]
    [SerializeField] private ScrollRect _scroll;
    [SerializeField] private Transform _listRoot;
    [SerializeField] private ListingRowView _rowPrefab;

    [Header("Status UI")]
    [SerializeField] private GameObject _loadingOverlay;
    [SerializeField] private TextMeshProUGUI _textStatus;

    [Header("Inventory")]
    [SerializeField] private Transform _inventoryContent;
    [SerializeField] private InventoryRowUI _inventoryRowPrefab;

    [Header("Selected Item Data")]
    [SerializeField] private TMP_Text _infoTitle;
    [SerializeField] private Image _infoImage;
    [SerializeField] private TMP_Text _infoPrice;
    [SerializeField] private TMP_InputField _infoPriceInput;
    [SerializeField] private TMP_Text _infoFee;
    [SerializeField] private Button _infoBtnBuy;
    [SerializeField] private Button _infoBtnSell;

    [SerializeField] private TMP_Text _infoPriceText;
    [SerializeField] private TMP_Text _infoFeeText;

    [Header("Query Defaults")]
    [SerializeField] private string _marketStatus = "ACTIVE";
    [SerializeField] private string _marketSort = "CREATED_AT";
    [SerializeField] private string _marketOrder = "ASC";
    [SerializeField] private int _pageSize = 20;

    [Header("Default")]
    [SerializeField] private int _defaultExpiresInSeconds = 7 * 24 * 60 * 60; // 7 days
    [SerializeField] private bool _writeAuditLedger = false;            // 원장 “행위 로그”는 필요할 때만 켠다.
    [SerializeField] private string _mtCurrencyId = "MARKETTOKEN";      // WriteAuditLedger 켰을 때만 사용

    [Header("Runtime")]
    [SerializeField] private E_Tab _tab = E_Tab.Market;

    private CancellationTokenSource _cts;

    private MarketEnterResult _cache;
    public MarketEnterResult Cache => _cache;
    private MarketSellFlow _sellFlow = new MarketSellFlow();
    private MarketBuyFlow _buyFlow = new MarketBuyFlow();
    private MarketClaimFlow _claimFlow = new MarketClaimFlow();

    private string _cursorMarket;
    private string _cursorSell;
    private string _cursorTrade;

    private string _itemInstanceId;

    // internal "events" (외부 직접 노출 금지)
    private Action<ListingDto> _onClickListing;
    private Action<TradeRecordDto> _onClickTrade;
    private Action<JToken> _onClickSell;

    private Action<string> _onSellFailed;
    private Action<CreateListingResult> _onSellSuccess;

    private Action<string> _onBuyFailed;
    private Action<MarketBuyFlow.BuyResult> _onBuySuccess;
    
    private Action<string> _onClaimFailed;
    private Action<MarketClaimFlow.ClaimResult> _onClaimSuccess;

    private string _listingId;

    private void Awake()
    {
        instance = this;
    }

    private void OnEnable()
    {
        BindUi();
        BindEvents();

        UIController.instance.AddListenerOnLogin(OnClickRefresh);

        _infoPriceInput.onEndEdit.AddListener(OnPriceInputEndEdit);
    }

    private void OnDisable()
    {
        UnbindUi();
        CancelRunning();
        UnbindEvents();

        UIController.instance.RemoveListenerOnLogin(OnClickRefresh);

        _infoPriceInput.onEndEdit.RemoveListener(OnPriceInputEndEdit);
    }

    // ===== Listener Pattern (외부 event 직접 노출 금지) =====

    public void OnPriceInputEndEdit(string param)
    {
        float fee = float.Parse(param);
        fee *= 0.1f;

        _infoFee.text = Mathf.FloorToInt(fee).ToString();
    }

    public void AddListener_OnClickListing(Action<ListingDto> listener)
    {
        _onClickListing += listener;
    }

    public void RemoveListener_OnClickListing(Action<ListingDto> listener)
    {
        _onClickListing -= listener;
    }

    public void AddListener_OnClickTrade(Action<TradeRecordDto> listener)
    {
        _onClickTrade += listener;
    }

    public void RemoveListener_OnClickTrade(Action<TradeRecordDto> listener)
    {
        _onClickTrade -= listener;
    }

    public void AddListener_OnClickSell(Action<JToken> listener)
    {
        _onClickSell += listener;
    }

    public void RemoveListener_OnClickSell(Action<JToken> listener)
    {
        _onClickSell -= listener;
    }

    public void AddListener_OnSellSuccess(Action<CreateListingResult> listener)
    {
        _onSellSuccess += listener;
    }

    public void RemoveListener_OnSellSuccess(Action<CreateListingResult> listener)
    {
        _onSellSuccess -= listener;
    }

    public void AddListener_OnSellFailed(Action<string> listener)
    {
        _onSellFailed += listener;
    }

    public void RemoveListener_OnSellFailed(Action<string> listener)
    {
        _onSellFailed -= listener;
    }

    public void OnClickListingRow(ListingDto dto)
    {
        _infoTitle.gameObject.SetActive(true);
        _infoImage.gameObject.SetActive(true);
        _infoPrice.gameObject.SetActive(true);
        _infoPriceInput.gameObject.SetActive(false);
        _infoFee.gameObject.SetActive(false);
        _infoBtnBuy.gameObject.SetActive(true);
        _infoBtnSell.gameObject.SetActive(false);

        _infoPriceText.gameObject.SetActive(true);
        _infoFeeText.gameObject.SetActive(false);

        _infoTitle.text = dto.itemInstanceId;
        // _infoImage
        _infoPrice.text = dto.price.ToString();

        _listingId = dto.listingId;
    }

    public void OnClickTradeRow(TradeRecordDto dto)
    {
        _infoTitle.gameObject.SetActive(true);
        _infoImage.gameObject.SetActive(true);
        _infoPrice.gameObject.SetActive(true);
        _infoPriceInput.gameObject.SetActive(false);
        _infoFee.gameObject.SetActive(true);
        _infoBtnBuy.gameObject.SetActive(false);
        _infoBtnSell.gameObject.SetActive(false);

        _infoPriceText.gameObject.SetActive(true);
        _infoFeeText.gameObject.SetActive(false);

        _infoTitle.text = dto.listingId;
        // _infoImage
        _infoPrice.text = dto.price.ToString();
        _infoFee.text = (dto.price * 0.1f).ToString();
    }

    public void OnClickSellRow(JToken dto)
    {
        _infoTitle.gameObject.SetActive(true);
        _infoImage.gameObject.SetActive(true);
        _infoPrice.gameObject.SetActive(false);
        _infoPriceInput.gameObject.SetActive(true);
        _infoFee.gameObject.SetActive(true);
        _infoBtnBuy.gameObject.SetActive(false);
        _infoBtnSell.gameObject.SetActive(true);

        _infoPriceText.gameObject.SetActive(true);
        _infoFeeText.gameObject.SetActive(true);

        if (SnapshotInstanceDeserializer.TryDeserializeFrag(dto, out var frag))
        {
            // FRAG 사용
            Debug.Log($"FRAG {frag.instanceId} skill={frag.payload.skillId}");
        }

        if (SnapshotInstanceDeserializer.TryDeserializeEq(dto, out var eq))
        {
            // EQ 사용
            Debug.Log($"EQ {eq.instanceId} state={eq.payload.state}");
        }

        if (frag != null)
        {
            _infoTitle.text = frag.instanceId;
            _itemInstanceId = frag.instanceId;
        }
        if (eq != null)
        {
            _infoTitle.text = eq.instanceId;
            _itemInstanceId = eq.instanceId;
        }

        // _infoImage
        _infoFee.text = "0";
    }

    // ===== Public Entry =====

    public async void EnterMarket()
    {
        if (_enterFlow == null)
        {
            Debug.LogError("[MarketHome] _enterFlow is null.");
            return;
        }

        CancelRunning();
        _cts = new CancellationTokenSource();

        SetLoading(true, "Loading...");

        try
        {
            var result = await _enterFlow.EnterMarketAsync(_cts.Token);

            _cache = result;

            _cursorMarket = result.MarketListings?.nextPageToken;
            _cursorSell = result.MyListings?.nextPageToken;
            _cursorTrade = result.TradeHistory?.nextPageToken;

            RefreshInventory(result.InventorySnapshot);
            ApplyTopBar(result);
            ApplyTab(_tab, resetScroll: true);

            SetLoading(false, result.HasPartialFailures ? "Loaded with partial failures." : "Loaded.");
        }
        catch (Exception ex)
        {
            SetLoading(false, "Load failed.");
            Debug.LogError($"[MarketHome] EnterMarket exception: {ex}");
        }
    }

    // ===== UI Actions =====

    private void OnClickRefresh()
    {
        EnterMarket();
    }

    private void OnClickLoadMore()
    {
        // 이 프로젝트 범위에서는 “진입”에 필요한 7개 엔드포인트만 사용하므로
        // LoadMore는 같은 엔드포인트를 pageToken만 바꿔 호출해야 한다.
        // MarketEnterFlow는 현재 EnterMarketAsync만 제공하므로,
        // 여기서는 폴백: LoadMore를 막고 Warning 로그를 남긴다.
        //
        // 확장하려면 MarketEnterFlow에
        // - QueryListingsPageAsync(pageToken)
        // - GetMyListingsPageAsync(pageToken)
        // - GetTradeHistoryPageAsync(pageToken)
        // 를 추가해야 한다.

        Debug.LogWarning("[MarketHome] LoadMore fallback 발생: MarketEnterFlow에 page API가 없어 LoadMore를 수행할 수 없다.");
        SetStatus("LoadMore not available (fallback).");
    }

    private void OnClickTabMarket()
    {
        _tab = E_Tab.Market;
        ApplyTab(_tab, resetScroll: true);
    }

    private void OnClickTabSell()
    {
        _tab = E_Tab.Sell;
        ApplyTab(_tab, resetScroll: true);
    }

    private void OnClickTabTradeHistory()
    {
        _tab = E_Tab.TradeHistory;
        ApplyTab(_tab, resetScroll: true);
    }

    // ===== Rendering =====

    private void RefreshInventory(GetInventorySnapshotResponseDto dto)
    {
        foreach (var inst in dto.view.instances)
        {
            if (inst == null) continue;

            InventoryRowUI row = Instantiate(_inventoryRowPrefab, _inventoryContent);

            // title/instance/option은 InventoryRowUI 내부에서 표시하므로
            // 여기서는 Economy PlayersInventoryItem 대신, 인벤 DTO에서 필요한 최소 정보만 전달.
            // InventoryRowUI를 DTO 기반으로 바꿔야 한다.
            row.Bind(
                item: inst
            );
        }
    }

    private void ApplyTopBar(MarketEnterResult result)
    {
        if (_textServerTimeIso != null)
            _textServerTimeIso.text = result.ServerTime?.serverTime?.iso ?? "-";

        // GetWallet.js: currencies[currencyId]={balance, writeLock}
        double mt = 0;

        if (result.Wallet != null && result.Wallet.currencies != null)
        {
            var mtId = result.Config?.config?.currency?.mtCurrencyId;

            if (!string.IsNullOrEmpty(mtId) && result.Wallet.currencies.TryGetValue(mtId, out var mtBal) && mtBal != null)
                mt = mtBal.balance;
        }
        else
        {
            Debug.LogWarning("[MarketHome] Wallet missing. fallback 발생");
        }

        if (_textMtBalance != null) _textMtBalance.text = mt.ToString("N0");
    }

    private void ApplyTab(E_Tab tab, bool resetScroll)
    {
        ClearList();

        if (_cache == null)
        {
            Debug.LogWarning("[MarketHome] No cache. fallback 발생");
            SetStatus("No data (fallback).");
            return;
        }

        switch (tab)
        {
            case E_Tab.Market:
                UIController.instance.UIUpdateTradeTab();
                RenderListings(_cache.MarketListings?.items, "No listings.");
                SetLoadMoreVisible(!string.IsNullOrEmpty(_cursorMarket));
                break;

            case E_Tab.Sell:
                UIController.instance.UIUpdateSellTab();
                RenderInventory(_cache.InventorySnapshot?.snapshot?.instances, "No items in inventory.");
                SetLoadMoreVisible(!string.IsNullOrEmpty(_cursorSell));
                break;

            case E_Tab.TradeHistory:
                UIController.instance.UIUpdateHistoryTab();
                RenderTrades(_cache.TradeHistory?.items, "No trade history.");
                SetLoadMoreVisible(!string.IsNullOrEmpty(_cursorTrade));
                break;
        }

        if (resetScroll && _scroll != null)
            _scroll.verticalNormalizedPosition = 1f;
    }

    private void RenderListings(List<ListingDto> items, string emptyMsg)
    {
        if (items == null || items.Count == 0)
        {
            SetStatus(emptyMsg);
            return;
        }

        SetStatus(string.Empty);

        for (int i = 0; i < items.Count; i++)
        {
            var dto = items[i];
            if (dto == null) continue;

            var row = InstantiateRow();
            if (row == null) return;

            row.BindListing(dto);
            row.AddListener_OnClick(() => _onClickListing?.Invoke(dto));
        }
    }

    private void RenderTrades(List<TradeRecordDto> items, string emptyMsg)
    {
        if (items == null || items.Count == 0)
        {
            SetStatus(emptyMsg);
            return;
        }

        SetStatus(string.Empty);

        for (int i = 0; i < items.Count; i++)
        {
            var dto = items[i];
            if (dto == null) continue;

            var row = InstantiateRow();
            if (row == null) return;

            row.BindTrade(dto);
            row.AddListener_OnClick(() => _onClickTrade?.Invoke(dto));
        }
    }

    private void RenderInventory(List<JToken> items, string emptyMsg)
    {
        if (items == null || items.Count == 0)
        {
            SetStatus(emptyMsg);
            return;
        }

        SetStatus(string.Empty);

        for (int i = 0; i < items.Count; i++)
        {
            var dto = items[i];
            if (dto == null) continue;

            var row = InstantiateRow();
            if (row == null) return;

            row.BindSell(dto);
            row.AddListener_OnClick(() => _onClickSell?.Invoke(dto));
        }
    }

    private ListingRowView InstantiateRow()
    {
        if (_rowPrefab == null || _listRoot == null)
        {
            Debug.LogError("[MarketHome] Row prefab/root not set.");
            return null;
        }

        return Instantiate(_rowPrefab, _listRoot);
    }

    private void ClearList()
    {
        if (_listRoot == null) return;

        for (int i = _listRoot.childCount - 1; i >= 0; i--)
        {
            var go = _listRoot.GetChild(i).gameObject;
            Destroy(go);
        }
    }

    private void SetLoading(bool on, string status)
    {
        if (_loadingOverlay != null)
            _loadingOverlay.SetActive(on);

        SetStatus(status);
    }

    private void SetStatus(string msg)
    {
        if (_textStatus != null)
            _textStatus.text = msg ?? string.Empty;
    }

    private void SetLoadMoreVisible(bool on)
    {
        if (_btnLoadMore != null)
            _btnLoadMore.gameObject.SetActive(on);
    }

    // ===== UI Bind =====

    private void BindUi()
    {
        if (_btnRefresh != null) _btnRefresh.onClick.AddListener(OnClickRefresh);
        if (_btnLoadMore != null) _btnLoadMore.onClick.AddListener(OnClickLoadMore);

        if (_btnTabMarket != null) _btnTabMarket.onClick.AddListener(OnClickTabMarket);
        if (_btnTabSell != null) _btnTabSell.onClick.AddListener(OnClickTabSell);
        if (_btnTabTradeHistory != null) _btnTabTradeHistory.onClick.AddListener(OnClickTabTradeHistory);

        if (_infoBtnSell != null) _infoBtnSell.onClick.AddListener(OnClickSell);
        if (_infoBtnBuy != null) _infoBtnBuy.onClick.AddListener(OnClickBuy);

        if (_btnClaim != null) _btnClaim.onClick.AddListener(OnClickClaim);
    }

    private void UnbindUi()
    {
        if (_btnRefresh != null) _btnRefresh.onClick.RemoveListener(OnClickRefresh);
        if (_btnLoadMore != null) _btnLoadMore.onClick.RemoveListener(OnClickLoadMore);

        if (_btnTabMarket != null) _btnTabMarket.onClick.RemoveListener(OnClickTabMarket);
        if (_btnTabSell != null) _btnTabSell.onClick.RemoveListener(OnClickTabSell);
        if (_btnTabTradeHistory != null) _btnTabTradeHistory.onClick.RemoveListener(OnClickTabTradeHistory);

        if (_infoBtnSell != null) _infoBtnSell.onClick.RemoveListener(OnClickSell);
        if (_infoBtnBuy != null) _infoBtnBuy.onClick.RemoveListener(OnClickBuy);

        if (_btnClaim != null) _btnClaim.onClick.RemoveListener(OnClickClaim);
    }

    private void BindEvents()
    {
        AddListener_OnClickListing(OnClickListingRow);
        AddListener_OnClickTrade(OnClickTradeRow);
        AddListener_OnClickSell(OnClickSellRow);
    }

    private void UnbindEvents()
    {
        RemoveListener_OnClickListing(OnClickListingRow);
        RemoveListener_OnClickTrade(OnClickTradeRow);
        RemoveListener_OnClickSell(OnClickSellRow);
    }

    // ===== Lifecycle helpers =====

    private void CancelRunning()
    {
        if (_cts == null) return;
        _cts.Cancel();
        _cts.Dispose();
        _cts = null;
    }

    private void OnClickSell()
    {
        _ = SellAsync();
    }

    private void OnClickBuy()
    {
        _ = BuyAsync();
    }

    private void OnClickClaim()
    {
        _ = ClaimAsync();
    }

    private async Task SellAsync()
    {
        if (_sellFlow == null)
        {
            Debug.LogError("[SellPage] _sellFlow is null.");
            SetStatus("Sell failed: missing flow.");
            _onSellFailed?.Invoke("missing_flow");
            return;
        }

        string itemInstanceId = _itemInstanceId != null ? _itemInstanceId.Trim() : null;
        if (string.IsNullOrEmpty(itemInstanceId))
        {
            Debug.LogWarning("[SellPage] Sell fallback 발생: itemInstanceId is empty.");
            SetStatus("아이템을 선택해라.");
            _onSellFailed?.Invoke("empty_item");
            return;
        }

        if (!TryParsePrice(out double price))
        {
            Debug.LogWarning("[SellPage] Sell fallback 발생: price parse failed.");
            SetStatus("가격이 잘못됐다.");
            _onSellFailed?.Invoke("bad_price");
            return;
        }

        CancelRunning();
        _cts = new CancellationTokenSource();

        SetLoading(true, "등록 중...");

        try
        {
            var req = new MarketSellFlow.SellRequest
            {
                ItemInstanceId = itemInstanceId,
                Price = price,
                ExpiresInSeconds = _defaultExpiresInSeconds,

                WriteAuditLedger = _writeAuditLedger,
                MtCurrencyId = _mtCurrencyId
            };

            var res = await _sellFlow.SellAsync(req, _cts.Token);

            if (!res.Ok || res.Listing == null)
            {
                var msg = $"Sell failed at {res.FailStep}: {res.FailMessage}";
                Debug.LogWarning($"[SellPage] {msg}");
                SetStatus("등록 실패.");
                _onSellFailed?.Invoke(res.FailStep ?? "sell_failed");
                return;
            }

            SetStatus($"등록 완료: {res.Listing.listingId}");
            _onSellSuccess?.Invoke(res.Listing);

            // 성공 후 UI 정리(선호에 맞게 수정)
            // - 아이템 입력칸 비우기 / 가격 유지 등
            // 여기선 기본: 아이템만 비움
        }
        catch (OperationCanceledException)
        {
            Debug.LogWarning("[SellPage] Sell canceled.");
            SetStatus("취소됨.");
            _onSellFailed?.Invoke("canceled");
        }
        catch (Exception ex)
        {
            Debug.LogError($"[SellPage] Sell exception: {ex}");
            SetStatus("등록 실패.");
            _onSellFailed?.Invoke("exception");
        }
        finally
        {
            SetLoading(false, string.Empty);
        }
    }

    private async Task BuyAsync()
    {
        if (_buyFlow == null)
        {
            Debug.LogError("[BuyPage] _buyFlow is null.");
            SetStatus("Buy failed: missing flow.");
            _onBuyFailed?.Invoke("missing_flow");
            return;
        }

        string listingId = _listingId != null ? _listingId.Trim() : null;
        if (string.IsNullOrEmpty(listingId))
        {
            Debug.LogWarning("[BuyPage] Buy fallback 발생: listingId is empty.");
            SetStatus("리스팅을 선택해라.");
            _onBuyFailed?.Invoke("empty_listing");
            return;
        }

        CancelRunning();
        _cts = new CancellationTokenSource();

        SetLoading(true, "구매 중...");

        try
        {
            var req = new MarketBuyFlow.BuyRequest
            {
                listingId = listingId,

                // listingsCustomId = "market_listings",
                // indexesCustomId = "market_indexes",
                // escrowCustomId = "escrow",
                // tradesCustomId = "market_trades",
                // lockCustomId = "txnlocks",
                // nowIso = "",
                // requirePrice = 0,
                // ttlSeconds = 10,
                // dryRun = false,
            };

            var res = await _buyFlow.BuyAsync(req, _cts.Token);

            if (!res.Ok || res.Bought == null || string.IsNullOrEmpty(res.Bought.listingId))
            {
                var msg = $"Buy failed at {res.FailStep}: {res.FailMessage}";
                Debug.LogWarning($"[BuyPage] {msg}");
                SetStatus("구매 실패.");
                _onBuyFailed?.Invoke(res.FailStep ?? "buy_failed");
                return;
            }

            SetStatus($"구매 완료: {res.Bought.listingId}");
            _onBuySuccess?.Invoke(res);

            // 성공 후 UI 정리(선호에 맞게 수정)
            // 여기선 기본: listingId만 비움
            _listingId = string.Empty;
        }
        catch (OperationCanceledException)
        {
            Debug.LogWarning("[BuyPage] Buy canceled.");
            SetStatus("취소됨.");
            _onBuyFailed?.Invoke("canceled");
        }
        catch (Exception ex)
        {
            Debug.LogError($"[BuyPage] Buy exception: {ex}");
            SetStatus("구매 실패.");
            _onBuyFailed?.Invoke("exception");
        }
        finally
        {
            SetLoading(false, string.Empty);
        }
    }

    private async Task ClaimAsync()
    {
        if (_claimFlow == null)
        {
            Debug.LogError("[ClaimPage] _claimFlow is null.");
            SetStatus("Claim failed: missing flow.");
            _onClaimFailed?.Invoke("missing_flow");
            return;
        }

        string currencyId = _mtCurrencyId != null ? _mtCurrencyId.Trim() : null;
        if (string.IsNullOrEmpty(currencyId))
        {
            Debug.LogWarning("[ClaimPage] Claim fallback 발생: currencyId is empty.");
            SetStatus("통화가 설정되지 않았다.");
            _onClaimFailed?.Invoke("empty_currency");
            return;
        }

        CancelRunning();
        _cts = new CancellationTokenSource();

        SetLoading(true, "정산 중...");

        try
        {
            var req = new MarketClaimFlow.ClaimRequest
            {
                currencyId = currencyId,

                // 선택(기본값을 서버 스크립트가 갖고 있어도 됨)
                // proceedsCustomId = "market_proceeds",
                // lockCustomId = "txnlocks",
                // ttlSeconds = 10,
                // dryRun = false,
                // minClaimAmount = 0,
            };

            var res = await _claimFlow.ClaimAsync(req, _cts.Token);

            if (!res.Ok)
            {
                var msg = $"Claim failed: {res.ErrorCode} {res.ErrorMessage}";
                Debug.LogWarning($"[ClaimPage] {msg}");
                SetStatus("정산 실패.");
                _onClaimFailed?.Invoke(res.ErrorCode ?? "claim_failed");
                return;
            }

            // claimedAmount==0 은 정상 케이스 (정산할 금액 없음)
            if (res.Data.claimedAmount <= 0)
            {
                SetStatus("정산할 금액이 없다.");
                _onClaimSuccess?.Invoke(res);
                return;
            }

            SetStatus($"정산 완료: +{res.Data.claimedAmount} {res.Data.currencyId}");
            _onClaimSuccess?.Invoke(res);
        }
        catch (OperationCanceledException)
        {
            Debug.LogWarning("[ClaimPage] Claim canceled.");
            SetStatus("취소됨.");
            _onClaimFailed?.Invoke("canceled");
        }
        catch (Exception ex)
        {
            Debug.LogError($"[ClaimPage] Claim exception: {ex}");
            SetStatus("정산 실패.");
            _onClaimFailed?.Invoke("exception");
        }
        finally
        {
            SetLoading(false, string.Empty);
        }
    }

    private bool TryParsePrice(out double price)
    {
        price = 0;

        if (_infoPriceInput == null)
            return false;

        var s = _infoPriceInput.text?.Trim();
        if (string.IsNullOrEmpty(s))
            return false;

        // InvariantCulture로 고정(소수점 구분자 혼선 방지)
        if (!double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out price))
            return false;

        if (double.IsNaN(price) || double.IsInfinity(price))
            return false;

        return price > 0;
    }
}
