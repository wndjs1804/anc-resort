# 소노 사이트 구조 메모 (Phase 0)

> 자동 보고서는 `docs/captures/<실행시각>/report.md`. 이 파일은 **사람이 확인한 결론만** 적는다.
> 회원번호(memNo)는 실제 값을 적지 않고 `<memNo>` 로 둔다. 실제 값은 `docs/captures/` 안에만 있고 커밋되지 않는다.

## 실행 기록

| 실행 | 보고서 | 무엇을 봤나 |
|---|---|---|
| 2026-09-02 11:09 | `captures/sono-20260902-110910/report.md` | 메인 화면까지 (중단) |
| 2026-09-02 11:11 | `captures/sono-20260902-111153/report.md` | 로그인 → 객실예약 → 달력 → 날짜선택 → 객실종류·요금 → 객실보기 |
| 2026-09-02 11:25 | `captures/sono-20260902-112526/report.md` | 달력 10월 이동 · 2박 조회 · 잔여 객실 보기 |
| 2026-09-02 13:02 | `captures/sono-20260902-130226/report.md` | 자동 로그인 → **예약 유형 `본인` 선택** → 검색 → 요금 |

## 0. 결론 요약

**달력·객실·요금이 전부 JSON API 로 온다. DOM 클릭 파싱은 필요 없다.**
사이트는 Nuxt(Vue) SSR + REST API 구조이고, 화면이 쓰는 API 를 그대로 호출하면 된다.

- 공통 호스트: `https://www.sonohotelsresorts.com`
- 공통 쿼리(모든 API): `lang=ko&deviceType=PC&mobileAppYn=N`
- 응답 공통 껍데기: `{ success: boolean, error: null|…, body: … }`

## 1. 로그인 · 세션

| 항목 | 확인된 값 |
|---|---|
| 로그인 페이지 | `/member/login` |
| 아이디 입력칸 | `#lginId` |
| 비밀번호 입력칸 | `#lginPw` |
| 로그인 버튼 | `button.btn.xl.fill` (텍스트 "로그인") — 헤더에도 같은 이름의 버튼이 있으니 클래스로 구분 |
| 로그인 API | `POST /api/hms/user/management/auth/login` |
| **로그인 상태 판별** | `GET /api/hms/user/management/auth/userinfo` → 비로그인 **401**, 로그인 **200** |

`ensureSession` 은 DOM 을 볼 필요 없이 `userinfo` 의 상태코드로 판단하면 된다.
로그인 요청·응답 본문은 탐색 기록에서 통째로 가려져 있다(의도한 동작).

## 2. 선택 트리 (지역 → 숙소 → 동)

`GET /api/hms/user/memberReservation/room/placeList?memNo=<memNo>&userIndCd=Y&outsExcludeYn=N`

**한 번의 호출로 전체 트리가 나온다.** 23개 숙소 / 6개 지역.

- `body.placeList[]` : `jiyukCd`·`jiyukNm`(지역) / `placeSeq`·`placeNm`(숙소) / `storeList[]`(동)
- `storeList[]` : `storeCd`(동 코드) · `storeNm`(동 이름) · `outsYn`(위탁운영 여부)

Firestore `nodes` 매핑:

| nodes.level | 값 | siteRef |
|---|---|---|
| region | `jiyukNm` | `{ jiyukCd }` |
| property | `placeNm` | `{ placeSeq }` |
| building (bookable) | `storeNm` | `{ storeCd }` |

확인된 예: 비발디파크(placeSeq 2) → 소노벨 A `09` / 소노벨 B·C `02` / 소노캄 `07` / 소노벨 D(호텔) `54`,
델피노(placeSeq 6) → 소노벨 EAST `70` / WEST `01` / 소노캄 A·B `25` / 소노캄 C `26`.

## 3. 월 달력

`POST /api/hms/user/memberReservation/room/list/pc`

요청 본문:
```json
{ "memNo":"<memNo>", "userIndCd":"Y", "rsvIndCd":"9",
  "ciYmd":"20260911", "coYmd":"20260912", "nights":1,
  "rmCnt":1, "adultCnt":1, "childCnt":0,
  "storeCdList":["54"], "rmTypeCode":"",
  "availableRsvDate":"20270228", "availableRsvDateForJeju":"20270715", "availableRsvDateForOuts":"20270228" }
```

