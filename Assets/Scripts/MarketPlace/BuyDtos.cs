using System;

[Serializable]
public sealed class BuyListingResult
{
    public string listingId;
    public string status;          // "SOLD"
    public double price;
    public string currencyId;

    public double feeAmount;
    public double sellerReceives;

    public string soldAt;
    public string itemInstanceId;
}
