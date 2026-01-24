# DataApi
## Import
### Import
```
const { DataApi } = require("@unity-services/cloud-save-1.4");
```

## Constructors
### Constructor
```
new DataApi(configuration?: Configuration, basePath?: string, axios?: AxiosInstance): DataApi
```
- Parameters
	- Optional configuration: Configuration
	- basePath: string = ...
	- axios: AxiosInstance = ...
	Returns DataApi

## Methods
### Delete Custom Item
```
deleteCustomItem(key: string, projectId: string, customId: string, writeLock?: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<void, any>>
```
- Deletes a data item by the specified key for the specified custom ID. Only accessible via an authenticated server authority.

* summary
	- Delete Custom Item

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- key: string
	Item key.

	- projectId: string
	ID of the project.

	- customId: string
	The custom data ID specified by the user. Must be between 1 and 50 characters long and contain only alphanumeric characters, underscores, and hyphens.

	- Optional writeLock: string
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<void, any>>

### Delete Custom Items
```
deleteCustomItems(projectId: string, customId: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<void, any>>
```
- Deletes all default access level data associated with a given custom ID. Only accessible via an authenticated server authority.

* summary
	- Delete Custom Items

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- customId: string
	The custom data ID specified by the user. Must be between 1 and 50 characters long and contain only alphanumeric characters, underscores, and hyphens.

	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<void, any>>

### Delete Item
```
deleteItem(key: string, projectId: string, playerId: string, writeLock?: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<void, any>>
```
- Deletes a data item by the specified key for the given player.

* summary
	- Delete Player Item

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- key: string
	Item key.

	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional writeLock: string
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<void, any>>

### Delete Items
```
deleteItems(projectId: string, playerId: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<void, any>>
```
- Deletes all default access level data associated with a given player.

* summary
	- Delete Player Items

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<void, any>>

### Delete Private Custom Item
```
deletePrivateCustomItem(key: string, projectId: string, customId: string, writeLock?: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<void, any>>
```
- Deletes a private data item by the specified key for the specified custom ID. Only accessible via an authenticated server authority.

* summary
	- Delete Private Custom Item

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- key: string
	Item key.

	- projectId: string
	ID of the project.

	- customId: string
	The custom data ID specified by the user. Must be between 1 and 50 characters long and contain only alphanumeric characters, underscores, and hyphens.

	- Optional writeLock: string
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<void, any>>

### Delete Private Custom Items
```
deletePrivateCustomItems(projectId: string, customId: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<void, any>>
```
- Deletes all private data associated with a given custom ID. Only accessible via an authenticated server authority.

* summary
	- Delete Private Custom Items

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- customId: string
	The custom data ID specified by the user. Must be between 1 and 50 characters long and contain only alphanumeric characters, underscores, and hyphens.

	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<void, any>>

### Delete Protected Item
```
deleteProtectedItem(key: string, projectId: string, playerId: string, writeLock?: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<void, any>>
```
- Deletes a protected data item by the specified key for the given player. Only accessible via an authenticated server authority.

* summary
	- Delete Protected Player Item

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- key: string
	Item key.

	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional writeLock: string
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<void, any>>
	
### Delete Protected Items
```
deleteProtectedItems(projectId: string, playerId: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<void, any>>
```
- Deletes all protected data associated with a given player. Only accessible via an authenticated server authority.

* summary
	- Delete Protected Player Items

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<void, any>>

### Delete Public Item
```
deletePublicItem(key: string, projectId: string, playerId: string, writeLock?: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<void, any>>
```
- Deletes a public data item by the specified key for the given player.

* summary
	- Delete Public Player Item

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- key: string
	Item key.

	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional writeLock: string
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<void, any>>

### Delete Public Items
```
deletePublicItems(projectId: string, playerId: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<void, any>>
```
- Deletes all public data associated with a given player.

* summary
	- Delete Public Player Items

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<void, any>>

### Get Custom Items
```
getCustomItems(projectId: string, customId: string, keys?: string[], after?: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<GetItemsResponse, any>>
```
- Retrieves saved data values for all keys specified, ordered alphabetically in pages of 20. If no keys are supplied then returns all keys, ordered alphabetically in pages of 20.

* summary
	- Get Custom Items

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- customId: string
	The custom data ID specified by the user. Must be between 1 and 50 characters long and contain only alphanumeric characters, underscores, and hyphens.

	- Optional keys: string[]
	- Optional after: string
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<GetItemsResponse, any>>