응답 `body[0].rmTypeList[]` — **날짜 × 객실타입** 행 (확인 사례: 29일 × 9타입 = 261행):

| 필드 | 뜻 |
|---|---|
| `ciYmd` | 날짜 (yyyyMMdd) |
| `rmTypeCd` | 객실타입 코드 |
| `rsvStatusCd` / `rsvStatusNm` | 상태 |
| `rsvRmCnt` | 잔여 객실수 — **음수가 올 수 있다**(예: `-2`). 초과 대기 상태로 보인다. 0 으로 눌러서 쓴다 |

**상태 코드 매핑 (실제 응답에서 확인) — CLAUDE.md §12 해결:**

| 코드 | 사이트 표기 | 우리 코드 |
|---|---|---|
| `A` | 예약원활 | `available` |
| `E` | 마감임박 | `closing` |
| `W` | 예약대기 | `waitlist` |
| `D` | 예약마감 | `full` |
| `N` | 예약불가 | `full` — 2026-09-02 소노벨 A 에서 처음 확인 |

> 달력 한 칸은 그 날짜 행들을 합쳐야 한다(타입별로 상태가 다름). 합치는 규칙은 Phase 2에서 정한다.

**월 이동 (2차 탐색에서 확인):** `ciYmd` 를 원하는 달의 날짜로 두고 `coYmd = ciYmd + 1` 이면 그 달 전체가 온다.

| 요청 ciYmd | 응답 날짜 범위 | 행 수 |
|---|---|---|
| 20260902 (당월) | 20260902 ~ 20260930 (29일) | 261 |
| 20261002 (다음달) | 20261001 ~ 20261031 (31일) | 279 |

→ **지난 날짜는 잘려서 온다.** 당월 요청 시 1일이 아니라 오늘(9/2)부터 시작했다. 화면에서 전월 이동은 의미가 없다.

**박수와 무관 (2차 탐색에서 확인):** `nights:1` 과 `nights:2` 응답을 같은 날짜·객실타입끼리 비교한 결과
**261행 전부 값이 같았다.** 달력 상태는 언제나 날짜별 1박 기준이다.
(`nights:2` 는 응답 범위만 하루 늘린다: 20260902~20261001)
→ CLAUDE.md §8 "달력은 항상 1박 기준으로 조회한다" 가 사이트 동작과 일치한다.

## 4. 날짜 상세 (객실 목록)

`POST /api/hms/user/memberReservation/room/detail`

```json
{ "storeCdList":["54"], "rsvIndCd":"9", "memNo":"<memNo>", "actualMemNo":"<memNo>",
  "rsvBlckCd":"000", "userIndCd":"Y",
  "ciYmd":"20260911", "coYmd":"20260912", "nights":1,
  "rmCnt":1, "adultCnt":1, "childCnt":0 }
```

응답 `body[]` 가 **계층 그대로** 온다 → Firestore `rooms.path` 에 그대로 넣으면 된다:

```
body[]            resortTypeNm(호텔) / roomTypeNm(슈페리어·디럭스…)
  └ viewList[]    viewNm (스탠다드 · 파크뷰 …)
      └ rmTypeList[]  rmTypeNm, bedNm(킹 트윈…), cookNm(취사)
```

`rmTypeList[]` 항목의 쓸모 있는 필드:

| 필드 | 뜻 | 화면 |
|---|---|---|
| `rsvStatusCd` / `rsvStatusNm` | 상태 | 상태 뱃지 |
| `rsvRmCnt` | 잔여 객실수 — **음수가 올 수 있다**(예: `-2`). 초과 대기 상태로 보인다. 0 으로 눌러서 쓴다 | |
| `waitSeq` | 대기 순번/인원 | `waitCount` |
| `partialAvailableDays` / `partialWaitDays` | 연박 중 가능한 일수 / 대기인 일수 | "○일만 가능" |
| `dongCd` / `dongNm` | 동 | 확인 사례는 `00`/`기본` |
| `rmTypeCd` | 요금 조회 키 | |
| `petYn`, `penaltyYn`, `ciOverStnd` | 반려동물·위약·기준초과 | |

