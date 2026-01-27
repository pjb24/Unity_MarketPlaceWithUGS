///
/// InputField 2개(Username, Password)
/// Button 2개(SignUp, SignIn)
/// 버튼 OnClick에서 UgsAuthUsernamePassword.OnClickSignUp(username, password) / OnClickSignIn(...) 호출하도록 연결
///
using System;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using TMPro;
using Unity.Services.Authentication;
using Unity.Services.Core;
using UnityEngine;
using UnityEngine.UI;

public class UgsAuthUsernamePassword : MonoBehaviour
{
    [SerializeField] private TMP_InputField inputID;
    [SerializeField] private TMP_InputField inputPW;
    [SerializeField] private Button loginBtn;
    [SerializeField] private Button siginUpBtn;
    [SerializeField] private TextMeshProUGUI debugLine;

    public enum E_AuthState
    {
        None = 0,
        Initializing = 1,
        SignedOut = 2,
        SigningIn = 3,
        SignedIn = 4,
        Error = 5
    }

    [Header("Runtime State (ReadOnly)")]
    [SerializeField] private E_AuthState _state = E_AuthState.None;

    public E_AuthState State => _state;
    public string PlayerId => AuthenticationService.Instance?.PlayerId;

    private static readonly Regex UsernameRegex = new Regex(@"^[A-Za-z0-9._@\-\u002D]{3,20}$", RegexOptions.Compiled);
    // 비밀번호 규칙: 8~30, 대/소문자/숫자/기호 각각 1개 이상
    private static readonly Regex PasswordRegex = new Regex(
        @"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,30}$",
        RegexOptions.Compiled
    );

    private async void Awake()
    {
        await InitializeAsync();
    }

    private void OnEnable()
    {
        if (loginBtn != null) loginBtn.onClick.AddListener(OnClickSignIn);
        if (siginUpBtn != null) siginUpBtn.onClick.AddListener(OnClickSignUp);
    }

    private void OnDisable()
    {
        if (loginBtn != null) loginBtn.onClick.RemoveListener(OnClickSignIn);
        if (siginUpBtn != null) siginUpBtn.onClick.RemoveListener(OnClickSignUp);
    }

    public async Task InitializeAsync()
    {
        if (_state != E_AuthState.None && _state != E_AuthState.Error)
            return;

        _state = E_AuthState.Initializing;

        try
        {
            await UnityServices.InitializeAsync();
            _state = AuthenticationService.Instance.IsSignedIn ? E_AuthState.SignedIn : E_AuthState.SignedOut;
        }
        catch (Exception ex)
        {
            _state = E_AuthState.Error;
            debugLine.text = $"[UGS][Auth] Initialize failed: {ex}";
            Debug.LogError($"[UGS][Auth] Initialize failed: {ex}");
        }
    }

    /// <summary>
    /// Unity UI Button OnClick에 연결용.
    /// </summary>
    public async void OnClickSignUp()
    {
        await SignUpAsync(inputID.text, inputPW.text);

        if (_state == E_AuthState.SignedIn)
        {
            UIController.instance.UIUpdateOnLogin();
        }
    }

    /// <summary>
    /// Unity UI Button OnClick에 연결용.
    /// </summary>
    public async void OnClickSignIn()
    {
        await SignInAsync(inputID.text, inputPW.text);

        if (_state == E_AuthState.SignedIn)
        {
            UIController.instance.UIUpdateOnLogin();
        }
    }

    public void SignOut(bool clearCredentials = false)
    {
        if (AuthenticationService.Instance == null)
            return;

        AuthenticationService.Instance.SignOut(clearCredentials); // clearCredentials=true면 세션 토큰도 제거
        _state = E_AuthState.SignedOut;
        debugLine.text = $"[UGS][Auth] Signed out. clearCredentials={clearCredentials}";
        Debug.Log($"[UGS][Auth] Signed out. clearCredentials={clearCredentials}");
    }

