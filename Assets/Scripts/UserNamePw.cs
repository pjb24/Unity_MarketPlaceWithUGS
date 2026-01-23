using System.Text.RegularExpressions;
using System.Threading.Tasks;
using TMPro;
using Unity.Services.Authentication;
using UnityEngine;
using UnityEngine.UI;
using Unity.Services.Core;


public class UserNamePw : MonoBehaviour
{
    [SerializeField] private TMP_InputField inputID;
    [SerializeField] private TMP_InputField inputPW;
    [SerializeField] private Button loginBtn;
    [SerializeField] private Button siginUpBtn;
    [SerializeField] private TextMeshProUGUI debugLine;
    [SerializeField] private GameObject loginPanel;
    [SerializeField] private GameObject inventoryPanel;

    private PortfolioMarketDemo marketDemo;

    private void Start()
    {
        marketDemo = GetComponent<PortfolioMarketDemo>();

        if (loginBtn != null) loginBtn.onClick.AddListener(OnLogin);
        if (siginUpBtn != null) siginUpBtn.onClick.AddListener(OnSignUp);

        SetLoggedOutUI();
    }

    private void SetLoggedInUI()
    {
        if (loginPanel != null) loginPanel.SetActive(false);
        if (inventoryPanel != null) inventoryPanel.SetActive(true);
    }

    private void SetLoggedOutUI()
    {
        if (loginPanel != null) loginPanel.SetActive(true);
        if (inventoryPanel != null) inventoryPanel.SetActive(false);
    }

    private void SetMessage(string message)
    {
        if (debugLine != null) debugLine.text = message;
        Debug.Log(message);
    }

    private static bool TryValidatePassword(string password, out string error)
    {
        error = string.Empty;

        if (string.IsNullOrWhiteSpace(password))
        {
            error = "비밀번호가 비어있음";
            return false;
        }

        if (password.Length < 8 || password.Length > 30)
        {
            error = "비밀번호 길이는 8~30";
            return false;
        }

        bool hasUpper = Regex.IsMatch(password, "[A-Z]");
        bool hasLower = Regex.IsMatch(password, "[a-z]");
        bool hasDigit = Regex.IsMatch(password, "[0-9]");
        bool hasSymbol = Regex.IsMatch(password, @"[^A-Za-z0-9]");

        if (!hasUpper || !hasLower || !hasDigit || !hasSymbol)
        {
            error = "대문자 소문자 숫자 특수문자 최소 1개씩 필요 (예: Abcd1234!)";
            return false;
        }

        return true;
    }

    public void OnSignUp()
    {
        _ = SignUpAsync();
    }

    public void OnLogin()
    {
        _ = LoginAsync();
    }

    private async Task SignUpAsync()
    {
        if (siginUpBtn != null) siginUpBtn.interactable = false;

        string username = inputID != null ? inputID.text : "";
        string password = inputPW != null ? inputPW.text : "";

        if (!TryValidatePassword(password, out string error))
        {
            SetMessage(error);
            if (siginUpBtn != null) siginUpBtn.interactable = true;
            return;
        }

        try
        {
            if (AuthenticationService.Instance.IsSignedIn)
            {
                SetMessage("이미 로그인됨 (회원가입 전에 SignOut 필요)");
                return;
            }

            await AuthenticationService.Instance.SignUpWithUsernamePasswordAsync(username, password);
            SetMessage("회원가입 성공. 이제 로그인");
        }
        catch (AuthenticationException e)
        {
            Debug.LogException(e);
            SetMessage("회원가입 실패 (아이디 중복/정책/네트워크 확인)");
        }
        catch (RequestFailedException e)
        {
            Debug.LogException(e);
            SetMessage("요청 실패 (프로젝트/환경/네트워크 확인)");
        }
        finally
        {
            if (siginUpBtn != null) siginUpBtn.interactable = true;
        }
    }

    private async Task LoginAsync()
    {
        if (loginBtn != null) loginBtn.interactable = false;

        string username = inputID != null ? inputID.text : "";
        string password = inputPW != null ? inputPW.text : "";

        try
        {
            if (AuthenticationService.Instance.IsSignedIn)
            {
                SetMessage("이미 로그인된 상태");
                SetLoggedInUI();
                if (marketDemo != null) await marketDemo.RefreshAllAsync();
                return;
            }

            await AuthenticationService.Instance.SignInWithUsernamePasswordAsync(username, password);
            SetMessage("로그인 성공");
            SetLoggedInUI();

            if (marketDemo != null)
            {
                await marketDemo.RefreshAllAsync();
            }
        }
        catch (AuthenticationException e)
        {
            Debug.LogException(e);
            SetMessage("로그인 실패 (아이디/비번 확인)");
        }
        catch (RequestFailedException e)
        {
            Debug.LogException(e);
            SetMessage("요청 실패 (프로젝트/환경/네트워크 확인)");
        }
        finally
        {
            if (loginBtn != null) loginBtn.interactable = true;
        }
    }
}