확인 사례(소노벨 D 호텔): 3그룹 × 전망 → **객실타입 9개**.

**연박 상태 `T` = 부분마감 (2차 탐색에서 확인)** — 달력에는 없고 상세 응답에만 나오는 코드다.

2박(20260910~20260912) 조회 결과 9개 중 2개가 `T 부분마감`, `partialAvailableDays:1`, `partialWaitDays:1` 이었다.
달력 데이터와 교차검증하면 이유가 그대로 드러난다:

| 날짜 | 달력상 상태(00HSP205) |
|---|---|
| 20260910 | `E` 마감임박 (잔여 1) |
| 20260911 | `W` 예약대기 (잔여 0) |

→ 2박 중 첫날만 가능해서 `부분마감`. **`partialAvailableDays` 는 "며칠"만 알려주고 "어느 날"인지는 안 알려준다.**
   CLAUDE.md §6 의 `availableNights`(가능한 날짜 목록)는 **달력 응답과 대조해서 계산**해야 한다. 같은 `rmTypeCd` 로
   날짜별 상태가 달력에 다 있으므로 추가 호출 없이 구할 수 있다.

전체 상태 코드 (달력 + 상세 통합):

| 코드 | 표기 | 우리 코드 | 어디에 나오나 |
|---|---|---|---|
| `A` | 예약원활 | `available` | 달력 |
| `E` | 마감임박 | `closing` | 달력 · 상세 |
| `W` | 예약대기 | `waitlist` | 달력 · 상세 |
| `D` | 예약마감 | `full` |
| `N` | 예약불가 | `full` — 2026-09-02 소노벨 A 에서 처음 확인 | 달력 |
| `T` | 부분마감 | `partial` | 상세(연박)만 |

`waitSeq` 는 값이 없을 때 `null` 로 온다(1차 탐색 1박에서는 `1`, 2차 2박에서는 전부 `null`). 없으면 표시하지 않는다.

## 4-1. 예약 유형 · 회원권 (2026-09-02 확인)

로그인 후 예약 화면에 들어가면 단계가 두 개 더 있다. 브라우저에 이전 선택이 남아 있으면 건너뛰어져서 안 보인다.

| 단계 | URL | 내용 |
|---|---|---|
| 회원권 선택 | `/reserve/room?step=memTicket` | 회원권이 1개면 그냥 지나간다 |
| 예약 유형 선택 | `/reserve/room?step=ty` | `본인(정회원/가족회원)` / `회원초청` |

**`본인(정회원/가족회원)` 을 고르면 `rsvIndCd: "9"` 가 나간다 — 우리가 쓰는 값과 같다. 회원가 기준이 맞다.**
(`회원초청` 일 때의 값은 확인하지 않았다. 우리는 쓸 일이 없다.)

이 계정의 회원권은 1개다: `콘도회원 · 계약자 · 무기명 · 스위트 (무기명)`.
화면은 `memPyeongNm: "스위트 (무기명)"` 과 `paymentType: null` 도 함께 보내지만,
**이 두 값을 빼고 호출해도 정상 동작한다**(Phase 1 수집 386건이 그렇게 수집됐다).

## 4-2. 위탁운영 숙소 (2026-09-02 확인)

`outsYn: "Y"` 인 숙소 3곳(**파나크 영덕 `91` · 팔라티움 해운대 `92` · 소노벨 경주 감포 `95`)은 요금 방식이 다르다.

- 요금 API(`room/detail/price`)를 부르면 **HTTP 400** 이 난다:
  `{"errorId":"W63M3S1","errorMessage":"금액계산구분코드는 필수입니다."}`
- 대신 **객실 목록 응답에 금액이 함께 온다.** 단, 요청에 아래 두 값을 넣어야 채워진다:

```json
{ "...": "...", "outsMemNo": "", "outsBrandSeq": -1 }
```

