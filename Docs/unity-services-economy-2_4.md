# ConfigurationApi
## Import
### Import
```
const { ConfigurationApi } = require("@unity-services/economy-2.4");
```

## Constructors
### Constructor
```
new ConfigurationApi(configuration?: Configuration, basePath?: string, axios?: AxiosInstance): ConfigurationApi
```
- Parameters
	- Optional configuration: Configuration
	- basePath: string = ...
	- axios: AxiosInstance = ...
	Returns ConfigurationApi

## Methods
### Get Player Configuration
```
getPlayerConfiguration(requestParameters: ConfigurationApiGetPlayerConfigurationRequest, options?: AxiosRequestConfig): Promise<AxiosResponse<PlayerConfigurationResponse>>
```
- Returns the economy configuration for the player with any overrides applied.

* summary
	- Get player's configuration

* throws
	- {RequiredError}

* memberof
	- ConfigurationApi

- Parameters
	- requestParameters: ConfigurationApiGetPlayerConfigurationRequest
	Request parameters.

	- Optional options: AxiosRequestConfig
	Returns Promise<AxiosResponse<PlayerConfigurationResponse>>

# CurrenciesApi
## Import
### Import
```
const { CurrenciesApi } = require("@unity-services/economy-2.4");
```

## Constructors
### Constructor
```
new CurrenciesApi(configuration?: Configuration, basePath?: string, axios?: AxiosInstance): CurrenciesApi
```
- Parameters
	- Optional configuration: Configuration
	- basePath: string = ...
	- axios: AxiosInstance = ...
	Returns CurrenciesApi

## Methods
### Decrement Player Currency Balance
```
decrementPlayerCurrencyBalance(requestParameters: CurrenciesApiDecrementPlayerCurrencyBalanceRequest, options?: AxiosRequestConfig): Promise<AxiosResponse<CurrencyBalanceResponse>>
```
- Decrements a player's currency balance by a given value.

* summary
	- Decrement currency balance

* throws
	- {RequiredError}

* memberof
	- CurrenciesApi

- Parameters
	- requestParameters: CurrenciesApiDecrementPlayerCurrencyBalanceRequest
	Request parameters.

	- Optional options: AxiosRequestConfig
	Returns Promise<AxiosResponse<CurrencyBalanceResponse>>

### Get Player Currencies
```
getPlayerCurrencies(requestParameters: CurrenciesApiGetPlayerCurrenciesRequest, options?: AxiosRequestConfig): Promise<AxiosResponse<PlayerCurrencyBalanceResponse>>
```
- Get a list of currency balances for a player. Results ordered in ascending currency ID.

* summary
	- Player currency balances

* throws
	- {RequiredError}

* memberof
	- CurrenciesApi

- Parameters
	- requestParameters: CurrenciesApiGetPlayerCurrenciesRequest
	Request parameters.

	- Optional options: AxiosRequestConfig
	Returns Promise<AxiosResponse<PlayerCurrencyBalanceResponse>>

### Increment Player Currency Balance
```
incrementPlayerCurrencyBalance(requestParameters: CurrenciesApiIncrementPlayerCurrencyBalanceRequest, options?: AxiosRequestConfig): Promise<AxiosResponse<CurrencyBalanceResponse>>
```
- Increment a player's currency balance by a given value.

* summary
	- Increment currency balance

* throws
	- {RequiredError}

* memberof
	- CurrenciesApi

- Parameters
	- requestParameters: CurrenciesApiIncrementPlayerCurrencyBalanceRequest
	Request parameters.

	- Optional options: AxiosRequestConfig
	Returns Promise<AxiosResponse<CurrencyBalanceResponse>>

### Set Player Currency Balance
```
setPlayerCurrencyBalance(requestParameters: CurrenciesApiSetPlayerCurrencyBalanceRequest, options?: AxiosRequestConfig): Promise<AxiosResponse<CurrencyBalanceResponse>>
```
- Set a player's currency balance.

* summary
	- Set currency balance

* throws
	- {RequiredError}

* memberof
	- CurrenciesApi

- Parameters
	- requestParameters: CurrenciesApiSetPlayerCurrencyBalanceRequest
	Request parameters.

	- Optional options: AxiosRequestConfig
	Returns Promise<AxiosResponse<CurrencyBalanceResponse>>

# InventoryApi
## Import
### Import
```
const { InventoryApi } = require("@unity-services/economy-2.4");
```

## Constructors
### Constructor
```
new InventoryApi(configuration?: Configuration, basePath?: string, axios?: AxiosInstance): InventoryApi
```
- Parameters
	- Optional configuration: Configuration
	- basePath: string = ...
	- axios: AxiosInstance = ...
	Returns InventoryApi

## Methods
### Add Inventory Item
```
addInventoryItem(requestParameters: InventoryApiAddInventoryItemRequest, options?: AxiosRequestConfig): Promise<AxiosResponse<InventoryResponse>>
```
- Add an item to a player's inventory.

