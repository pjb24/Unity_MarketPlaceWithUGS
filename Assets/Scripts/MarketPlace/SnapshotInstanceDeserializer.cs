using Newtonsoft.Json.Linq;
using System;

public static class SnapshotInstanceDeserializer
{
    public static bool TryDeserializeFrag(JToken raw, out FragInstanceDto dto)
    {
        dto = null;
        if (raw == null || raw.Type == JTokenType.Null) return false;

        var kind = raw.Value<string>("kind");
        if (!string.Equals(kind, "FRAG", StringComparison.OrdinalIgnoreCase)) return false;

        dto = raw.ToObject<FragInstanceDto>();
        return dto != null;
    }

    public static bool TryDeserializeEq(JToken raw, out EqInstanceDto dto)
    {
        dto = null;
        if (raw == null || raw.Type == JTokenType.Null) return false;

        var kind = raw.Value<string>("kind");
        if (!string.Equals(kind, "EQ", StringComparison.OrdinalIgnoreCase)) return false;

        dto = raw.ToObject<EqInstanceDto>();
        return dto != null;
    }

    public static InventoryInstanceBaseDto DeserializeBase(JToken raw)
    {
        if (raw == null || raw.Type == JTokenType.Null) return null;
        return raw.ToObject<InventoryInstanceBaseDto>();
    }
}