이 두 값이 없으면 `outsTotAmt` 가 `null` 로 온다. 그래서 한동안 이 3곳만 금액이 비어 있었다.

| 필드 | 뜻 |
|---|---|
| `outsItemCd` | 위탁 상품 코드 (있으면 위탁 객실이라는 뜻) |
| `outsTotAmt` | **금액** — 이 값을 그대로 쓴다 |
| `outsRmTpCd` | 위탁 객실타입 코드 |

→ 어댑터는 `outsItemCd` 가 있으면 요금 API 를 **아예 부르지 않는다.**
   날짜별 내역은 주지 않으므로 합계만 표시한다.
   **미확인**: `outsTotAmt` 가 1박 금액인지 기간 합계인지 (1박으로만 확인함).

## 5. 요금

`POST /api/hms/user/memberReservation/room/detail/price` — **객실타입 1개당 1회 호출**

```json
{ "memNo":"<memNo>", "ciYmd":"20260911", "coYmd":"20260912", "rsvBlckCd":"000",
  "storeCd":"54", "userIndCd":"Y", "rsvIndCd":"9", "rmTypeCd":"00HDX213",
  "rmCnt":1, "preAftPayYn":"N" }
```

응답 `body`:

| 필드 | 뜻 | 화면 |
|---|---|---|
| `totAmt` | **최종 결제액(회원가)** | `total` |
| `originAmt` | 할인 전 원가 | |
| `dcAmt` / `levelAmt` | 할인액 (등급할인은 `levelAmt`) | |
| `daysAmtInfoList[]` | 날짜별 내역 | `perNight` |
| `benefitDiscountList[]` | 혜택 할인 내역 | |

### ⚠ 할인은 빼지 않는다 (2026-09-02 사용자 확인)

**`daysAmtInfoList[].totAmt` 를 그대로 쓴다.** 여기서 `levelAmt`·`dcAmt` 를 빼면 안 된다.
직원에게는 할인 반영 전 금액을 보여주는 것이 맞다(사용자 결정).

한동안 빼서 보여줬다. 코드를 고친 뒤에도 **Firestore 에 저장된 옛 결과가 화면에 계속 보였다** —
계산식을 바꿀 때는 `details` · `snapshots` 컬렉션을 비워야 한다.

참고로 응답의 필드 관계는 이렇다(빼지는 않지만 알아 둘 것):

실제 응답 예 (소노펫 비발디파크, 1박):

```json
{ "totAmt": 256000, "originAmt": 286000, "levelAmt": 30000, "dcAmt": 0,
  "daysAmtInfoList": [ { "stndYmd": "20260918", "totAmt": 286000, "levelAmt": 30000, "dcAmt": null } ] }
```

| 위치 | `totAmt` 의 뜻 |
|---|---|
| 최상위 | **최종가** 256,000 (할인 적용 후) |
| `daysAmtInfoList[]` | **원가** 286,000 (할인 적용 전) |

→ 날짜별 최종가 = `daysAmtInfoList[].totAmt − (levelAmt + (dcAmt ?? 0))`.
   CLAUDE.md §6 의 `perNight: { base, discount, final }` 로 옮길 때 이 규칙을 쓴다.
   `dcAmt` 는 값이 없을 때 `null` 로 온다 — `0` 이 아니다.

→ Firestore `details.rooms[].perNight` 에 그대로 대응된다.
**주의:** 객실타입 9개면 요금 호출 9번. 10초 목표를 맞추려면 병렬 호출해야 한다(Phase 2).

## 6. 객실 사진 · 정원

- `POST /api/hms/user/management/room/reserveRoomLinkUrlMulti`
  요청 `{"condition":[{"storeCd":"54","rmTypeCd":"00HSP205"}, …]}`
  응답 `[{ storeCd, rmTypeCd, linkUrl:"/belle_vp/rooms/detail/RM00029504", facilityCd:"RM00029504" }, …]`
  → **rmTypeCd → 객실 상세 페이지(facilityCd) 매핑**을 한 번에 얻는다.