### Get Custom Keys
```
getCustomKeys(projectId: string, customId: string, after?: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<GetKeysResponse, any>>
```
- Gets a paged list of keys for the given custom ID, ordered alphabetically in pages of 100.

* summary
	- Get Custom Keys

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- customId: string
	The custom data ID specified by the user. Must be between 1 and 50 characters long and contain only alphanumeric characters, underscores, and hyphens.

	- Optional after: string
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<GetKeysResponse, any>>

### Get Items
```
getItems(projectId: string, playerId: string, keys?: string[], after?: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<GetItemsResponse, any>>
```
- Retrieves saved data values for all keys specified, ordered alphabetically in pages of 20. If no keys are supplied then returns all keys, ordered alphabetically in pages of 20.

* summary
	- Get Player Items

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional keys: string[]
	- Optional after: string
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<GetItemsResponse, any>>

### Get Keys
```
getKeys(projectId: string, playerId: string, after?: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<GetKeysResponse, any>>
```
- Gets a paged list of keys for the given player, ordered alphabetically in pages of 100.

* summary
	- Get Player Keys

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional after: string
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<GetKeysResponse, any>>

### Get Private Custom Items
```
getPrivateCustomItems(projectId: string, customId: string, keys?: string[], after?: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<GetItemsResponse, any>>
```
- Retrieves private save data values for all keys specified, ordered alphabetically in pages of 20. If no keys are supplied then returns all keys, ordered alphabetically in pages of 20. Only accessible via an authenticated server authority.

* summary
	- Get Private Custom Items

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- customId: string
	The custom data ID specified by the user. Must be between 1 and 50 characters long and contain only alphanumeric characters, underscores, and hyphens.

	- Optional keys: string[]
	- Optional after: string
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<GetItemsResponse, any>>

### Get Private Custom Keys
```
getPrivateCustomKeys(projectId: string, customId: string, after?: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<GetKeysResponse, any>>
```
- Gets a paged list of private keys for the given custom ID, ordered alphabetically in pages of 100. Only accessible via an authenticated server authority.

* summary
	- Get Private Custom Keys

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- customId: string
	The custom data ID specified by the user. Must be between 1 and 50 characters long and contain only alphanumeric characters, underscores, and hyphens.

	- Optional after: string
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<GetKeysResponse, any>>

### Get Protected Items
```
getProtectedItems(projectId: string, playerId: string, keys?: string[], after?: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<GetItemsResponse, any>>
```
- Retrieves protected save data values for all keys specified, ordered alphabetically in pages of 20. If no keys are supplied then returns all keys, ordered alphabetically in pages of 20.

* summary
	- Get Protected Player Items

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional keys: string[]
	- Optional after: string
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<GetItemsResponse, any>>

### Get Protected Keys
```
getProtectedKeys(projectId: string, playerId: string, after?: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<GetKeysResponse, any>>
```
- Gets a paged list of protected keys for the given player, ordered alphabetically in pages of 100.

* summary
	- Get Protected Player Keys

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional after: string
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<GetKeysResponse, any>>

### Get Public Items
```
getPublicItems(projectId: string, playerId: string, keys?: string[], after?: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<GetItemsResponse, any>>
```
- Retrieves saved data values for all keys specified, ordered alphabetically in pages of 20. If no keys are supplied then returns all keys, ordered alphabetically in pages of 20. Accessible by any player for any other player's data.

* summary
	- Get Public Player Items

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional keys: string[]
	- Optional after: string
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<GetItemsResponse, any>>

### Get Public Keys
```
getPublicKeys(projectId: string, playerId: string, after?: string, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<GetKeysResponse, any>>
```
- Gets a paged list of public keys for the given player, ordered alphabetically in pages of 100. Accessible by any player for any other player's data.

* summary
	- Get Public Player Keys

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional after: string
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<GetKeysResponse, any>>

### Query Default Custom Data
```
queryDefaultCustomData(projectId: string, queryIndexBody?: QueryIndexBody, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<QueryIndexResponse, any>>
```
- Query custom data with the default access class. If no index is available to fulfil the query then the query will fail

* summary
	- Query Default Custom Data

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- Optional queryIndexBody: QueryIndexBody
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<QueryIndexResponse, any>>

