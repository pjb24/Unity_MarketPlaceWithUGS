///
/// 사용하지는 않지만, 처음 동작 구현 시작에 사용한 코드
/// 공부용 코드
///
using System.Collections.Generic;
using System.Threading.Tasks;
using TMPro;
using Unity.Services.Economy;
using Unity.Services.Economy.Model;
using UnityEngine;
using UnityEngine.UI;


public class UserData
{
    public List<string> items = new List<string>();
    public int coins = 0;
}
public class CloudSaveTest : MonoBehaviour
{
    public GameObject[] itemprefab;
    public Transform itemParent;
    public int coins = 0;


    public Button btn_addCoin;
    public TextMeshProUGUI coinText;
    string currencyID = "COIN";


    

    // Update is called once per frame
    void Update()
    {

    }
    public async Task LoadItem() //로그인 성공시 불림
    {
        /*    var playerData = await CloudSaveService.Instance.Data.Player.LoadAsync(new HashSet<string> {
              "coin","items"});
            if (playerData.TryGetValue("coin", out var keyName))
            {
                Debug.Log($"keyName: {keyName.Value.GetAs<string>()}");
                coins = System.Int32.Parse(keyName.Value.GetAs<string>());
            }
            if (playerData.TryGetValue("items", out var item))
            {
                Debug.Log($"keyName: {item.Value.GetAs<string>()}");
                coins = System.Int32.Parse(item.Value.GetAs<string>());
            }*/

        EconomyService.Instance.PlayerBalances.BalanceUpdated += async currencyID => {
            var playerscCoinBalance = await EconomyService.Instance.PlayerBalances.GetBalancesAsync();
            coins = (int)playerscCoinBalance.Balances[0].Balance;
            coinText.text = coins.ToString();
        };//플레이어 재화 상태 변할때마다 갱신, 다른 클라이언트나 서버측에서 바뀌는게 적용되는건 아님
        //OnEnable에서 실행시 에러나므로 로그인 후 실행이 안정?

        try
        {
            await GetCoin();
            await LoadInventory();
        }
        catch (EconomyException ex)
        {
            print(ex);
        }



    }

    //최초 코인 정보 불러오기. 이후는 BalanceUpdated에 등록한 이벤트로 자동 갱신으로 다시 쓰지않음
    async Task GetCoin()
    {
        await EconomyService.Instance.Configuration.SyncConfigurationAsync();
        CurrencyDefinition currencyDefinition = EconomyService.Instance.Configuration.GetCurrency(currencyID);
        PlayerBalance playerscCoinBalance = await currencyDefinition.GetPlayerBalanceAsync();
        coins = (int)playerscCoinBalance.Balance;
        coinText.text = coins.ToString();
    }

    //최초 인벤토리 정보 불러오기
    async Task LoadInventory()
    {
        //List<InventoryItemDefinition> definitions = EconomyService.Instance.Configuration.GetInventoryItems();
        GetInventoryResult inventoryResult = await EconomyService.Instance.PlayerInventory.GetInventoryAsync();
        List<PlayersInventoryItem> Items = inventoryResult.PlayersInventoryItems;
        if (Items.Count > 0)
        {
            foreach (var item in Items)
            {
                SpawnItem(item.InventoryItemId);
            }
        }
    }
    
    //코인추가 및 아이템추가 버튼용 메서드
    public void OnAddCoin()
    {
        print("addcoin!");
        AddCoin();
    }
    public void OnAddItem(string ID)
    {
        AddItem(ID);
    }

    //코인 100개 추가 비동기 메서드
    public async Task AddCoin()
    {
        int newAmount = 100;

        PlayerBalance newBalance = await EconomyService.Instance.PlayerBalances.IncrementBalanceAsync(currencyID, newAmount);

    }

    //아이템 추가 비동기 메서드
    public async Task AddItem(string _ID)
    {
        try
        {
            PlayersInventoryItem createdInventoryItem = await EconomyService.Instance.PlayerInventory.AddInventoryItemAsync(_ID);
            print(createdInventoryItem.InventoryItemId);
            SpawnItem(_ID);
        }
        catch (EconomyException e)
        {
            print(e);
        }
    }


    //아이템 프리팹 생성 메서드
    void SpawnItem(string _itemname)
    {
        if (_itemname == "REDPOTION") Instantiate(itemprefab[0], itemParent);
        else if (_itemname == "BLUEPOTION") Instantiate(itemprefab[1], itemParent);
    }

    public async Task RemoveItem()
    {

    }
}