- **정원·면적·사진 API (Phase 1에서 확인):**
  `GET /api/hms/user/management/room/detail?facilityCd=RM00029965`
  **로그인 없이도 200 으로 응답한다.** 페이지를 띄울 필요 없이 직접 부르면 된다.

| 필드 | 예시 | 비고 |
|---|---|---|
| `facilityNm` | `디럭스 스탠다드` | |
| `personCnt` | `<p>2인(더블+싱글 최대 3인)</p>` | **HTML 문자열**. 태그 제거 후 "기준 N인 / 최대 M인" 을 파싱해야 한다 |
| `roomPyeong` | `<p>46.62㎡</p>` | 면적 |
| `bedType` / `configuration` | `<p>더블+싱글</p>` / `<p>침실, 화장실</p>` | |
| `images[]` | `fileFetchId: "Peu11nD-…"` | 사진 주소 = `/api/hms/user/management/file/image/<fileFetchId>/1` |

  정원이 정형 필드가 아니라 문장이라 파싱이 필요하다. 파싱에 실패하면 `capacityText` 에 원문을 남긴다.

## 6-1. `잔여 객실 보기` — 별도 API 없음 (CLAUDE.md §12 결론)

이 화면을 여는 동안 **네트워크 요청이 하나도 발생하지 않았다**(사용자가 눌렀고 화면은 정상적으로 떴다).
즉 이미 받아 둔 `room/list/pc` 응답을 다시 그리는 화면이다. 전용 엔드포인트는 없다.

그리고 이번 세션의 `room/list/pc` 호출은 **전부 `storeCdList:["54"]` 한 동뿐이었다**.
따라서 그 화면이 보여줄 수 있었던 것은 선택한 동의 **객실종류별·날짜별 잔여수**(`rsvRmCnt`)이지,
여러 동을 나란히 비교하는 화면이 아니다.

→ **"한 숙소의 여러 동 잔여를 한 번에 주는 페이지"는 없다.** `getBuildingSummary` 를 만들려면 우리가 직접 모아야 한다.

다만 응답이 이렇게 생겼다는 점이 중요하다:

```
body: [ { storeCd, storeNm, rmTypeList:[…] } ]     ← 동 단위 배열
```

**응답 구조가 이미 동 여러 개를 담을 수 있게 돼 있다.** 요청의 `storeCdList` 도 배열이다.
화면이 항상 1개만 보내서 확인되지 않았을 뿐, 여러 개를 넣으면 한 번에 올 가능성이 높다.

**2026-09-02 확인: `storeCdList` 다중이 동작한다.** `["70","01","25","26"]` 로 요청하니 동 4개가 한 번에 왔다.

```
70 소노벨 델피노 East : 651행 / 31일
01 소노벨 델피노 West : 124행 / 31일
25 소노캄 델피노 A · B: 155행 / 31일
26 소노캄 델피노 C    :  31행 / 31일
```

→ `getBuildingSummary` 는 **API 호출 1회**로 끝난다. 동별 개별 호출 대비 비용이 없다.
   (어댑터는 응답에 동이 덜 오면 자동으로 개별 호출로 넘어가게 해 뒀다.)

## 6-2. Phase 1 수집 결과에서 드러난 사실 (2026-09-02)

동 35개 전부에서 객실 **386건**을 수집했다. 그중 **23건은 `reserveRoomLinkUrlMulti` 가 `facilityCd` 를 주지 않는다.**
= 소노 사이트에 그 객실의 소개 페이지가 없다는 뜻이고, 따라서 **정원·면적·사진도 없다.**

| 숙소 | 위탁운영 | 누락 |
|---|---|---|
| 파나크 영덕 | Y | 11 / 15 |
| 팔라티움 해운대 | Y | 6 / 20 |
| 그 외 6개 숙소 | N | 각 1건씩 |

→ 17/23 이 **위탁운영(`outsYn: "Y"`) 숙소**에 몰려 있다. 소노가 직접 운영하지 않아 객실 소개 페이지를 두지 않는 것으로 보인다.
   우리 코드 문제가 아니므로 고칠 수 없다. 화면은 사진이 없으면 아이콘으로 대체한다(CLAUDE.md §9).

