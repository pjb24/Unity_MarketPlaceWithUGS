using Unity.Services.Authentication;
using Unity.Services.Core;
using UnityEngine;

public class UgsDiagnostics : MonoBehaviour
{
    [Header("옵션")]
    [SerializeField] private bool logOnStart = true;

    private void Start()
    {
        if (logOnStart)
            LogUgs();
    }

    [ContextMenu("Log UGS Diagnosis")]
    public void LogUgs()
    {
        Debug.Log("===== UGS DIAGNOSIS =====");
        Debug.Log($"CloudProjectId: {Application.cloudProjectId}");
        Debug.Log($"BundleId: {Application.identifier}");
        Debug.Log($"UnityServices.State: {UnityServices.State}");

        bool isSignedIn = AuthenticationService.Instance != null && AuthenticationService.Instance.IsSignedIn;
        Debug.Log($"IsSignedIn: {isSignedIn}");

        if (isSignedIn)
        {
            Debug.Log($"PlayerId: {AuthenticationService.Instance.PlayerId}");
            Debug.Log($"AccessTokenPreview: {GetTokenPreview(AuthenticationService.Instance.AccessToken)}");
        }
        else
        {
            Debug.Log("PlayerId: (not signed in)");
        }

        Debug.Log("=========================");
    }

    private string GetTokenPreview(string token)
    {
        if (string.IsNullOrEmpty(token)) return "(none)";
        return token.Length <= 12 ? token : token.Substring(0, 12) + "...";
    }
}
