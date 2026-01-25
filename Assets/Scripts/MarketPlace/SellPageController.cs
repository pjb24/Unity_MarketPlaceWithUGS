using System;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// SellPageController
///
/// 목적:
/// - Unity 클라이언트에서 Cloud Code(판매 등록 관련 JS)를 호출해 판매 등록을 수행한다.
/// - 입력(아이템ID/가격) 검증, 로딩 UI, 결과 반영, 실패 시 명확한 Warning 로그를 남긴다.
///
/// 전제:
/// - MarketSellFlow (SellAsync) 가 프로젝트에 존재해야 한다.
/// - CreateListing은 서버에서 아이템 검증/에스크로/리스팅/인덱스까지 오케스트레이션한다.
/// </summary>
public class SellPageController : MonoBehaviour
{
    [Header("Deps")]
    [SerializeField] private MarketSellFlow _sellFlow;

    [Header("Inputs")]
    [SerializeField] private InputField _inputItemInstanceId;
    [SerializeField] private InputField _inputPrice;

    [Header("Buttons")]
    [SerializeField] private Button _btnSell;
    [SerializeField] private Button _btnClose;
    [SerializeField] private Button _btnBack;

    [Header("UI")]
    [SerializeField] private Text _textSelectedItem;
    [SerializeField] private Text _textStatus;
    [SerializeField] private GameObject _loadingOverlay;

    [Header("Defaults")]
    [SerializeField] private int _defaultExpiresInSeconds = 7 * 24 * 60 * 60; // 7 days
    [SerializeField] private bool _writeAuditLedger = false;                 // 원장 “행위 로그”는 필요할 때만 켠다.
    [SerializeField] private string _mtCurrencyId = "MT";                    // WriteAuditLedger 켰을 때만 사용

    private CancellationTokenSource _cts;

    // internal "events" (외부 직접 노출 금지)
    private Action<CreateListingResult> _onSellSuccess;
    private Action<string> _onSellFailed;

    private void OnEnable()
    {
        BindUi();
        SetLoading(false);
        SetStatus(string.Empty);
        RefreshSelectedItemLabel();
    }

    private void OnDisable()
    {
        UnbindUi();
        CancelRunning();
    }

    // ===== Listener Pattern (외부 event 직접 노출 금지) =====

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

    // ===== Public API =====

    public void Open(string itemInstanceId = null, double? suggestedPrice = null)
    {
        gameObject.SetActive(true);

        if (!string.IsNullOrEmpty(itemInstanceId) && _inputItemInstanceId != null)
            _inputItemInstanceId.text = itemInstanceId;

        if (suggestedPrice.HasValue && _inputPrice != null)
            _inputPrice.text = suggestedPrice.Value.ToString(CultureInfo.InvariantCulture);

        RefreshSelectedItemLabel();
        SetStatus(string.Empty);
    }

    public void Close()
    {
        gameObject.SetActive(false);
    }

    public void SetSelectedItem(string itemInstanceId)
    {
        if (_inputItemInstanceId == null)
        {
            Debug.LogWarning("[SellPage] SetSelectedItem fallback 발생: _inputItemInstanceId is null.");
            return;
        }

        _inputItemInstanceId.text = itemInstanceId ?? string.Empty;
        RefreshSelectedItemLabel();
    }

    // ===== UI Binding =====

    private void BindUi()
    {
        if (_btnSell != null) _btnSell.onClick.AddListener(OnClickSell);
        if (_btnClose != null) _btnClose.onClick.AddListener(OnClickClose);
        if (_btnBack != null) _btnBack.onClick.AddListener(OnClickBack);

        if (_inputItemInstanceId != null) _inputItemInstanceId.onValueChanged.AddListener(_ => RefreshSelectedItemLabel());
    }

    private void UnbindUi()
    {
        if (_btnSell != null) _btnSell.onClick.RemoveListener(OnClickSell);
        if (_btnClose != null) _btnClose.onClick.RemoveListener(OnClickClose);
        if (_btnBack != null) _btnBack.onClick.RemoveListener(OnClickBack);

        if (_inputItemInstanceId != null) _inputItemInstanceId.onValueChanged.RemoveAllListeners();
    }

    private void CancelRunning()
    {
        if (_cts != null)
        {
            _cts.Cancel();
            _cts.Dispose();
            _cts = null;
        }
    }

    // ===== Actions =====

    private void OnClickClose()
    {
        Close();
    }

    private void OnClickBack()
    {
        // 프로젝트 내 네비게이션이 있다면 여기서 페이지 전환 호출
        Close();
    }

    private void OnClickSell()
    {
        _ = SellAsync();
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

        string itemInstanceId = _inputItemInstanceId != null ? _inputItemInstanceId.text?.Trim() : null;
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

        SetLoading(true);
        SetStatus("등록 중...");

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
            if (_inputItemInstanceId != null) _inputItemInstanceId.text = string.Empty;
            RefreshSelectedItemLabel();
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
            SetLoading(false);
        }
    }

    // ===== Helpers =====

    private bool TryParsePrice(out double price)
    {
        price = 0;

        if (_inputPrice == null)
            return false;

        var s = _inputPrice.text?.Trim();
        if (string.IsNullOrEmpty(s))
            return false;

        // InvariantCulture로 고정(소수점 구분자 혼선 방지)
        if (!double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out price))
            return false;

        if (double.IsNaN(price) || double.IsInfinity(price))
            return false;

        return price > 0;
    }

    private void RefreshSelectedItemLabel()
    {
        if (_textSelectedItem == null) return;

        var id = _inputItemInstanceId != null ? _inputItemInstanceId.text?.Trim() : null;
        _textSelectedItem.text = string.IsNullOrEmpty(id) ? "선택된 아이템: -" : $"선택된 아이템: {id}";
    }

    private void SetLoading(bool on)
    {
        if (_loadingOverlay != null)
            _loadingOverlay.SetActive(on);

        if (_btnSell != null)
            _btnSell.interactable = !on;
    }

    private void SetStatus(string msg)
    {
        if (_textStatus != null)
            _textStatus.text = msg ?? string.Empty;
    }
}