    public async Task SignUpAsync(string username, string password)
    {
        if (!EnsureInitialized())
            return;

        if (!ValidateInputs(username, password, out var reason))
        {
            debugLine.text = $"[UGS][Auth] SignUp blocked: {reason}";
            Debug.LogWarning($"[UGS][Auth] SignUp blocked: {reason}");
            return;
        }

        if (AuthenticationService.Instance.IsSignedIn)
        {
            debugLine.text = "[UGS][Auth] SignUp blocked: already signed in. SignOut first.";
            Debug.LogWarning("[UGS][Auth] SignUp blocked: already signed in. SignOut first.");
            return;
        }

        _state = E_AuthState.SigningIn;

        try
        {
            await AuthenticationService.Instance.SignUpWithUsernamePasswordAsync(username, password);
            _state = E_AuthState.SignedIn;
            debugLine.text = $"[UGS][Auth] SignUp success. PlayerId={AuthenticationService.Instance.PlayerId}";
            Debug.Log($"[UGS][Auth] SignUp success. PlayerId={AuthenticationService.Instance.PlayerId}");
        }
        catch (AuthenticationException ex)
        {
            _state = E_AuthState.Error;
            debugLine.text = $"[UGS][Auth] SignUp failed. ErrorCode={ex.ErrorCode} Message={ex.Message}\n{ex}";
            Debug.LogError($"[UGS][Auth] SignUp failed. ErrorCode={ex.ErrorCode} Message={ex.Message}\n{ex}");
        }
        catch (RequestFailedException ex)
        {
            _state = E_AuthState.Error;
            debugLine.text = $"[UGS][Auth] SignUp request failed. ErrorCode={ex.ErrorCode} Message={ex.Message}\n{ex}";
            Debug.LogError($"[UGS][Auth] SignUp request failed. ErrorCode={ex.ErrorCode} Message={ex.Message}\n{ex}");
        }
        catch (Exception ex)
        {
            _state = E_AuthState.Error;
            debugLine.text = $"[UGS][Auth] SignUp failed: {ex}";
            Debug.LogError($"[UGS][Auth] SignUp failed: {ex}");
        }
    }

    public async Task SignInAsync(string username, string password)
    {
        if (!EnsureInitialized())
            return;

        if (!ValidateInputs(username, password, out var reason))
        {
            debugLine.text = $"[UGS][Auth] SignIn blocked: {reason}";
            Debug.LogWarning($"[UGS][Auth] SignIn blocked: {reason}");
            return;
        }

        if (AuthenticationService.Instance.IsSignedIn)
        {
            debugLine.text = "[UGS][Auth] SignIn blocked: already signed in. SignOut first.";
            Debug.LogWarning("[UGS][Auth] SignIn blocked: already signed in. SignOut first.");
            return;
        }

        _state = E_AuthState.SigningIn;

        try
        {
            await AuthenticationService.Instance.SignInWithUsernamePasswordAsync(username, password);
            _state = E_AuthState.SignedIn;
            debugLine.text = $"[UGS][Auth] SignIn success. PlayerId={AuthenticationService.Instance.PlayerId}";
            Debug.Log($"[UGS][Auth] SignIn success. PlayerId={AuthenticationService.Instance.PlayerId}");
        }
        catch (AuthenticationException ex)
        {
            _state = E_AuthState.Error;
            debugLine.text = $"[UGS][Auth] SignIn failed. ErrorCode={ex.ErrorCode} Message={ex.Message}\n{ex}";
            Debug.LogError($"[UGS][Auth] SignIn failed. ErrorCode={ex.ErrorCode} Message={ex.Message}\n{ex}");
        }
        catch (RequestFailedException ex)
        {
            _state = E_AuthState.Error;
            debugLine.text = $"[UGS][Auth] SignIn request failed. ErrorCode={ex.ErrorCode} Message={ex.Message}\n{ex}";
            Debug.LogError($"[UGS][Auth] SignIn request failed. ErrorCode={ex.ErrorCode} Message={ex.Message}\n{ex}");
        }
        catch (Exception ex)
        {
            _state = E_AuthState.Error;
            debugLine.text = $"[UGS][Auth] SignIn failed: {ex}";
            Debug.LogError($"[UGS][Auth] SignIn failed: {ex}");
        }
    }

    private bool EnsureInitialized()
    {
        if (UnityServices.State != ServicesInitializationState.Initialized)
        {
            debugLine.text = "[UGS][Auth] Not initialized. Call InitializeAsync first. (fallback 발생)";
            Debug.LogWarning("[UGS][Auth] Not initialized. Call InitializeAsync first. (fallback 발생)");
            return false;
        }
        return true;
    }

    private bool ValidateInputs(string username, string password, out string reason)
    {
        username = username?.Trim() ?? string.Empty;
        password = password ?? string.Empty;

        // Unity 문서 규칙 요약(3~20 / 8~30 및 조합 규칙)
        if (!UsernameRegex.IsMatch(username))
        {
            reason = "username format invalid (3~20, allowed: letters, digits, . - @ _)";
            return false;
        }

        if (!PasswordRegex.IsMatch(password))
        {
            reason = "password format invalid (8~30, must include upper/lower/digit/symbol)";
            return false;
        }

        reason = null;
        return true;
    }
}
