using System;
using System.Collections.Generic;
using UnityEngine;

[CreateAssetMenu(
    fileName = "ItemStaticDatabase",
    menuName = "Game/Item/Item Static Database"
)]
public sealed class ItemStaticDatabase : ScriptableObject
{
    [SerializeField]
    private List<ItemStaticEntry> _entries = new();

    private Dictionary<string, ItemStaticEntry> _entryMap;

    private void OnEnable()
    {
        BuildCache();
    }

    private void BuildCache()
    {
        _entryMap = new Dictionary<string, ItemStaticEntry>(_entries.Count);

        foreach (var entry in _entries)
        {
            if (string.IsNullOrEmpty(entry.GroupKey))
            {
                Debug.LogWarning("[ItemStaticDatabase] groupKey가 비어있는 항목이 있다.");
                continue;
            }

            if (_entryMap.ContainsKey(entry.GroupKey))
            {
                Debug.LogWarning($"[ItemStaticDatabase] 중복 groupKey 감지: {entry.GroupKey}");
                continue;
            }

            _entryMap.Add(entry.GroupKey, entry);
        }
    }

    public bool TryGet(string groupKey, out ItemStaticEntry entry)
    {
        if (_entryMap == null)
        {
            Debug.LogWarning("[ItemStaticDatabase] 캐시 미구성 상태. 재빌드 수행.");
            BuildCache();
        }

        return _entryMap.TryGetValue(groupKey, out entry);
    }
}

[Serializable]
public struct ItemStaticEntry
{
    [SerializeField] private string _groupKey;
    [SerializeField] private Sprite _image;
    [SerializeField] private string _itemName;

    public string GroupKey => _groupKey;
    public Sprite Image => _image;
    public string ItemName => _itemName;
}
