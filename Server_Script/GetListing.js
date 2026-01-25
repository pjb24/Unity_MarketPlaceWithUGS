/**
 * GetListing (Cloud Code / UGS)
 *
 * 목적:
 * - listingId로 리스팅(Custom Item)을 단건 조회한다.
 * - 옵션으로 에스크로(Custom Item)도 함께 조회한다.
 * - 데이터 불일치(리스팅은 있는데 에스크로가 없는 등) 발생 시 무음 폴백 금지:
 *   escrow 조회 옵션이 켜져 있는데 escrow가 없으면 Warning 로그를 남기고 escrow=null로 반환한다.
 *
 * 데이터 저장 위치(기본값):
 * - 리스팅(Custom Items): customId = "market_listings", key = "LISTING_<listingId>"
 * - 에스크로(Custom Items): customId = "market_escrow", key = "ESCROW_<listingId>"
 *
 * params (최대 10개):
 *  1) listingId: string (필수)
 *  2) includeEscrow: boolean (선택, 기본 false)
 *  3) includeEscrowItem: boolean (선택, 기본 false) // includeEscrow=true일 때만 의미 있음
 *  4) listingsCustomId: string (선택, 기본 "market_listings")
 *  5) escrowCustomId: string (선택, 기본 "market_escrow")
 *
 * return:
 * - listingId, listingKey, listing, escrow(optional)
 */

const { DataApi } = require("@unity-services/cloud-save-1.4");

module.exports = async function GetListing(params, context, logger) {
  const {
    listingId,
    includeEscrow,
    includeEscrowItem,
    listingsCustomId,
    escrowCustomId
  } = params || {};

  if (!listingId || typeof listingId !== "string") {
    throw new Error("GetListing: listingId is required (string).");
  }

  const _includeEscrow = includeEscrow === true;
  const _includeEscrowItem = includeEscrowItem === true;

  const _listingsCustomId = listingsCustomId || "market_listings";
  const _escrowCustomId = escrowCustomId || "market_escrow";

  const cloudSave = new DataApi(context);
  const projectId = context.projectId;

  const listingKey = `LISTING_${listingId}`;
  const escrowKey = `ESCROW_${listingId}`;

  // 1) listing 조회
  const listingRes = await cloudSave.getCustomItems(projectId, _listingsCustomId, [listingKey]);
  const listingRows = (listingRes?.data?.results || []);
  const listingRow = listingRows.find(r => r.key === listingKey);

  if (!listingRow || typeof listingRow.value !== "object" || listingRow.value === null) {
    throw new Error(`GetListing: listing not found (customId=${_listingsCustomId}, key=${listingKey}).`);
  }

  const listing = listingRow.value;

  // 2) escrow(옵션) 조회
  let escrow = undefined;

  if (_includeEscrow) {
    try {
      const escrowRes = await cloudSave.getCustomItems(projectId, _escrowCustomId, [escrowKey]);
      const escrowRows = (escrowRes?.data?.results || []);
      const escrowRow = escrowRows.find(r => r.key === escrowKey);

      if (!escrowRow || typeof escrowRow.value !== "object" || escrowRow.value === null) {
        logger.warning(`GetListing fallback: escrow missing. listingId=${listingId}, escrowKey=${escrowKey}`);
        escrow = null;
      } else {
        const escrowValue = escrowRow.value;

        if (_includeEscrowItem) {
          escrow = escrowValue;
        } else {
          // item은 무거우므로 기본 제외
          const { item, ...rest } = escrowValue || {};
          escrow = rest;
        }
      }
    } catch (e) {
      logger.warning(`GetListing fallback: failed to read escrow. listingId=${listingId}. err=${e?.message || e}`);
      escrow = null;
    }
  }

  return {
    listingId,
    listingKey,
    listing,
    escrow
  };
};