# Unity Marketplace with UGS

`Unity_MarketPlaceWithUGS`는 **Unity Gaming Services(UGS)** 기반으로 구현한
로그라이트 RPG용 거래소/경제 백엔드 프로토타입 프로젝트입니다.

핵심 목표는 다음과 같습니다.
- 서버 권한(Cloud Code) 기반의 안전한 거래 처리 구조를 만드는 것입니다.

---

## 1) 프로젝트 한눈에 보기

### 거래/정산 백엔드 방향
- 아이템 등록 시 인벤토리(Protected Items)에서 에스크로(Custom Items)로 이동
- 리스팅 데이터/인덱스 분리 저장
- 구매/취소/강제종료/만료/정산(수수료 포함) 시나리오를 Cloud Code 스크립트로 분리
- 로그 및 롤백 경고를 포함해 “무음 실패”를 줄이는 구현 철학

---

## 2) 기술 스택

- **Unity Editor**: `6000.3.2f1`
- **핵심 서비스 패키지**
  - Cloud Code (`com.unity.services.cloudcode`)
  - Cloud Save (`com.unity.services.cloudsave`)
  - Economy (`com.unity.services.economy`)

---

## 3) 폴더 구조

- `Server_Script/`
  - 거래소/인벤토리 이동/락/정산/조회 관련 Cloud Code JavaScript 스크립트
- `Docs/`
  - 게임 경제 설계 문서, UGS 서비스 정리 문서
- `Assets/`, `ProjectSettings/`, `Packages/`
  - Unity 프로젝트 기본 구성

대표 스크립트 예시:
- 생성/조회: `CreateListing.js`, `GetListing.js`, `QueryListings.js`, `GetMyListings.js`
- 거래 처리: `BuyListing.js`, `CancelListing.js`, `ForceCloseListing.js`, `ClaimEarning.js`
- 에스크로/락: `MoveItemToEscrow.js`, `ReturnItemFromEscrow.js`, `TransferItemEscrowToBuyer.js`, `AcquireTxnLock.js`, `ReleaseTxnLock.js`
- 경제/지갑: `GetWallet.js`, `DebitCurrency.js`, `CreditCurrency.js`, `BurnCurrency.js`, `AddToSeasonPool.js`

---

## 4) 서버 스크립트 처리 흐름(요약)

1. **판매 등록(Create Listing)**
   - 판매 대상 아이템 검증
   - 인벤토리 → 에스크로 이동
   - 리스팅 레코드 + 검색 인덱스 저장

2. **구매(Buy Listing)**
   - 트랜잭션 락 획득
   - 상태/가격/잔액 검증
   - 통화 차감 및 수익 분배 처리
   - 에스크로 아이템 구매자 이전
   - 리스팅 상태 종료/정리

3. **정산(Claim Earning)**
   - 판매자 미정산 수익을 지갑으로 반영
   - 리포트/장부(ledger) 기록

4. **만료/운영 작업(Batch/Force)**
   - 만료된 리스팅 회수
   - 필요 시 강제 종료 및 정합성 복구

---

## 5) 함께 보면 좋은 문서

- 게임 기획 및 경제 구조: `Docs/01. 장비 파편 기반 로그라이트 RPG.md`
- 장비 파편 정의: `Docs/06.01 장비 파편 정의.md`
- 장비 아이템 정의: `Docs/06.02 장비 아이템 정의.md`
- Cloud Save 참조: `Docs/unity-services-cloud-save-1_4.md`
- Economy 참조: `Docs/unity-services-economy-2_4.md`

---

## 6) 이 프로젝트를 소개할 때 사용할 수 있는 한 줄 설명

> Unity UGS(Cloud Code/Cloud Save/Economy)를 활용해,
> 장비 파편 기반 로그라이트 RPG의 플레이어 주도 거래소와 시즌 경제 흐름을 서버 권한으로 구현한 레퍼런스 프로젝트.