* summary
	- Add inventory item

* throws
	- {RequiredError}

* memberof
	- InventoryApi

- Parameters
	- requestParameters: InventoryApiAddInventoryItemRequest
	Request parameters.

	- Optional options: AxiosRequestConfig
	Returns Promise<AxiosResponse<InventoryResponse>>

### Delete Inventory Item
```
deleteInventoryItem(requestParameters: InventoryApiDeleteInventoryItemRequest, options?: AxiosRequestConfig): Promise<AxiosResponse<void>>
```
- Delete a player's inventory item.

* summary
	- Delete player's inventory item

* throws
	- {RequiredError}

* memberof
	- InventoryApi

- Parameters
	- requestParameters: InventoryApiDeleteInventoryItemRequest
	Request parameters.

	- Optional options: AxiosRequestConfig
	Returns Promise<AxiosResponse<void>>

### Get Player Inventory
```
getPlayerInventory(requestParameters: InventoryApiGetPlayerInventoryRequest, options?: AxiosRequestConfig): Promise<AxiosResponse<PlayerInventoryResponse>>
```
- Get a list of inventory for a player. Results ordered by ascending playersInventoryItemId. playersIventoryItemIds and inventoryItemIds filters are optional, if not given all items will be returned. If both are given an item must match both to be returned.

* summary
	- List player inventory

* throws
	- {RequiredError}

* memberof
	- InventoryApi

- Parameters
	- requestParameters: InventoryApiGetPlayerInventoryRequest
	Request parameters.

	- Optional options: AxiosRequestConfig
	Returns Promise<AxiosResponse<PlayerInventoryResponse>>

### Update Inventory Item
```
updateInventoryItem(requestParameters: InventoryApiUpdateInventoryItemRequest, options?: AxiosRequestConfig): Promise<AxiosResponse<InventoryResponse>>
```
- Update a player's inventory item.

* summary
	- Update player's inventory item

* throws
	- {RequiredError}

* memberof
	- InventoryApi

- Parameters
	- requestParameters: InventoryApiUpdateInventoryItemRequest
	Request parameters.

	- Optional options: AxiosRequestConfig
	Returns Promise<AxiosResponse<InventoryResponse>>

# PurchasesApi
## Import
### Import
```
const { PurchasesApi } = require("@unity-services/economy-2.4");
```

## Constructors
### Constructor
```
new PurchasesApi(configuration?: Configuration, basePath?: string, axios?: AxiosInstance): PurchasesApi
```
- Parameters
	- Optional configuration: Configuration
	- basePath: string = ...
	- axios: AxiosInstance = ...
	Returns PurchasesApi

## Methods
### Make Virtual Purchase
```
makeVirtualPurchase(requestParameters: PurchasesApiMakeVirtualPurchaseRequest, options?: AxiosRequestConfig): Promise<AxiosResponse<PlayerPurchaseVirtualResponse>>
```
- Make a virtual purchase for a player.

* summary
	- Make virtual purchase

* throws
	- {RequiredError}

* memberof
	- PurchasesApi

- Parameters
	- requestParameters: PurchasesApiMakeVirtualPurchaseRequest
	Request parameters.

	- Optional options: AxiosRequestConfig
	Returns Promise<AxiosResponse<PlayerPurchaseVirtualResponse>>

### Redeem Apple App Store Purchase
```
redeemAppleAppStorePurchase(requestParameters: PurchasesApiRedeemAppleAppStorePurchaseRequest, options?: AxiosRequestConfig): Promise<AxiosResponse<PlayerPurchaseAppleappstoreResponse>>
```
- Redeem an Apple App Store purchase for a player.

* summary
	- Redeem Apple App Store purchase

* throws
	- {RequiredError}

* memberof
	- PurchasesApi

- Parameters
	- requestParameters: PurchasesApiRedeemAppleAppStorePurchaseRequest
	Request parameters.

	- Optional options: AxiosRequestConfig
	Returns Promise<AxiosResponse<PlayerPurchaseAppleappstoreResponse>>

### Redeem Google Play Purchase
```
redeemGooglePlayPurchase(requestParameters: PurchasesApiRedeemGooglePlayPurchaseRequest, options?: AxiosRequestConfig): Promise<AxiosResponse<PlayerPurchaseGoogleplaystoreResponse>>
```
- Redeem a Google Play store purchase for a player.

* summary
	- Redeem Google Play purchase

* throws
	- {RequiredError}

* memberof
	- PurchasesApi

- Parameters
	- requestParameters: PurchasesApiRedeemGooglePlayPurchaseRequest
	Request parameters.

	- Optional options: AxiosRequestConfig
	Returns Promise<AxiosResponse<PlayerPurchaseGoogleplaystoreResponse>>