using Newtonsoft.Json.Linq;
using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;
using static UnityEngine.Rendering.DebugUI.Table;

/// <summary>
/// ListingRowView
///
/// 목적:
/// - MarketHomeController가 재사용하는 단일 Row 프리팹 뷰.
/// - Listing / Sell / History를 같은 Row로 표시할 수 있게 세 바인딩 함수를 제공.
/// - 클릭 이벤트는 외부에 event로 노출하지 않고 AddListener/RemoveListener 패턴만 제공.
/// - 폴백 로직이 동작하면 Warning 로그로 명확히 알림.
/// </summary>
public class ListingRowView : MonoBehaviour
{
    [Header("Common UI")]
    [SerializeField] private Button _button;
    [SerializeField] private Image _image;
    [SerializeField] private TextMeshProUGUI _title;
    [SerializeField] private TextMeshProUGUI _itemId;
    [SerializeField] private TextMeshProUGUI _instanceId;
    [SerializeField] private ItemStaticDatabase _itemStaticDatabase;

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

        if (!_itemStaticDatabase.TryGet(dto?.escrowItem?.templateKey, out var staticEntry))
        {
            Debug.LogWarning($"[ItemUI] 아이템 메타 없음: {dto?.escrowItem?.templateKey}");
            return;
        }

        if (staticEntry.Image)
        {
            _image.sprite = staticEntry.Image;
        }

        var title = Safe(staticEntry.ItemName);
        var sub = $"price = {dto.price:N0}";
        var right = $"status = {Safe(dto.status)}";

        SetTexts(title, sub, right);
    }

    public void BindTrade(TradeRecordDto dto)
    {
        if (dto == null)
        {
            Debug.LogWarning("[ListingRowView] BindTrade fallback 발생: dto is null");
            SetTexts("-", "-", "-");
            return;
        }

        if (!_itemStaticDatabase.TryGet(dto.templateKey, out var staticEntry))
        {
            Debug.LogWarning($"[ItemUI] 아이템 메타 없음: {dto.templateKey}");
            return;
        }

        if (staticEntry.Image)
        {
            _image.sprite = staticEntry.Image;
        }

        // 예시 표시 규칙:
        // Title: tradeId
        // Sub  : listingId / buyer / seller
        // Right: price + fee + status

        var title = Safe(staticEntry.ItemName);
        var sub = $"listing={Safe(dto.listingId)}  buyer={Safe(dto.buyerPlayerId)}  seller={Safe(dto.sellerPlayerId)}";
        var right = $"{dto.price:N0} (fee {(dto.price * 0.1f):N0})";
        sub = "";

        SetTexts(title, sub, right);
    }

    public void BindSell(JToken dto)
    {
        if (dto == null)
        {
            Debug.LogWarning("[ListingRowView] BindSell fallback 발생: dto is null");
            SetTexts("-", "-", "-");
            return;
        }

        if (SnapshotInstanceDeserializer.TryDeserializeFrag(dto, out var frag))
        {
            // FRAG 사용
        }

        if (SnapshotInstanceDeserializer.TryDeserializeEq(dto, out var eq))
        {
            // EQ 사용
        }

        string groupKey = "";
        string instanceId = "";
        string tradable = "";
        string templateKey = "";
        if (frag != null)
        {
            templateKey = frag.templateKey;
            groupKey = frag.groupKey;
            instanceId = frag.instanceId;
            tradable = frag.payload?.market?.tradable.ToString();
        }

        if (eq != null)
        {
            templateKey = eq.templateKey;
            groupKey = eq.groupKey;
            instanceId = eq.instanceId;
            tradable = eq.payload?.market?.tradable.ToString();
        }

        if (!_itemStaticDatabase.TryGet(templateKey, out var staticEntry))
        {
            Debug.LogWarning($"[ItemUI] 아이템 메타 없음: {groupKey}");
            return;
        }

        if (staticEntry.Image)
        {
            _image.sprite = staticEntry.Image;
        }

        var title = Safe(staticEntry.ItemName);
        //var sub = $"instanceId={instanceId}";
        //var right = $"tradable={tradable}";
        var sub = $"";
        var right = $"";

        SetTexts(title, sub, right);
    }

    private void HandleClick()
    {
        _onClick?.Invoke();
    }

    private void SetTexts(string title, string itemId, string instanceId)
    {
        if (_title != null) _title.text = title;
        if (_itemId != null) _itemId.text = itemId;
        if (_instanceId != null) _instanceId.text = instanceId;
    }

    private static string Safe(string s) => string.IsNullOrEmpty(s) ? "-" : s;
}
