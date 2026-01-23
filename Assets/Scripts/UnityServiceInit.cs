using System;
using System.Threading.Tasks;
using Unity.Services.Core;
using UnityEngine;

public class UnityServiceInit : MonoBehaviour
{
    public static bool IsInitialized { get; private set; }

    private async void Awake()
    {
        await InitializeAsync();
    }

    public static async Task InitializeAsync()
    {
        if (IsInitialized)
        {
            return;
        }

        try
        {
            await UnityServices.InitializeAsync(); // 기존 코드와 동일 목적 :contentReference[oaicite:2]{index=2}
            IsInitialized = true;
            Debug.Log("UGS Initialized");
        }
        catch (Exception e)
        {
            Debug.LogException(e);
        }
    }
}
