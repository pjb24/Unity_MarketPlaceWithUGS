using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
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
    public enum E_Tab
    {
        Market = 0,
        MyListings = 1,
        TradeHistory = 2
    }

    [Header("Deps")]
    [SerializeField] private MarketEnterFlow _enterFlow;

    [Header("Top Bar")]
    [SerializeField] private Text _textMtBalance;
    [SerializeField] private Text _textEcBalance;
    [SerializeField] private Text _textServerTimeIso;

    [Header("Tabs")]
    [SerializeField] private Button _btnTabMarket;
    [SerializeField] private Button _btnTabMyListings;
    [SerializeField] private Button _btnTabTradeHistory;

    [Header("Actions")]
    [SerializeField] private Button _btnRefresh;
    [SerializeField] private Button _btnLoadMore;

    [Header("List UI")]
    [SerializeField] private ScrollRect _scroll;
    [SerializeField] private Transform _listRoot;
    [SerializeField] private ListingRowView _rowPrefab;

    [Header("Status UI")]
    [SerializeField] private GameObject _loadingOverlay;
    [SerializeField] private Text _textStatus;

    [Header("Query Defaults")]
    [SerializeField] private string _marketStatus = "ACTIVE";
    [SerializeField] private string _marketSort = "CREATED_AT";
    [SerializeField] private string _marketOrder = "ASC";
    [SerializeField] private int _pageSize = 20;

    [Header("Runtime")]
    [SerializeField] private E_Tab _tab = E_Tab.Market;

    private CancellationTokenSource _cts;

    private MarketEnterResult _cache;

    private string _cursorMarket;
    private string _cursorMy;
    private string _cursorTrade;

    // internal "events" (외부 직접 노출 금지)
    private Action<ListingDto> _onClickListing;
    private Action<TradeDto> _onClickTrade;

    private void OnEnable()
    {
        BindUi();
    }

    private void OnDisable()
    {
        UnbindUi();
        CancelRunning();
    }

    // ===== Listener Pattern (외부 event 직접 노출 금지) =====

    public void AddListener_OnClickListing(Action<ListingDto> listener)
    {
        _onClickListing += listener;
    }

    public void RemoveListener_OnClickListing(Action<ListingDto> listener)
    {
        _onClickListing -= listener;
    }

    public void AddListener_OnClickTrade(Action<TradeDto> listener)
    {
        _onClickTrade += listener;
    }

    public void RemoveListener_OnClickTrade(Action<TradeDto> listener)
    {
        _onClickTrade -= listener;
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
            _cursorMy = result.MyListings?.nextPageToken;
            _cursorTrade = result.TradeHistory?.nextPageToken;

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

    private void OnClickTabMyListings()
    {
        _tab = E_Tab.MyListings;
        ApplyTab(_tab, resetScroll: true);
    }

    private void OnClickTabTradeHistory()
    {
        _tab = E_Tab.TradeHistory;
        ApplyTab(_tab, resetScroll: true);
    }

    // ===== Rendering =====

    private void ApplyTopBar(MarketEnterResult result)
    {
        if (_textServerTimeIso != null)
            _textServerTimeIso.text = result.ServerTime?.serverTime?.iso ?? "-";

        // GetWallet.js: currencies[currencyId]={balance, writeLock}
        double mt = 0;
        double ec = 0;

        if (result.Wallet != null && result.Wallet.currencies != null)
        {
            var mtId = result.Config?.config?.currency?.mtCurrencyId;
            var ecId = result.Config?.config?.currency?.ecCurrencyId;

            if (!string.IsNullOrEmpty(mtId) && result.Wallet.currencies.TryGetValue(mtId, out var mtBal) && mtBal != null)
                mt = mtBal.balance;

            if (!string.IsNullOrEmpty(ecId) && result.Wallet.currencies.TryGetValue(ecId, out var ecBal) && ecBal != null)
                ec = ecBal.balance;
        }
        else
        {
            Debug.LogWarning("[MarketHome] Wallet missing. fallback 발생");
        }

        if (_textMtBalance != null) _textMtBalance.text = mt.ToString("N0");
        if (_textEcBalance != null) _textEcBalance.text = ec.ToString("N0");
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
                RenderListings(_cache.MarketListings?.items, "No listings.");
                SetLoadMoreVisible(!string.IsNullOrEmpty(_cursorMarket));
                break;

            case E_Tab.MyListings:
                RenderListings(_cache.MyListings?.items, "No my listings.");
                SetLoadMoreVisible(!string.IsNullOrEmpty(_cursorMy));
                break;

            case E_Tab.TradeHistory:
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

    private void RenderTrades(List<TradeDto> items, string emptyMsg)
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
        if (_btnTabMyListings != null) _btnTabMyListings.onClick.AddListener(OnClickTabMyListings);
        if (_btnTabTradeHistory != null) _btnTabTradeHistory.onClick.AddListener(OnClickTabTradeHistory);
    }

    private void UnbindUi()
    {
        if (_btnRefresh != null) _btnRefresh.onClick.RemoveListener(OnClickRefresh);
        if (_btnLoadMore != null) _btnLoadMore.onClick.RemoveListener(OnClickLoadMore);

        if (_btnTabMarket != null) _btnTabMarket.onClick.RemoveListener(OnClickTabMarket);
        if (_btnTabMyListings != null) _btnTabMyListings.onClick.RemoveListener(OnClickTabMyListings);
        if (_btnTabTradeHistory != null) _btnTabTradeHistory.onClick.RemoveListener(OnClickTabTradeHistory);
    }

    // ===== Lifecycle helpers =====

    private void CancelRunning()
    {
        if (_cts == null) return;
        _cts.Cancel();
        _cts.Dispose();
        _cts = null;
    }
}