그 밖에:
- 정원 문구에 숫자가 없는 경우가 있다. 예: `더블+싱글(카펫)` → 정원 파싱 불가, 원문만 남긴다.
- 객실 계층이 3단인 숙소가 있다(소노문 해운대: 전망 단계가 비어 있음). 화면은 계층 깊이를 고정하지 않으므로 그대로 렌더링하면 된다.

## 7. 그 밖에 확인된 엔드포인트

| 용도 | 엔드포인트 |
|---|---|
| 객실종류 필터 목록 | `POST /api/hms/user/memberReservation/room/filter` |
| 휴일 목록 | `GET /api/hms/user/memberReservation/holiday/list` |
| 시설 중단 안내 | `GET /api/hms/user/management/stopFacility/detail?storeCd&ciYmd&coYmd` |
| 위약 대상 객실 | `GET /api/hms/user/ebiz/reserve/rsv/penalty/room/list?memNo&storeCd&useDt&nights` |
| 동 이름 | `GET /api/hms/user/management/store/name/<storeCd>` |
| 예약 세션 확인 | `POST /api/hms/user/memberReservation/room/reserve/session/check` |

## 8. 남은 확인 사항

- [x] ~~**다음 달** 달력~~ → `ciYmd` 를 그 달 날짜로. 지난 날짜는 잘려서 온다. (§3)
- [x] ~~**연박**~~ → `T 부분마감` + `partialAvailableDays`/`partialWaitDays` 로 온다. (§4)
- [x] ~~**`잔여 객실 보기`**~~ → 전용 API 없음. 이미 받은 데이터를 다시 그리는 화면. (§6-1)
- [x] ~~**`storeCdList` 에 동 여러 개**~~ → 된다. 호출 1회로 동별 잔여 완성. (§6-1)
- [x] ~~**정원·사진** JSON API~~ → `management/room/detail?facilityCd=…`, 비로그인 접근 가능. (§6)
- [x] ~~**`rsvIndCd:"9"` 가 본인(정회원/가족회원) 인지**~~ → 맞다. 회원가 기준. (§4-1)
- [ ] `rsvBlckCd:"000"`, `userIndCd:"Y"`, `availableRsvDate` 의 의미와 고정값 여부
      (지금은 화면이 보내던 값을 그대로 상수로 박아 뒀다 — `seed-master.ts` 상단 `TODO(verify)`)
- [ ] 회원번호는 `GET /api/hms/user/management/member/reserve/representativeMemberNo` 가 문자열로 준다.
      회원권이 여러 개인 경우(`member/reserve/memberNoList`) 어떻게 다뤄야 하는지 미확인.
- [ ] 세션 쿠키 이름·수명 (재접속 시 로그인 유지 기간)
- [ ] 점검 팝업·차단 화면의 실제 모습 (이번에는 나타나지 않음)

## 8-1. Phase 2 검증 결과 (2026-09-02)

델피노 · 소노벨 EAST 기준, 저장된 세션으로 재실행:

| 단계 | 시간 |
|---|---|
| 세션 확보 (복원) | 0.2초 |
| 달력 1개월 | 0.6초 |
| 상세 2박 (객실 21종, 요금 21회 병렬) | 3.6~4.0초 |
| 동별 잔여 (동 4개) | 0.9초 |
| **전체** | **6.4초** |

객실 21종은 전체 35개 동 중 **가장 많은 경우**다. 10초 목표에 여유가 있다.
첫 로그인은 53초 걸리지만, Cloud Run `--min-instances=1` 로 세션을 상시 유지하면 사용자에게는 보이지 않는다.

세션 재사용도 확인됐다: **두 번 실행에 로그인 1회**. 저장된 세션은 4.3KB(암호화)다.

**요금 검증**: 날짜별 금액 합계가 최종가와 모두 일치했다(예: 159,000 + 199,000 = 358,000).

## 9. 안전 관련 메모

- 이번 탐색에서 캡차·차단·비정상 리다이렉트는 **없었다**.
- 조회에 쓰는 API 는 모두 GET 이거나 조회용 POST 다. 예약을 만드는 엔드포인트는 이 문서에 적지 않는다.
