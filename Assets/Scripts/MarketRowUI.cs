using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

public class MarketRowUI : MonoBehaviour
{
    [SerializeField] private TextMeshProUGUI titleText;
    [SerializeField] private TextMeshProUGUI priceText;
    [SerializeField] private Button buyBtn;
    [SerializeField] private Button cancelBtn;

    private string listingId;
    private Func<string, System.Threading.Tasks.Task> buyAsync;
    private Func<string, System.Threading.Tasks.Task> cancelAsync;

    public void Bind(
        PortfolioMarketDemo.ListingDto listing,
        Func<string, System.Threading.Tasks.Task> buyFunc,
        Func<string, System.Threading.Tasks.Task> cancelFunc)
    {
        listingId = listing.listingId;
        buyAsync = buyFunc;
        cancelAsync = cancelFunc;

        if (titleText != null) titleText.text = listing.inventoryItemId;
        if (priceText != null) priceText.text = $"{listing.price} {listing.currencyId}";

        if (buyBtn != null)
        {
            buyBtn.onClick.RemoveAllListeners();
            buyBtn.onClick.AddListener(() => _ = BuyAsync());
        }

        if (cancelBtn != null)
        {
            cancelBtn.onClick.RemoveAllListeners();
            cancelBtn.onClick.AddListener(() => _ = CancelAsync());
        }
    }

    private async System.Threading.Tasks.Task BuyAsync()
    {
        if (buyAsync == null) return;
        await buyAsync.Invoke(listingId);
    }

    private async System.Threading.Tasks.Task CancelAsync()
    {
        if (cancelAsync == null) return;
        await cancelAsync.Invoke(listingId);
    }
}
