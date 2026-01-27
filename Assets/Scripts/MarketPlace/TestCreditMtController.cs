// TestCreditMtController.cs
// - Inspector에서 지정한 amount로 Cloud Code "CreditCurrency" 호출
// - DTO / params 는 CreditCurrency.js와 1:1 매칭
// - 실제 지급은 Cloud Code + Economy v2.4에서 처리

using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEngine;
using Unity.Services.Core;
using Unity.Services.CloudCode;
using UnityEngine.UI;

public class TestCreditMtController : MonoBehaviour
{
    private const string SCRIPT_NAME = "CreditCurrency";
    private const string CURRENCY_ID_MT = "MARKETTOKEN";
    private const string TOKEN_TYPE_SERVICE = "SERVICE";

    [Header("Test Grant Settings")]
    [SerializeField] private Button _btnAddCredit;

    [SerializeField]
    [Tooltip("테스트용 MT 지급량 (1 ~ 100000)")]
    private long _grantAmount = 100;

    [SerializeField]
    private bool _idempotency = true;

    [SerializeField]
    private bool _logVerbose = true;

    // ===== Request DTO (params) =====
    // CreditCurrency.js params:
    // - currencyId: string (필수)
    // - amount: number (필수, 양수)
    // - txnId: string (필수)
    // - playerId?: string (클라 전달 금지)
    // - expectedWriteLock?: string|null (클라 기본 미사용)
    // - tokenType?: "SERVICE"|"ACCESS" (기본 SERVICE) -> 클라 고정 SERVICE
    // - idempotency?: boolean (기본 true)
    [Serializable]
    private class CreditCurrencyRequest
    {
        public string currencyId;     // "MT" 고정
        public long amount;           // 1..100000
        public string txnId;          // 유니크
        public string tokenType;      // "SERVICE" 고정
        public bool idempotency;      // 기본 true
                                      // expectedWriteLock / playerId는 보내지 않음
    }

    // ===== Response DTO =====
    // CreditCurrency.js return payload:
    // {
    //   playerId: string,
    //   currencyId: string,
    //   txnId: string,
    //   creditAmount: number,
    //   newBalance: number,
    //   writeLock: string|null,
    //   alreadyProcessed: boolean,
    //   processedAt: string
    // }	
    [Serializable]
    public class CreditCurrencyResponse
    {
        public string playerId;
        public string currencyId;
        public string txnId;
        public long creditAmount;
        public long newBalance;
        public string writeLock;
        public bool alreadyProcessed;
        public string processedAt;
    }

    // 로컬 실패 표현용(스크립트 응답에 ok가 없어서, 클라에서 별도 래핑)
    public struct CreditResult
    {
        public bool Ok;
        public string ErrorCode;
        public string ErrorMessage;
        public CreditCurrencyResponse Data;

        public static CreditResult Success(CreditCurrencyResponse data) => new CreditResult
        {
            Ok = true,
            ErrorCode = null,
            ErrorMessage = null,
            Data = data
        };

        public static CreditResult Fail(string code, string msg) => new CreditResult
        {
            Ok = false,
            ErrorCode = code,
            ErrorMessage = msg,
            Data = null
        };
    }

    private async void Awake()
    {
        await EnsureSignedInAsync();
    }

    private void OnEnable()
    {
        if (_btnAddCredit != null) _btnAddCredit.onClick.AddListener(CreditMt_FromInspector);
    }

    private void OnDisable()
    {
        if (_btnAddCredit != null) _btnAddCredit.onClick.RemoveListener(CreditMt_FromInspector);
    }

    /// <summary>
    /// Inspector에 설정된 값으로 MT 지급
    /// (UI Button OnClick에 바로 연결)
    /// </summary>
    public async void CreditMt_FromInspector()
    {
        var result = await CreditMtAsync(_grantAmount, _idempotency);
        if (!result.Ok)
        {
            Debug.LogError("[TestCreditMT] FAIL code={result.ErrorCode} msg={result.ErrorMessage}");
        }
    }

    /// <summary>
    /// 테스트 MT 지급
    /// - amount: 1..100000
    /// - txnId: 매 호출 유니크(테스트 목적)
    /// - idempotency: 기본 true
    /// </summary>
    private async Task<CreditResult> CreditMtAsync(long amount, bool idempotency)
    {
        await EnsureSignedInAsync();

        // ===== 테스트 안전장치 =====
        if (amount < 1 || amount > 100_000)
        {
            Debug.LogWarning(
                $"[TestCreditMT] Invalid amount={amount}. Allowed range: 1~100000. FAIL."
            );
            return CreditResult.Fail("INVALID_AMOUNT", "amount must be 1..100000");
        }

        var req = new CreditCurrencyRequest
        {
            currencyId = CURRENCY_ID_MT,
            amount = amount,
            txnId = Guid.NewGuid().ToString("N"), // 멱등키(테스트는 매 호출 유니크)
            tokenType = TOKEN_TYPE_SERVICE,       // 고정
            idempotency = idempotency             // 기본 true
        };

        // params 키를 스크립트와 동일하게 맞춤(5개, 10개 제한 만족)
        var args = new Dictionary<string, object>
        {
            { "currencyId", req.currencyId },
            { "amount", req.amount },
            { "txnId", req.txnId },
            { "tokenType", req.tokenType },
            { "idempotency", req.idempotency }
        };

        try
        {
            var res = await CloudCodeService.Instance
                .CallEndpointAsync<CreditCurrencyResponse>(SCRIPT_NAME, args);

            if (res == null)
            {
                Debug.LogError($"[TestCreditMT] Cloud Code response is null. txnId={req.txnId}");
                return CreditResult.Fail("NULL_RESPONSE", "Cloud Code response is null");
            }

            // CreditCurrency.js는 ok 필드가 없고, 실패는 throw로 처리됨.
            // 따라서 여기까지 왔으면 성공으로 간주.
            if (_logVerbose)
            {
                Debug.Log(
                    $"[TestCreditMT] OK | txnId={res.txnId} " +
                    $"creditAmount={res.creditAmount} newBalance={res.newBalance} " +
                    $"alreadyProcessed={res.alreadyProcessed} " +
                    $"processedAt={res.processedAt}"
                );
            }

            return CreditResult.Success(res);
        }
        catch (CloudCodeRateLimitedException e)
        {
            Debug.LogError($"[TestCreditMT] RateLimited | txnId={req.txnId} amount={req.amount} msg={e.Message}");
            return CreditResult.Fail("RATE_LIMITED", e.Message);
        }
        catch (CloudCodeException e)
        {
            Debug.LogError($"[TestCreditMT] CloudCodeException | txnId={req.txnId} amount={req.amount} msg={e.Message}");
            return CreditResult.Fail("CLOUD_CODE_EXCEPTION", e.Message);
        }
        catch (Exception e)
        {
            Debug.LogError($"[TestCreditMT] Exception | txnId={req.txnId} amount={req.amount} msg={e.Message}");
            return CreditResult.Fail("CLIENT_EXCEPTION", e.Message);
        }
    }

    private static async Task EnsureSignedInAsync()
    {
        if (UnityServices.State != ServicesInitializationState.Initialized)
            await UnityServices.InitializeAsync();
    }
}
