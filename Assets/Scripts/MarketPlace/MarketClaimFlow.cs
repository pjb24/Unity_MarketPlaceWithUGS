using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Unity.Services.CloudCode;
using UnityEngine;

public sealed class MarketClaimFlow
{
    private readonly string _scriptName;

    public MarketClaimFlow(string scriptName = "ClaimEarning")
    {
        _scriptName = string.IsNullOrWhiteSpace(scriptName) ? "ClaimEarning" : scriptName.Trim();
    }

    [Serializable]
    public sealed class ClaimRequest
    {
        // 필수
        public string currencyId;

        // 선택(서버 기본값을 쓰면 null/0으로 둬도 됨)
        public string proceedsCustomId; // default: "market_proceeds"
        public string lockCustomId;     // default: "txnlocks"
        public int ttlSeconds;          // default: 10
        public bool dryRun;             // default: false
        public double minClaimAmount;   // default: 0
    }

    [Serializable]
    public sealed class ClaimResponseDto
    {
        public bool ok;

        // error (ok=false)
        public string errorCode;
        public string errorMessage;

        // success (ok=true)
        public string playerId;
        public string currencyId;
        public string proceedsKey;

        public double claimedAmount;
        public double beforeBalance;
        public double afterBalance;

        public string nowIso;
        public bool dryRun;
    }
    public sealed class ClaimResult
    {
        public bool Ok;
        public string ErrorCode;
        public string ErrorMessage;

        public ClaimResponseDto Data;
    }

    public async Task<ClaimResult> ClaimAsync(ClaimRequest req, CancellationToken ct)
    {
        if (req == null)
        {
            Debug.LogError("[MarketClaimFlow] req is null.");
            return new ClaimResult { Ok = false, ErrorCode = "null_request", ErrorMessage = "req is null" };
        }

        var currencyId = req.currencyId != null ? req.currencyId.Trim() : null;
        if (string.IsNullOrEmpty(currencyId))
        {
            Debug.LogWarning("[MarketClaimFlow] Claim fallback 발생: currencyId is empty.");
            return new ClaimResult { Ok = false, ErrorCode = "empty_currency", ErrorMessage = "currencyId is empty" };
        }

        ct.ThrowIfCancellationRequested();

        Dictionary<string, object> args;
        try
        {
            args = BuildArgs(req, currencyId);
        }
        catch (Exception ex)
        {
            Debug.LogWarning($"[MarketClaimFlow] Claim fallback 발생: build args failed. ex={ex}");
            return new ClaimResult { Ok = false, ErrorCode = "bad_args", ErrorMessage = "failed to build args" };
        }

        try
        {
            // Cloud Code는 CancellationToken을 직접 받지 않아서, 호출 전/후로만 취소 체크
            var dto = await CloudCodeService.Instance.CallEndpointAsync<ClaimResponseDto>(_scriptName, args);

            ct.ThrowIfCancellationRequested();

            if (dto == null)
            {
                Debug.LogWarning("[MarketClaimFlow] Claim fallback 발생: response dto is null.");
                return new ClaimResult { Ok = false, ErrorCode = "null_response", ErrorMessage = "response dto is null" };
            }

            if (!dto.ok)
            {
                return new ClaimResult
                {
                    Ok = false,
                    ErrorCode = string.IsNullOrEmpty(dto.errorCode) ? "claim_failed" : dto.errorCode,
                    ErrorMessage = dto.errorMessage,
                    Data = dto
                };
            }

            return new ClaimResult
            {
                Ok = true,
                ErrorCode = null,
                ErrorMessage = null,
                Data = dto
            };
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (CloudCodeException cce)
        {
            Debug.LogWarning($"[MarketClaimFlow] Claim CloudCodeException. code={cce.ErrorCode}, msg={cce.Message}");
            return new ClaimResult
            {
                Ok = false,
                ErrorCode = string.IsNullOrEmpty(cce.ErrorCode.ToString()) ? "cloudcode_exception" : cce.ErrorCode.ToString(),
                ErrorMessage = cce.Message
            };
        }
        catch (Exception ex)
        {
            Debug.LogWarning($"[MarketClaimFlow] Claim exception: {ex}");
            return new ClaimResult
            {
                Ok = false,
                ErrorCode = "exception",
                ErrorMessage = ex.Message
            };
        }
    }

    private static Dictionary<string, object> BuildArgs(ClaimRequest req, string currencyIdTrimmed)
    {
        // JS params 키와 1:1 매칭
        var d = new Dictionary<string, object>(8)
        {
            ["currencyId"] = currencyIdTrimmed
        };

        // 선택 파라미터는 "사용자가 의미 있게 설정했을 때만" 넣는다.
        // (서버 기본값을 그대로 타게 하려면 키 자체를 안 넣는 게 안전)
        if (!string.IsNullOrWhiteSpace(req.proceedsCustomId)) d["proceedsCustomId"] = req.proceedsCustomId.Trim();
        if (!string.IsNullOrWhiteSpace(req.lockCustomId)) d["lockCustomId"] = req.lockCustomId.Trim();

        if (req.ttlSeconds > 0) d["ttlSeconds"] = req.ttlSeconds;

        // bool은 기본값이라도 명시해서 호출 의도를 고정
        d["dryRun"] = req.dryRun;

        if (req.minClaimAmount > 0) d["minClaimAmount"] = req.minClaimAmount;

        return d;
    }
}