### Query Default Player Data
```
queryDefaultPlayerData(projectId: string, queryIndexBody?: QueryIndexBody, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<QueryIndexResponse, any>>
```
- Query player data with the default access class. If no index is available to fulfil the query then the query will fail.

* summary
	- Query Default Player Data

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- Optional queryIndexBody: QueryIndexBody
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<QueryIndexResponse, any>>

### Query Private Custom Data
```
queryPrivateCustomData(projectId: string, queryIndexBody?: QueryIndexBody, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<QueryIndexResponse, any>>
```
- Query custom data with the private access class. If no index is available to fulfil the query then the query will fail.

* summary
	- Query Private Custom Data

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- Optional queryIndexBody: QueryIndexBody
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<QueryIndexResponse, any>>

### Query Protected Player Data
```
queryProtectedPlayerData(projectId: string, queryIndexBody?: QueryIndexBody, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<QueryIndexResponse, any>>
```
- Query player data with the protected access class. If no index is available to fulfil the query then the query will fail.

* summary
	- Query Protected Player Data

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- Optional queryIndexBody: QueryIndexBody
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<QueryIndexResponse, any>>

### Query Public Player Data
```
queryPublicPlayerData(projectId: string, queryIndexBody?: QueryIndexBody, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<QueryIndexResponse, any>>
```
- Query player data with the public access class. If no index is available to fulfil the query then the query will fail.

* summary
	- Query Public Player Data

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- Optional queryIndexBody: QueryIndexBody
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<QueryIndexResponse, any>>

### Set Custom Item
```
setCustomItem(projectId: string, customId: string, setItemBody?: SetItemBody, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<SetItemResponse, any>>
```
- Set a data item with a given key and value for the specified custom ID. The value is limited to a maximum size of 5 MB across all default access level slots. The entire default access level saved state for a custom ID is limited to 2000 keys. Attempting to set a new key beyond this limit will result in an error. Only accessible via an authenticated server authority.

* summary
	- Set Custom Item

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- customId: string
	The custom data ID specified by the user. Must be between 1 and 50 characters long and contain only alphanumeric characters, underscores, and hyphens.

	- Optional setItemBody: SetItemBody
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<SetItemResponse, any>>

### Set Custom Item Batch
```
setCustomItemBatch(projectId: string, customId: string, setItemBatchBody?: SetItemBatchBody, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<SetItemBatchResponse, any>>
```
- Set up to 20 data items with key, value and optional writeLock against the custom ID. The values are limited to a maximum size of 5 MB across all default access level slots for the custom ID. The entire default access level saved state for a custom ID is limited to 2000 keys. Attempting to set a new key beyond this limit will result in an error. The batch set operation is considered atomic and if any of the set key operation fails, the entire operation is failed. Error responses should identify the affected key operations that failed. Only accessible via an authenticated server authority.

* summary
	- Set Custom Item Batch

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- customId: string
	The custom data ID specified by the user. Must be between 1 and 50 characters long and contain only alphanumeric characters, underscores, and hyphens.

	- Optional setItemBatchBody: SetItemBatchBody
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<SetItemBatchResponse, any>>

### Set Item
```
setItem(projectId: string, playerId: string, setItemBody?: SetItemBody, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<SetItemResponse, any>>
```
- Set a data item with a given key and value for the specified player. The value is limited to a maximum size of 5 MB across all default access level slots. The entire default access level saved state for a player is limited to 2000 keys. Attempting to set a new key beyond this limit will result in an error.

* summary
	- Set Player Item

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional setItemBody: SetItemBody
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<SetItemResponse, any>>

### Set Item Batch
```
setItemBatch(projectId: string, playerId: string, setItemBatchBody?: SetItemBatchBody, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<SetItemBatchResponse, any>>
```
- Set up to 20 data items with key, value and optional writeLock for the given player. The values are limited to a maximum size of 5 MB across all default access level slots for the player. The entire default access level saved state for a player is limited to 2000 keys. Attempting to set a new key beyond this limit will result in an error. The batch set operation is considered atomic and if any of the set key operation fails, the entire operation is failed. Error responses should identify the affected key operations that failed.

* summary
	- Set Player Item Batch

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional setItemBatchBody: SetItemBatchBody
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<SetItemBatchResponse, any>>

