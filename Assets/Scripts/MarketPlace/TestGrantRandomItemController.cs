// TestGrantRandomItemController.cs
// - Cloud Save Custom Item("item_templates")를 클라에서 읽고 필터링 후 랜덤 1개 선택
// - 선택된 템플릿 정보로 Cloud Code "GrantItemInstanceToPlayer" 호출
// - 응답 ok=false면 실패 처리
// - 후보 0건이면 Warning 로그 후 실패(무음 폴백 금지)

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using UnityEngine;

using Unity.Services.Core;
using Unity.Services.Authentication;
using Unity.Services.CloudCode;
using Unity.Services.CloudSave;
using Unity.Services.CloudSave.Models;

public class TestGrantRandomItemController : MonoBehaviour
{
    private const string CUSTOM_ID_ITEM_TEMPLATES = "item_templates";
    private const string SCRIPT_GRANT_ITEM = "GrantItemInstanceToPlayer";

    private static readonly Regex _templateKeyRegex =
        new Regex(@"^(FRAG|EQ)_(WPN|ARM|ACC)_T(\d+)_(\d{3})$", RegexOptions.Compiled);

    [SerializeField] private bool _logVerbose = true;

    public enum E_Kind { FRAG, EQ }
    public enum E_Slot { WPN, ARM, ACC }
    public enum E_Rarity { COMMON, RARE, EPIC, LEGENDARY }

    [Serializable]
    private class ItemTemplateDto
    {
        public int schema;
        public string kind;
        public string slot;
        public int tier;
        public string rarity;

        // 문서에 따라 item_templates 값에 templateKey가 없을 수도 있어서 key에서 파싱한다.
    }

    [Serializable]
    public class GrantItemResponse
    {
        public bool ok;
        public string errorCode;
        public string errorMessage;

        public string templateKey;
        public string groupKey;
        public string instanceKey;
        public object instance;
    }

    private async void Awake()
    {
        await EnsureSignedInAsync();
    }

    // UI 버튼에 연결
    public async void GrantOneTestItem()
    {
        await GrantOneTestItemAsync();
    }

