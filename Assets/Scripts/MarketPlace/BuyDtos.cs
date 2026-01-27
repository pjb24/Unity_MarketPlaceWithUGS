using System;

[Serializable]
public sealed class BuyListingResult
{
    public bool ok;

    // error (ok=false)
    public string errorCode;
    public string errorMessage;

    // success (ok=true)
    public bool dryRun;

    public string listingId;
    public string tradeId;

    public string itemInstanceId;
    public double price;
    public string currencyId;

    public string sellerPlayerId;
    public string buyerPlayerId;

    public string nowIso;
    public string proceedsKey;

    public BuyListingFeeDto fee;
}

[Serializable]
public sealed class BuyListingFeeDto
{
    public double feeRateTotal;
    public double feeRatePool;

    public double sellerCredit;
    public double poolCredit;
    public double burnAmount;
}