### Set Private Custom Item
```
setPrivateCustomItem(projectId: string, customId: string, setItemBody?: SetItemBody, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<SetItemResponse, any>>
```
- Set a private data item with a given key and value for the specified custom ID. The value is limited to a maximum size of 5 MB across all private access level slots. The entire private saved state for a custom ID is limited to 2000 keys. Attempting to set a new key beyond this limit will result in an error. Only accessible via an authenticated server authority.

* summary
	- Set Private Custom Item

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	-projectId: string
	ID of the project.

	- customId: string
	The custom data ID specified by the user. Must be between 1 and 50 characters long and contain only alphanumeric characters, underscores, and hyphens.

	- Optional setItemBody: SetItemBody
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<SetItemResponse, any>>

### Set Private Custom Item Batch
```
setPrivateCustomItemBatch(projectId: string, customId: string, setItemBatchBody?: SetItemBatchBody, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<SetItemBatchResponse, any>>
```
- Set up to 20 private data items with key, value and optional writeLock against the custom ID. The values are limited to a maximum size of 5 MB across all private access level slots for the custom ID. The entire private saved state for a custom ID is limited to 2000 keys. Attempting to set a new key beyond this limit will result in an error. The batch set operation is considered atomic and if any of the set key operation fails, the entire operation is failed. Error responses should identify the affected key operations that failed. Only accessible via an authenticated server authority.

* summary
	- Set Private Custom Item Batch

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- customId: string
	The custom data ID specified by the user. Must be between 1 and 50 characters long and contain only alphanumeric characters, underscores, and hyphens.

	- Optional setItemBatchBody: SetItemBatchBody
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<SetItemBatchResponse, any>>

### Set Protected Item
```
setProtectedItem(projectId: string, playerId: string, setItemBody?: SetItemBody, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<SetItemResponse, any>>
```
- Set a protected data item with a given key and value for the specified player. The value is limited to a maximum size of 5 MB across all protected access level slots. The entire protected saved state for a player is limited to 2000 keys. Attempting to set a new key beyond this limit will result in an error. Only accessible via an authenticated server authority.

* summary
	- Set Protected Player Item

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional setItemBody: SetItemBody
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<SetItemResponse, any>>

### Set Protected Item Batch
```
setProtectedItemBatch(projectId: string, playerId: string, setItemBatchBody?: SetItemBatchBody, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<SetItemBatchResponse, any>>
```
- Set up to 20 protected data items with key, value and optional writeLock for the given player. The values are limited to a maximum size of 5 MB across all slots for the player. The entire protected saved state for a player is limited to 2000 keys. Attempting to set a new key beyond this limit will result in an error. The batch set operation is considered atomic and if any of the set key operation fails, the entire operation is failed. Error responses should identify the affected key operations that failed. Only accessible via an authenticated server authority.

* summary
	- Set Protected Player Item Batch

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional setItemBatchBody: SetItemBatchBody
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<SetItemBatchResponse, any>>

### Set Public Item
```
setPublicItem(projectId: string, playerId: string, setItemBody?: SetItemBody, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<SetItemResponse, any>>
```
- Set a public data item with a given key and value for the specified player. The value is limited to a maximum size of 5 MB across all public access level slots. The entire public saved state for a player is limited to 2000 keys. Attempting to set a new key beyond this limit will result in an error. The value set will be publicly readable by any player.

* summary
	- Set Public Player Item

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional setItemBody: SetItemBody
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<SetItemResponse, any>>

### Set Public Item Batch
```
setPublicItemBatch(projectId: string, playerId: string, setItemBatchBody?: SetItemBatchBody, options?: AxiosRequestConfig<any>): Promise<AxiosResponse<SetItemBatchResponse, any>>
```
- Set up to 20 public data items with key, value and optional writeLock for the given player. The values are limited to a maximum size of 5 MB across all slots for the player. The entire public saved state for a player is limited to 2000 keys. Attempting to set a new key beyond this limit will result in an error. The batch set operation is considered atomic and if any of the set key operation fails, the entire operation is failed. Error responses should identify the affected key operations that failed.

* summary
	- Set Public Player Item Batch

* throws
	- {RequiredError}

* memberof
	- DataApi

- Parameters
	- projectId: string
	ID of the project.

	- playerId: string
	The player ID supplied by the Authorization service.

	- Optional setItemBatchBody: SetItemBatchBody
	- Optional options: AxiosRequestConfig<any>
	Returns Promise<AxiosResponse<SetItemBatchResponse, any>>