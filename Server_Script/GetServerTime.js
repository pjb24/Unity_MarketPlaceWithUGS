/**
 * GetServerTime
 * - 서버 기준 현재 시각 반환
 * - 클라이언트 시간 신뢰 금지
 */
module.exports = async function GetServerTime(context) {
  const now = new Date();

  const epochMillis = now.getTime();
  const iso = now.toISOString();

  // 파생 값 (실무에서 바로 쓰기 좋게)
  const epochSeconds = Math.floor(epochMillis / 1000);

  return {
    serverTime: {
      iso, // "2026-01-23T01:12:34.567Z"
      epochMillis, // 1737604354567
      epochSeconds // 1737604354
    }
  };
};