    public async Task<GrantItemResponse> GrantOneTestItemAsync(
        E_Kind? kind = null,
        E_Slot? slot = null,
        int tierMin = 1,
        int tierMax = 3,
        E_Rarity? rarity = null)
    {
        await EnsureSignedInAsync();

        if (tierMin < 1 || tierMax < tierMin)
        {
            Debug.LogError($"[TestGrant] Invalid tier range: {tierMin}..{tierMax}");
            return FailLocal("INVALID_TIER_RANGE", "tierMin/tierMax invalid");
        }

        Dictionary<string, Item> templateMap;
        try
        {
            // Custom(Game Data) 읽기: 클라 read-only
            templateMap = await CloudSaveService.Instance.Data.Custom.LoadAllAsync(CUSTOM_ID_ITEM_TEMPLATES);
        }
        catch (Exception e)
        {
            Debug.LogError($"[TestGrant] Failed to load item_templates from Cloud Save. {e.Message}");
            return FailLocal("TEMPLATE_LOAD_FAILED", e.Message);
        }

        var candidates = new List<TemplatePick>();
        foreach (var kv in templateMap)
        {
            var templateKey = kv.Key; // 보통 key가 FRAG_WPN_T1_001 형태

            if (!TryParseTemplateKey(templateKey, out var k, out var s, out var t, out var seq3))
                continue;

            // 1) key 기반 필터(요구 조건)
            if (kind.HasValue && k != kind.Value) continue;
            if (slot.HasValue && s != slot.Value) continue;
            if (t < tierMin || t > tierMax) continue;

            // 2) rarity는 value에서 읽어서 필터
            //    Item.Value는 GetAs<T>()로 역직렬화 가능 :contentReference[oaicite:1]{index=1}
            ItemTemplateDto dto;
            try
            {
                dto = kv.Value.Value.GetAs<ItemTemplateDto>();
            }
            catch
            {
                // 템플릿 구조가 다르면 여기서 제외(테스트 용도)
                continue;
            }

            if (!EnumTryParse(dto.rarity, out E_Rarity r))
                continue;

            if (rarity.HasValue && r != rarity.Value) continue;

            candidates.Add(new TemplatePick
            {
                TemplateKey = templateKey,
                Kind = k,
                Slot = s,
                Tier = t,
                Seq3 = seq3,
                Rarity = r
            });
        }

        if (candidates.Count == 0)
        {
            Debug.LogWarning($"[TestGrant] No template candidates. kind={kind?.ToString() ?? "ANY"} slot={slot?.ToString() ?? "ANY"} tier={tierMin}..{tierMax} rarity={rarity?.ToString() ?? "ANY"}");
            return FailLocal("NO_TEMPLATE_CANDIDATE", "No template matched filters");
        }

        var pick = candidates[UnityEngine.Random.Range(0, candidates.Count)];
        if (_logVerbose)
        {
            Debug.Log($"[TestGrant] Picked templateKey={pick.TemplateKey} kind={pick.Kind} slot={pick.Slot} tier={pick.Tier} seq3={pick.Seq3:000} rarity={pick.Rarity}");
        }

        // GrantItemInstanceToPlayer.js 파라미터 키와 100% 동일하게 보냄 (5개만 사용)
        var args = new Dictionary<string, object>
        {
            { "kind", pick.Kind.ToString() },
            { "slot", pick.Slot.ToString() },
            { "tier", pick.Tier },
            { "seq3", pick.Seq3 },
            { "rarity", pick.Rarity.ToString() },
        };

        try
        {
            // Cloud Code Unity Runtime 호출 :contentReference[oaicite:2]{index=2}
            var res = await CloudCodeService.Instance.CallEndpointAsync<GrantItemResponse>(SCRIPT_GRANT_ITEM, args);

            if (res == null)
            {
                Debug.LogError("[TestGrant] Cloud Code response is null.");
                return FailLocal("NULL_RESPONSE", "Cloud Code response is null.");
            }

            if (!res.ok)
            {
                Debug.LogError($"[TestGrant] Grant failed. ok=false code={res.errorCode} msg={res.errorMessage}");
                return res;
            }

            if (_logVerbose)
            {
                Debug.Log($"[TestGrant] Grant OK. instanceKey={res.instanceKey} groupKey={res.groupKey} templateKey={res.templateKey}");
            }

            return res;
        }
        catch (Exception e)
        {
            Debug.LogError($"[TestGrant] Cloud Code call failed. {e.Message}");
            return FailLocal("CLOUD_CODE_CALL_FAILED", e.Message);
        }
    }

    private struct TemplatePick
    {
        public string TemplateKey;
        public E_Kind Kind;
        public E_Slot Slot;
        public int Tier;
        public int Seq3;
        public E_Rarity Rarity;
    }

    private static bool TryParseTemplateKey(string templateKey, out E_Kind kind, out E_Slot slot, out int tier, out int seq3)
    {
        kind = default;
        slot = default;
        tier = 0;
        seq3 = 0;

        var m = _templateKeyRegex.Match(templateKey ?? "");
        if (!m.Success) return false;

        if (!EnumTryParse(m.Groups[1].Value, out kind)) return false;
        if (!EnumTryParse(m.Groups[2].Value, out slot)) return false;
        if (!int.TryParse(m.Groups[3].Value, out tier)) return false;
        if (!int.TryParse(m.Groups[4].Value, out seq3)) return false;

        return true;
    }

    private static bool EnumTryParse<T>(string s, out T value) where T : struct
    {
        return Enum.TryParse(s, ignoreCase: false, out value);
    }

    private static GrantItemResponse FailLocal(string code, string msg)
    {
        return new GrantItemResponse
        {
            ok = false,
            errorCode = code,
            errorMessage = msg
        };
    }

    private static async Task EnsureSignedInAsync()
    {
        if (UnityServices.State != ServicesInitializationState.Initialized)
            await UnityServices.InitializeAsync();

        if (!AuthenticationService.Instance.IsSignedIn)
            await AuthenticationService.Instance.SignInAnonymouslyAsync();
    }
}
