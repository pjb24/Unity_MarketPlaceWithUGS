///
/// InputField 2개(Username, Password)
/// Button 2개(SignUp, SignIn)
/// 버튼 OnClick에서 UgsAuthUsernamePassword.OnClickSignUp(username, password) / OnClickSignIn(...) 호출하도록 연결
///
using System;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using UnityEngine;
using Unity.Services.Core;
using Unity.Services.Authentication;

public class UgsAuthUsernamePassword : MonoBehaviour
{
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
            Debug.LogError($"[UGS][Auth] Initialize failed: {ex}");
        }
    }

    /// <summary>
    /// Unity UI Button OnClick에 연결용.
    /// </summary>
    public async void OnClickSignUp(string username, string password)
    {
        await SignUpAsync(username, password);
    }

    /// <summary>
    /// Unity UI Button OnClick에 연결용.
    /// </summary>
    public async void OnClickSignIn(string username, string password)
    {
        await SignInAsync(username, password);
    }

    public void SignOut(bool clearCredentials = false)
    {
        if (AuthenticationService.Instance == null)
            return;

        AuthenticationService.Instance.SignOut(clearCredentials); // clearCredentials=true면 세션 토큰도 제거
        _state = E_AuthState.SignedOut;
        Debug.Log($"[UGS][Auth] Signed out. clearCredentials={clearCredentials}");
    }

    public async Task SignUpAsync(string username, string password)
    {
        if (!EnsureInitialized())
            return;

        if (!ValidateInputs(username, password, out var reason))
        {
            Debug.LogWarning($"[UGS][Auth] SignUp blocked: {reason}");
            return;
        }

        if (AuthenticationService.Instance.IsSignedIn)
        {
            Debug.LogWarning("[UGS][Auth] SignUp blocked: already signed in. SignOut first.");
            return;
        }

        _state = E_AuthState.SigningIn;

        try
        {
            await AuthenticationService.Instance.SignUpWithUsernamePasswordAsync(username, password);
            _state = E_AuthState.SignedIn;
            Debug.Log($"[UGS][Auth] SignUp success. PlayerId={AuthenticationService.Instance.PlayerId}");
        }
        catch (AuthenticationException ex)
        {
            _state = E_AuthState.Error;
            Debug.LogError($"[UGS][Auth] SignUp failed. ErrorCode={ex.ErrorCode} Message={ex.Message}\n{ex}");
        }
        catch (RequestFailedException ex)
        {
            _state = E_AuthState.Error;
            Debug.LogError($"[UGS][Auth] SignUp request failed. ErrorCode={ex.ErrorCode} Message={ex.Message}\n{ex}");
        }
        catch (Exception ex)
        {
            _state = E_AuthState.Error;
            Debug.LogError($"[UGS][Auth] SignUp failed: {ex}");
        }
    }

    public async Task SignInAsync(string username, string password)
    {
        if (!EnsureInitialized())
            return;

        if (!ValidateInputs(username, password, out var reason))
        {
            Debug.LogWarning($"[UGS][Auth] SignIn blocked: {reason}");
            return;
        }

        if (AuthenticationService.Instance.IsSignedIn)
        {
            Debug.LogWarning("[UGS][Auth] SignIn blocked: already signed in. SignOut first.");
            return;
        }

        _state = E_AuthState.SigningIn;

        try
        {
            await AuthenticationService.Instance.SignInWithUsernamePasswordAsync(username, password);
            _state = E_AuthState.SignedIn;
            Debug.Log($"[UGS][Auth] SignIn success. PlayerId={AuthenticationService.Instance.PlayerId}");
        }
        catch (AuthenticationException ex)
        {
            _state = E_AuthState.Error;
            Debug.LogError($"[UGS][Auth] SignIn failed. ErrorCode={ex.ErrorCode} Message={ex.Message}\n{ex}");
        }
        catch (RequestFailedException ex)
        {
            _state = E_AuthState.Error;
            Debug.LogError($"[UGS][Auth] SignIn request failed. ErrorCode={ex.ErrorCode} Message={ex.Message}\n{ex}");
        }
        catch (Exception ex)
        {
            _state = E_AuthState.Error;
            Debug.LogError($"[UGS][Auth] SignIn failed: {ex}");
        }
    }

    private bool EnsureInitialized()
    {
        if (UnityServices.State != ServicesInitializationState.Initialized)
        {
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
