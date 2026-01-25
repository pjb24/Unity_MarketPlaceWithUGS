using System;
using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// ListingRowView
///
/// 목적:
/// - MarketHomeController가 재사용하는 단일 Row 프리팹 뷰.
/// - Listing / Trade를 같은 Row로 표시할 수 있게 두 바인딩 함수를 제공.
/// - 클릭 이벤트는 외부에 event로 노출하지 않고 AddListener/RemoveListener 패턴만 제공.
/// - 폴백 로직이 동작하면 Warning 로그로 명확히 알림.
/// </summary>
public class ListingRowView : MonoBehaviour
{
    [Header("Common UI")]
    [SerializeField] private Button _button;
    [SerializeField] private Text _title;
    [SerializeField] private Text _sub;
    [SerializeField] private Text _right;

    private Action _onClick;

    private void Awake()
    {
        if (_button == null)
        {
            Debug.LogWarning("[ListingRowView] _button is null. Click disabled. (fallback 발생)");
            return;
        }

        _button.onClick.AddListener(HandleClick);
    }

    private void OnDestroy()
    {
        if (_button != null)
            _button.onClick.RemoveListener(HandleClick);
    }

    public void AddListener_OnClick(Action listener)
    {
        _onClick += listener;
    }

    public void RemoveListener_OnClick(Action listener)
    {
        _onClick -= listener;
    }

    public void BindListing(ListingDto dto)
    {
        if (dto == null)
        {
            Debug.LogWarning("[ListingRowView] BindListing fallback 발생: dto is null");
            SetTexts("-", "-", "-");
            return;
        }

        // 예시 표시 규칙:
        // Title: listingId
        // Sub  : itemInstanceId / seller
        // Right: price + status
        var title = Safe(dto.listingId);
        var sub = $"item={Safe(dto.itemInstanceId)}  seller={Safe(dto.sellerPlayerId)}";
        var right = $"{dto.price:N0}  {Safe(dto.status)}";

        SetTexts(title, sub, right);
    }

    public void BindTrade(TradeDto dto)
    {
        if (dto == null)
        {
            Debug.LogWarning("[ListingRowView] BindTrade fallback 발생: dto is null");
            SetTexts("-", "-", "-");
            return;
        }

        // 예시 표시 규칙:
        // Title: tradeId
        // Sub  : listingId / buyer / seller
        // Right: price + fee + status
        var title = Safe(dto.tradeId);
        var sub = $"listing={Safe(dto.listingId)}  buyer={Safe(dto.buyerPlayerId)}  seller={Safe(dto.sellerPlayerId)}";
        var right = $"{dto.price:N0} (fee {dto.feeTotal:N0})  {Safe(dto.status)}";

        SetTexts(title, sub, right);
    }

    private void HandleClick()
    {
        _onClick?.Invoke();
    }

    private void SetTexts(string title, string sub, string right)
    {
        if (_title != null) _title.text = title;
        if (_sub != null) _sub.text = sub;
        if (_right != null) _right.text = right;
    }

    private static string Safe(string s) => string.IsNullOrEmpty(s) ? "-" : s;
}
