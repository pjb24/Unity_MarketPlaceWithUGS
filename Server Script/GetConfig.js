/**
 * GetConfig
 * - Remote Config에서 거래소/경제 파라미터를 가져온다.
 * - 누락/형식 오류 시 디폴트 값으로 폴백하고 반드시 Warning 로그를 남긴다.
 */
const { SettingsApi } = require("@unity-services/remote-config-1.1");

module.exports = async ({ params, context, logger }) => {
  const { projectId, playerId, accessToken, environmentId } = context;

  // ===== 디폴트(기획 기준) =====
  // 수수료: 10% = 풀 6% + 소각 4%  (MT는 소수 2자리 가정) :contentReference[oaicite:2]{index=2} :contentReference[oaicite:3]{index=3}
  const defaults = {
    market: {
      feeRateTotal: 0.10,
      feeRatePool: 0.06,
      feeRateBurn: 0.04,

      // listing 만료 (일) - 기획서에 T일로만 존재. 운영 기본값으로 3일 추천.
      listingExpireDays: 3,

      // 가격 가드 (MT 단위)
      priceMin: 0.01,
      priceMax: 9999999999999.99,

      // 가격 정렬/인덱싱을 위한 버킷(선택)
      priceBucketStep: 1.0,
    },

    currency: {
      // Economy 리소스 ID(프로젝트 설정과 일치시켜라) :contentReference[oaicite:4]{index=4}
      mtCurrencyId: "MARKETTOKEN",
      ecCurrencyId: "ENERGYCREDITS",
      mtDecimals: 2,
      ecDecimals: 0,
    },

    locks: {
      // 구매 경쟁 방지 락 TTL(초)
      listingLockTtlSeconds: 10,
      playerLockTtlSeconds: 10,
    }
  };

  // Remote Config 키 네임스페이스(키 prefix)
  const keyPrefix = (params && params.keyPrefix) ? String(params.keyPrefix) : "market.";

  // 우리가 읽을 키 목록(필요한 것만 좁혀서 요청)
  const keys = [
    `${keyPrefix}feeRateTotal`,
    `${keyPrefix}feeRatePool`,
    `${keyPrefix}feeRateBurn`,
    `${keyPrefix}listingExpireDays`,
    `${keyPrefix}priceMin`,
    `${keyPrefix}priceMax`,
    `${keyPrefix}priceBucketStep`,
    `currency.mtCurrencyId`,
    `currency.ecCurrencyId`,
    `locks.listingLockTtlSeconds`,
    `locks.playerLockTtlSeconds`,
  ];

  let remoteData = null;
  try {
    const remoteConfig = new SettingsApi({ accessToken });

    // Remote Config: assignSettings (유저 기준으로 룰 적용된 settings를 받는다) :contentReference[oaicite:5]{index=5}
    const result = await remoteConfig.assignSettings({
      projectId,
      userId: playerId,
      environmentId,
      configType: "settings",
      key: keys,
      attributes: { unity: {}, app: {}, user: {} }
    });

    remoteData = result.data || null;
  } catch (err) {
    logger.warning("GetConfig: failed to fetch Remote Config. Fallback to defaults.", {
      "error.message": err?.message ?? "unknown",
    });
  }

  // ---- Remote Config 응답 구조는 object이므로, 키-값 형태를 최대한 안전하게 추출한다.
  // 보통 settings가 key/value 맵으로 내려온다고 가정하고, 아니면 폴백.
  const remoteSettings =
    (remoteData && (remoteData.settings || remoteData.configs || remoteData.data || remoteData)) || null;

  const usedFallbackKeys = [];

  const readNumber = (path, fallback) => {
    const v = remoteSettings?.[path];
    if (v === undefined || v === null || v === "") {
      usedFallbackKeys.push(path);
      return fallback;
    }
    const n = Number(v);
    if (Number.isNaN(n)) {
      usedFallbackKeys.push(path);
      return fallback;
    }
    return n;
  };

  const readString = (path, fallback) => {
    const v = remoteSettings?.[path];
    if (v === undefined || v === null || v === "") {
      usedFallbackKeys.push(path);
      return fallback;
    }
    return String(v);
  };

  // ===== 최종 구성값 생성 =====
  const cfg = {
    market: {
      feeRateTotal: readNumber(`${keyPrefix}feeRateTotal`, defaults.market.feeRateTotal),
      feeRatePool: readNumber(`${keyPrefix}feeRatePool`, defaults.market.feeRatePool),
      feeRateBurn: readNumber(`${keyPrefix}feeRateBurn`, defaults.market.feeRateBurn),
      listingExpireDays: Math.max(1, Math.floor(readNumber(`${keyPrefix}listingExpireDays`, defaults.market.listingExpireDays))),
      priceMin: Math.max(0, readNumber(`${keyPrefix}priceMin`, defaults.market.priceMin)),
      priceMax: Math.max(0, readNumber(`${keyPrefix}priceMax`, defaults.market.priceMax)),
      priceBucketStep: Math.max(0.01, readNumber(`${keyPrefix}priceBucketStep`, defaults.market.priceBucketStep)),
    },

    currency: {
      mtCurrencyId: readString("currency.mtCurrencyId", defaults.currency.mtCurrencyId),
      ecCurrencyId: readString("currency.ecCurrencyId", defaults.currency.ecCurrencyId),
      mtDecimals: defaults.currency.mtDecimals,
      ecDecimals: defaults.currency.ecDecimals,
    },

    locks: {
      listingLockTtlSeconds: Math.max(1, Math.floor(readNumber("locks.listingLockTtlSeconds", defaults.locks.listingLockTtlSeconds))),
      playerLockTtlSeconds: Math.max(1, Math.floor(readNumber("locks.playerLockTtlSeconds", defaults.locks.playerLockTtlSeconds))),
    }
  };

  // ===== 무결성 체크(치명 오류는 폴백 + 경고) =====
  // 수수료 분해가 깨지면 거래 정산이 망가진다.
  const sum = cfg.market.feeRatePool + cfg.market.feeRateBurn;
  const eps = 0.000001;
  if (Math.abs(cfg.market.feeRateTotal - sum) > eps) {
    logger.warning("GetConfig: invalid fee split. Fallback to default fee policy.", {
      feeRateTotal: cfg.market.feeRateTotal,
      feeRatePool: cfg.market.feeRatePool,
      feeRateBurn: cfg.market.feeRateBurn,
    });

    cfg.market.feeRateTotal = defaults.market.feeRateTotal;
    cfg.market.feeRatePool = defaults.market.feeRatePool;
    cfg.market.feeRateBurn = defaults.market.feeRateBurn;
    usedFallbackKeys.push(`${keyPrefix}feeRateTotal`);
    usedFallbackKeys.push(`${keyPrefix}feeRatePool`);
    usedFallbackKeys.push(`${keyPrefix}feeRateBurn`);
  }

  if (usedFallbackKeys.length > 0) {
    logger.warning("GetConfig: fallback keys used.", { usedFallbackKeys });
  }

  return {
    config: cfg,
    meta: {
      source: remoteSettings ? "REMOTE_CONFIG" : "DEFAULTS",
      usedFallbackKeys,
      environmentId,
    }
  };
};

// optional params
module.exports.params = {
  keyPrefix: { type: "String", required: false }
};