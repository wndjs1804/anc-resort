# 한화리조트 사이트 구조 메모 (Phase 6 / 탐색)

> 자동 보고서: `docs/captures/hanwha-<실행시각>/report.md`
> 회원번호·고객번호는 `<MEMB_NO>` · `<CUST_NO>` 로 둔다.

## 실행 기록

| 실행 | 보고서 | 무엇을 봤나 |
|---|---|---|
| 2026-09-02 17:21 | `captures/hanwha-20260902-172155/report.md` | 로그인 → 회원권 비밀번호 → 객실예약 → 날짜별 잔여 → 요금 |

## ⚠ 이번 탐색에서 있었던 일 (반드시 기억)

한화 로그인은 `POST /static/j_spring_security_check.sec` 로 `j_username` · `j_password` 를 보낸다.
탐색 스크립트의 인증 URL 판정과 필드 이름 목록이 이걸 못 걸러서 **아이디·비밀번호가 평문으로 기록됐다.**
기록은 지웠고, 규칙을 이렇게 고쳤다:

- 인증 URL 판정에 `security` · `j_spring` · `_check` · `.sec` · `session` 추가
- 필드 이름을 **부분 일치**로 검사 (`j_password` 처럼 접두사가 붙어도 걸리게)
- `pw` · `pwd` 로 끝나는 이름 전부 (`lginPw` 등)

## 0. 결론 요약

**JSON API 구조다. 그런데 소노·아난티와 방식이 또 다르다.**

- 본 사이트: `https://www.hanwharesort.co.kr` (로그인)
- 예약 사이트: `https://booking.hanwharesort.co.kr`
- **엔드포인트가 사실상 하나다**: `POST /rst/cmn/doExecute.mvc`
  무엇을 조회할지는 본문의 **`INTF_ID`** 로 정한다.
- 요청 본문 형식: `ds={"ds_search":[{…}],"serviceInfo":{"INTF_ID":"…","RECV_SVC_CD":"…"}}` (urlencoded)
- 응답: `{ ds: { Data: { ds_result: [...] }, MessageHeader: {...} } }`

**세 리조트 비교**

| | 소노 | 아난티 | **한화** |
|---|---|---|---|
| 달력에 날짜별 상태 | ○ | ✗ (오픈여부만) | **○** |
| 잔여 객실수 | ○ | 강남만 | **○ (`RSRV_POSBL_CNT`)** |
| 대기 정보 | ○ | ✗ | **○ (`WAIT_SEQ`, `WAIT_POSBL_CNT`)** |
| 날짜별 요금 내역 | ○ | ✗ (합계만) | **○ (`ds_rsrvDrateList`)** |
| 달력+객실 한 번에 | ✗ | ✗ | **○ (한 호출로 날짜×객실타입 전부)** |

→ **데이터가 가장 풍부하다.** 달력 한 번 부르면 날짜별·객실타입별 상태와 잔여수가 다 온다.

## 1. 로그인 (3단계)

| 단계 | 주소 |
|---|---|
| ① 아이디·비밀번호 | `https://www.hanwharesort.co.kr/irsweb/resort3/member/login.do` — `#id` · `#pwd` · `#btnLogin` |
| ② **회원권 비밀번호** | `/irsweb/resort3/member/login_membership_password.do` — **폼 구조 미확인** |
| ③ 완료 | `/irsweb/resort3/member/login_success_forword.do` → `/irsweb/resort3/index.do` |

- 캡차·보안키패드 **없음**
- 실제 인증 POST 는 `/static/j_spring_security_check.sec` (Spring Security)
- 세션 확인용 API: `POST /irsweb/resort3/sessionCheck.do`
- **어댑터를 만들려면 회원권 비밀번호를 비밀 하나로 더 받아야 한다** (`HANWHA_MEMBER_PW`)

## 2. 조회에 필요한 식별자

| 이름 | 예 | 뜻 |
|---|---|---|
| `CORP_CD` | `1000` | 법인 코드 (고정으로 보임) |
| `CUST_NO` | `<CUST_NO>` (10자리) | 고객번호 |
| `MEMB_NO` | `<MEMB_NO>` (9자리) | 회원번호 |
| `BRCH_CD` · `LOC_CD` | `0100` · `0101` | **사업장 · 세부 위치** |
| `ROOM_TYPE_CD` | `FTB`, `FAM`, `RYL` … | 객실 타입 |

## 3. 숙소 목록 — `INTF_ID: TFO00HBSITSCTM0160`

요청 `{"CUST_NO":"<CUST_NO>","HOTEL_RESORT_DIV":""}` → **16곳**이 한 번에 온다.

| BRCH_CD | LOC_CD | 이름 |
|---|---|---|
| 0100 | 0101 | 설악 쏘라노 |
| 0100 | 0102 | 설악 별관 |
| 0400 | 0401 | 용인 |
| 0700 | 0701 | 산정호수 |
| 0800 | 0801 | 해운대 |
| 0900 | 0901 | 대천 |
| 1000 | 1001 | 경주 에톤 |
| 1000 | 1002 | 경주 담톤 |
| 1100 | 1101 | 제주 |
| 1600 | 1601 | 평창 |
| 2100 | 2101 | 거제 벨버디어 |
| 2100 | 2102 | 거제 르 씨엘 |
| 2200 | 2201 | 여수 벨메르 |
| 2400 | 2401 | 브리드호텔 양양 |
| 2600 | 2601 | 마티에 오시리아 |
| 3900 | 3901 | 더플라자 호텔 |

같은 사업장(`BRCH_CD`)에 위치(`LOC_CD`)가 여럿인 곳이 있다(설악·경주·거제)
→ 소노의 "숙소 > 동" 과 같은 2단 구조로 넣으면 된다.

