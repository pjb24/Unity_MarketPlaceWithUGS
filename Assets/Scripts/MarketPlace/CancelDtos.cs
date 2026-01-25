using System;

[Serializable]
public sealed class GetListingResult
{
    public string listingId;
    public string listingKey;

    // listing / escrow는 서버 JSON을 그대로 받기 위해 object로 둔다.
    // 필요하면 ListingDto/EscrowDto로 확장해도 됨.
    public object listing;
    public object escrow;
}

[Serializable]
public sealed class CancelListingResult
{
    public string listingId;
    public string listingKey;
    public string escrowKey;

    public string status; // "CANCELED"
    public string canceledAt;

    public string restoredItemInstanceId; // 에스크로 없으면 null 가능
}
