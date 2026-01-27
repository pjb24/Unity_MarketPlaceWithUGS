using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

[DefaultExecutionOrder(-10)]
public class UIController : MonoBehaviour
{
    public static UIController instance;

    [Header("큰 분류")]
    [SerializeField] private GameObject _loginPage;
    [SerializeField] private GameObject _marketPlacePage;

    [Header("탭 버튼")]
    [SerializeField] private Button _tradeTabButton;
    [SerializeField] private Sprite _tradeTabOnImage;
    [SerializeField] private Sprite _tradeTabOffImage;
    
    [SerializeField] private Button _sellTabButton;
    [SerializeField] private Sprite _sellTabOnImage;
    [SerializeField] private Sprite _sellTabOffImage;
    
    [SerializeField] private Button _historyTabButton;
    [SerializeField] private Sprite _historyTabOnImage;
    [SerializeField] private Sprite _historyTabOffImage;

    [Header("대금 수령")]
    [SerializeField] private Button _claimButton;

    [Header("정보 패널")]
    [SerializeField] private TMP_Text _infoTitle;
    [SerializeField] private Image _infoImage;
    [SerializeField] private TMP_Text _infoPrice;
    [SerializeField] private TMP_InputField _infoPriceInput;
    [SerializeField] private TMP_Text _infoFee;
    [SerializeField] private Button _infoBtnBuy;
    [SerializeField] private Button _infoBtnSell;
    [SerializeField] private TMP_Text _infoPriceText;
    [SerializeField] private TMP_Text _infoFeeText;

    private Action _onLogin;

    public void AddListenerOnLogin(Action listener)
    {
        _onLogin += listener;
    }

    public void RemoveListenerOnLogin(Action listener)
    {
        _onLogin -= listener;
    }

    private void Awake()
    {
        instance = this;

        UIUpdateOnAwake();
    }

    private void UIUpdateOnAwake()
    {
        _loginPage.SetActive(true);
        _marketPlacePage.SetActive(false);
    }

    public void UIUpdateOnLogin()
    {
        _loginPage.SetActive(false);
        _marketPlacePage.SetActive(true);

        if (_tradeTabOnImage) _tradeTabButton.image.sprite = _tradeTabOnImage;
        if (_sellTabOffImage) _sellTabButton.image.sprite = _sellTabOffImage;
        if (_historyTabOffImage) _historyTabButton.image.sprite = _historyTabOffImage;

        _claimButton.gameObject.SetActive(false);

        _infoTitle.gameObject.SetActive(false);
        _infoImage.gameObject.SetActive(false);
        _infoPrice.gameObject.SetActive(false);
        _infoPriceInput.gameObject.SetActive(false);
        _infoFee.gameObject.SetActive(false);
        _infoBtnBuy.gameObject.SetActive(false);
        _infoBtnSell.gameObject.SetActive(false);

        _infoPriceText.gameObject.SetActive(false);
        _infoFeeText.gameObject.SetActive(false);

        _onLogin?.Invoke();
    }

    public void UIUpdateTradeTab()
    {
        if (_tradeTabOnImage) _tradeTabButton.image.sprite = _tradeTabOnImage;
        if (_sellTabOffImage) _sellTabButton.image.sprite = _sellTabOffImage;
        if (_historyTabOffImage) _historyTabButton.image.sprite = _historyTabOffImage;

        _claimButton.gameObject.SetActive(false);

        _infoTitle.gameObject.SetActive(false);
        _infoImage.gameObject.SetActive(false);
        _infoPrice.gameObject.SetActive(false);
        _infoPriceInput.gameObject.SetActive(false);
        _infoFee.gameObject.SetActive(false);
        _infoBtnBuy.gameObject.SetActive(false);
        _infoBtnSell.gameObject.SetActive(false);

        _infoPriceText.gameObject.SetActive(false);
        _infoFeeText.gameObject.SetActive(false);
    }

    public void UIUpdateSellTab()
    {
        if (_tradeTabOffImage) _tradeTabButton.image.sprite = _tradeTabOffImage;
        if (_sellTabOnImage) _sellTabButton.image.sprite = _sellTabOnImage;
        if (_historyTabOffImage) _historyTabButton.image.sprite = _historyTabOffImage;

        _claimButton.gameObject.SetActive(false);

        _infoTitle.gameObject.SetActive(false);
        _infoImage.gameObject.SetActive(false);
        _infoPrice.gameObject.SetActive(false);
        _infoPriceInput.gameObject.SetActive(false);
        _infoFee.gameObject.SetActive(false);
        _infoBtnBuy.gameObject.SetActive(false);
        _infoBtnSell.gameObject.SetActive(false);

        _infoPriceText.gameObject.SetActive(false);
        _infoFeeText.gameObject.SetActive(false);
    }

    public void UIUpdateHistoryTab()
    {
        if (_tradeTabOffImage) _tradeTabButton.image.sprite = _tradeTabOffImage;
        if (_sellTabOffImage) _sellTabButton.image.sprite = _sellTabOffImage;
        if (_historyTabOnImage) _historyTabButton.image.sprite = _historyTabOnImage;

        _claimButton.gameObject.SetActive(true);

        _infoTitle.gameObject.SetActive(false);
        _infoImage.gameObject.SetActive(false);
        _infoPrice.gameObject.SetActive(false);
        _infoPriceInput.gameObject.SetActive(false);
        _infoFee.gameObject.SetActive(false);
        _infoBtnBuy.gameObject.SetActive(false);
        _infoBtnSell.gameObject.SetActive(false);

        _infoPriceText.gameObject.SetActive(false);
        _infoFeeText.gameObject.SetActive(false);
    }
}