## 4. 달력 + 객실별 잔여 — `INTF_ID: TFO00HBSREMPRR0113`

**한 번의 호출로 날짜 × 객실타입 전부가 온다.** 확인 사례: **450건 = 30일 × 객실 15종**

요청 `ds_search`:
```json
{ "CORP_CD":"1000", "BRCH_CD":"0100", "LOC_CD":"0101",
  "CUST_NO":"<CUST_NO>", "MEMB_NO":"<MEMB_NO>", "MEMB_DIV_CD":"01",
  "WAIT_RSRV_YN":"N", "CONT_NO":"", "MEMB_MAST_NO":"", "CUST_IDNT_NO":"", "RSRV_LOC_CD":"" }
```
`STRT_DATE`·`END_DATE`로 월의 시작일과 마지막 날을 지정한다. 2026-09-10 운영 API에서 2026년 11월 30일치와 12월 31일치 응답을 확인했다.

응답 `ds_result[]`:

| 필드 | 뜻 |
|---|---|
| `SESN_DATE` | 날짜 (yyyyMMdd) |
| `ROOM_TYPE_CD` / `ROOM_TYPE_NM` | 객실 타입 |
| `RSRV_POSBL_YN` | 예약 가능 `Y`/`N` |
| `MSG` | 사람이 읽는 상태 |
| `RSRV_POSBL_CNT` | **예약 가능 실수** |
| `ALLC_ROOM_CNT` | 배정 객실수 |
| `WAIT_POSBL_CNT` / `WAIT_SEQ` | 대기 가능 수 / 대기 순번 |
| `SESN_NM` | 요금 시즌 (`가을 비수기 수요일`) |
| `PP_DSCNT_RT` | 할인율 |

확인된 `MSG` 값:

| MSG | `RSRV_POSBL_YN` | 우리 코드 |
|---|---|---|
| `예약가능` | Y | `available` (잔여수로 `closing` 판단 가능) |
| `대기예약` | N | `waitlist` |
| `예약불가( 대기통보종료일 대상 )` | N | `full` |

객실타입 15종 확인: `DMO FAM FSS FTB FTL GLA HTE HTL PLT RMO RYE RYL TH1 TH2 TH3`

## 5. 요금 — `INTF_ID: TFO00HBSREMPRR2001`

요청 `ds_rsrvMast` 주요 키:
```json
{ "CORP_CD":"1000", "BRCH_CD":"0100", "LOC_CD":"0101",
  "CUST_NO":"<CUST_NO>", "MEMB_NO":"<MEMB_NO>",
  "ARRV_DATE":"20260905", "CHKOT_EXPT_DATE":"20260906", "OVNT_CNT":"1",
  "ROOM_TYPE_CD":"FTB", "_RowType_":"I" }
```

⚠ `_RowType_: "I"` 는 프레임워크가 "새 행" 을 표시하는 값일 뿐 **예약을 만들지 않는다.**
확인: 이 호출 5건 모두 `RSRV_NO` 가 빈 값이고 응답은 금액 정보뿐이었다.

응답:

| 위치 | 뜻 |
|---|---|
| `ds_totAmt[0].TOT_AMT` | **합계** |
| `ds_rsrvDrateList[]` | **날짜별 내역** — `BSN_DATE` · `STDR_ROOM_RATE` · `BSN_ROOM_RATE` · `SESN_NM` |
| `ds_rsrvRoomRateList[]` | 객실별 요금 |
| `ds_earlyBirdDscntList[]` | 얼리버드 할인 |
| `MessageHeader.MSG_DATA_SUB[0].MSG_CTNS` | `정상적으로 처리되었습니다.` |

## 6. 그 밖에 확인된 INTF_ID

| INTF_ID | 짐작되는 용도 |
|---|---|
| `TFO00HBSSLESTA0604` | 공통 코드/상태 |
| `TFO00HBSITSCTM9000` | 고객 정보 |
| `TFO00HBSREMPRR0120` | 회원 예약 관련 |
| `TFO00HBSREMPRR2009` | 예약 가능 확인 |
| `TFO00HBSREMPRR0160` | 객실 배정 확인 |
| `TFO00HBSREMPRR0119` | 예약 접수 구분 |
| `TFO00HBSREMPRR0111` | 고객 부가정보 |
| `TFO00HBSITSCTM0032` | 예약 안내문 |
| `TFO00HBSMEMMBM1701` | 회원권 정보 |
| `getCmnCode.mvc` (`GRP_CD`) | 공통 코드 목록 |

## 7. 남은 확인 사항

- [ ] **회원권 비밀번호 화면의 폼 구조** (`login_membership_password.do`) — 어댑터 자동 로그인에 필요
- [x] `REMPRR0113`의 `STRT_DATE`·`END_DATE`로 요청한 한 달 전체 조회 확인. 월 이동 시 해당 월을 별도 호출한다.
- [ ] `CUST_NO` · `MEMB_NO` 를 어떤 API 로 얻는가 (지금은 페이지에서 오는 것으로 보임)
- [ ] 회사 회원권으로 실제 쓸 수 있는 숙소가 16곳 전부인지
- [x] 사진 경로 확인(2026-09-10): 공개 `rs_room.do?bp_cd=LOC_CD&rm_cd=ROOM_TYPE_CD`에서 객실별 갤러리를 읽을 수 있음. 15개 위치의 선택 목록 확인, 저장 상세 63종 코드 일치. 이후 더플라자 5객실도 코드·이름으로 매핑하여 총 144객실 사진 연결·배포 완료. [조사 결과](hanwha-images/README.md).
- [ ] `RSRV_POSBL_CNT` 가 몇 이하일 때 `마감임박` 으로 볼지 (기준 정하기)
