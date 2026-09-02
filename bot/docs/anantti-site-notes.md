# 아난티 사이트 구조 메모 (Phase 6 / 탐색)

> 자동 보고서: `docs/captures/anantti-<실행시각>/report.md`
> 이 파일에는 **확인된 것만** 적는다. 회원번호는 `<memNo>`, 고객번호는 `<guestNo>` 로 둔다.

## 실행 기록

| 실행 | 보고서 | 무엇을 봤나 |
|---|---|---|
| 2026-09-02 16:06 | `captures/anantti-20260902-160653/report.md` | 로그인 → 예약 → 빌라쥬 선택 → 날짜 → 1박/2박 객실·요금 |
| 2026-09-02 16:20 | `captures/anantti-20260902-162031/report.md` | 자동 로그인 → 숙소 5곳(코드·코브·강남·남해·제주) 전환 |

## 0. 결론 요약

**소노와 마찬가지로 JSON API 구조다. DOM 파싱은 필요 없다.**

- 본 사이트: `https://ananti.kr`
- 로그인 사이트: `https://me.ananti.kr` (별도 도메인, SSO)
- 응답 껍데기: `{ code: 200, message: null, data: [...] }`

**소노와 다른 점 (중요)**

| | 소노 | 아난티 |
|---|---|---|
| 상태 단계 | 4단계 (원활/임박/대기/마감) | **2단계** (`rsvnYn` Y/N, 날짜는 `rrYn` Y/N) |
| 잔여 객실수 | `rsvnRmCnt` 로 제공 | **없음** |
| 대기 신청 | 있음 (`waitSeq`) | 확인 안 됨 |
| 날짜별 금액 | `daysAmtInfoList` 로 제공 | **없음 — 기간 합계(`rate`)만** |
| 계층 | 지역 → 숙소 → 동 → 객실 | 사업장 → 객실 (2단으로 보임) |

## 1. 로그인

| 항목 | 값 |
|---|---|
| 로그인 페이지 | `https://me.ananti.kr/user/signin?loginRtnUrl=<돌아갈주소>` |
| 아이디 | `#id` |
| 비밀번호 | `#pwd` |
| 로그인 버튼 | `#loginBtn` |
| 캡차·보안키패드 | **없음** |

로그인 후 `ananti.kr` 로 돌아온다.
**로그인 상태 판별**: `GET /ko/my/index` 를 리다이렉트 없이 요청해 `200` 이면 로그인, `302` 면 아니다.

## 1-1. ⚠ 예약 API 는 CSRF 토큰을 요구한다 (2026-09-02 확인)

`x-csrf-token` 헤더가 없으면 예약 API 가 **403** 을 돌려준다. 쿠키만으로는 안 된다.

| 어디서 | 값 |
|---|---|
| 헤더 이름 | 페이지의 `<meta name="_csrf_header">` (= `X-CSRF-TOKEN`) |
| 토큰 값 | 페이지의 `<meta name="_csrf">` (36자 UUID) |

즉 **API 를 부르기 전에 페이지를 한 번 열어야 한다.** 회원번호·고객번호도 같은 페이지에서 얻으므로
`resolveIds()` 가 한 번에 셋 다 가져온다.

화면이 실제로 보내는 헤더(재현에 성공한 조합):

```
accept: application/json, text/javascript, */*; q=0.01
content-type: application/json
x-requested-with: XMLHttpRequest
x-csrf-token: <36자>
referer: https://ananti.kr/ko/reservation/<숙소>/room-search
```

`x-requested-with` 와 `referer` 만으로는 여전히 403 이었다. **셋 다 필요하다.**

## 2. 조회에 필요한 식별자

모든 예약 API 요청에 함께 나가는 값:

| 이름 | 예 | 뜻 |
|---|---|---|
| `memNo` | `<memNo>` (10자리) | 회원번호 |
| `guestNo` | `<guestNo>` (7자리) | 고객번호 |
| `bsns` | `40` | **사업장 코드** — 빌라쥬 드 아난티로 확인됨. 다른 사업장 코드는 미확인 |
| `golfId` | `G1` | 골프장 식별자로 보임. 객실 조회에도 그대로 실린다 |
| `type` / `rsvnType` | `RR` | 객실(Room Reservation) |

`memNo` · `guestNo` 를 어디서 얻는지는 아직 확인 안 됨 (예약 페이지에 박혀 있는 것으로 보인다).

## 2-1. 숙소 목록 (2026-09-02 확인)

요청 경로와 `bsns` 가 같은 요청 안에 함께 있어 짝이 확실하다.

| 숙소 | 경로 | `bsns` | 객실 조회 API | 응답 형식 |
|---|---|---|---|---|
| 아난티 남해 | `/reservation/namhae/` | `12` | `search-only-room` | 소문자 |
| 아난티코드 (가평) | `/reservation/chord/` | `24` | `search-only-room` | 소문자 |
| 아난티코브 (부산) | `/reservation/cove/` | `25` | **`search-room`** | 소문자 |
| 아난티 앳 강남 | `/reservation/ganm/` | `36` | `search-only-room` | **대문자** |
| 아난티 (제주) | `/reservation/jeju/` | `38` | `search-only-room` | 소문자 |
| 빌라쥬 드 아난티 | `/reservation/village/` | `40` | `search-only-room` | 소문자 |

⚠ **숙소마다 API 가 조금씩 다르다. 하나로 뭉뚱그리면 안 된다.**

- **코브**는 엔드포인트 이름이 `search-room` 이다 (다른 곳은 `search-only-room`).
- **강남**은 응답 필드가 전부 대문자다:
  `RTYPE_NAME`(객실명) · `RESERVE_YN`(가능여부) · `RESERVE_PRICE`(요금) · `RESERVE_PCNT`(정원) ·
  `RM_TOT`(**잔여 객실수 — 다른 숙소엔 없다**) · `VIEWTYPE`(전망)
  달력도 `RESERVE_DATE` · `RESERVE_YN` 으로 온다.
- 나머지 4곳은 소문자 형식(§4)으로 같다.

## 3. 달력

`POST /reservation/village/ajax/init-calendar`

```json
{ "bsns":"40", "golfId":"G1", "date":"20260902",
  "memNo":"<memNo>", "guestNo":"<guestNo>", "rate":"", "type":"RR", "rsvnType":"RR" }
```

응답 `data[]` — 확인 사례는 **153일치(20260901 ~ 20270131)** 가 한 번에 왔다.

| 필드 | 뜻 |
|---|---|
| `cdDt` | 날짜 (yyyyMMdd) |
| `rrYn` | **예약가능 여부 `Y`/`N`** |
| `cdSeasonCd` | `주중` / `주말` |
| `checkDt` | 가능한 날은 `nomal`, 아니면 null |

### ⚠ `rrYn` 은 "객실이 남았다" 가 아니다 (2026-09-02 확인)

숙소 5곳의 응답을 비교하니 가능(`Y`)한 날이 **오늘부터 연속 61일**로 전부 같았다.
제주만 **89일**이었다. 요일·숙소·객실과 아무 상관이 없다.

| 숙소 | 가능 일수 | 범위 |
|---|---|---|
| 코드 · 코브 · 남해 · 빌라쥬 | 61일 | 오늘 ~ 약 2개월 |
| 제주 | 89일 | 오늘 ~ 약 3개월 |

→ **`rrYn` 은 "예약이 오픈된 기간인가" 를 뜻한다.** 잔여 객실과는 무관하다.
   (아난티는 숙소별로 오픈 기간이 다르다: 대부분 2개월 전, 제주는 3개월 전)

**실제 예약 가능 여부는 `search-only-room` 의 `rsvnYn` 으로만 알 수 있고, 날짜를 지정해야 나온다.**
사이트 자체도 달력에서는 가능 여부를 보여주지 않고, 날짜를 고른 뒤 객실 목록에서 보여준다.

→ 화면 설계에 영향이 있다. §6 참고.

`POST /reservation/village/ajax/enable-date` 는 특정 날짜에서 이어서 묵을 수 있는 날들을 준다(체크아웃 후보).

## 4. 객실 · 요금

`POST /reservation/village/ajax/search-only-room`

```json
{ "bsns":"40", "memNo":"<memNo>", "guestNo":"<guestNo>",
  "frDate":"20260917", "toDate":"20260919", "nig":"2", "rsvnType":"RR", "type":"RR" }
```

**객실 목록과 요금이 한 번에 온다.** (소노는 객실 목록과 요금이 따로였다 — 아난티가 더 간단하다)

확인 사례: 객실 **15종**.

| 필드 | 예 | 뜻 |
|---|---|---|
| `rmType` | `5010010112` | 객실 코드 |
| `rmDesc` / `rmKorDesc` | `클리퍼 듀플렉스 하우스` | 객실 이름 |
| `bedType` | `(킹2 / 복층)` | 침대 구성 |
| `gst` | `4` | **정원** |
| `rsvnYn` | `Y` / `N` | 예약 가능 여부 |
| `rsvnReason` | | 불가 사유 |
| `rate` | `820000` | **기간 전체 합계** (2박이면 2박 합계) |
| `minPrice` | `390000` | 1박 최저가 |
| `originRate` | | 할인 전 금액으로 보임 |
| `rateDesc` | `펜트하우스 준회원 요금` | 적용된 요금제 이름 |
| `roomImg` | (확인 사례는 null) | 객실 사진 |

**요금 확인**: 같은 객실이 1박 `390,000` → 2박 `820,000` 이었다(주중+주말).
`rate` 는 기간 합계이고, **날짜별 내역은 주지 않는다.**
→ 날짜별로 보여주려면 하루씩 나눠 조회해야 한다(박수만큼 호출). 화면에서 어떻게 할지 정해야 한다.

## 4-1. 강남(ganm) 응답 형식

```json
{ "RTYPE_NAME": "Cabin S", "RESERVE_RTYPE": "5010010041", "RESERVE_YN": "Y",
  "RESERVE_PRICE": 730000, "RESERVE_PRICE_MIN": 730000, "RESERVE_PCNT": 4,
  "RM_TOT": 38, "VIEWTYPE": "씨티뷰A", "RMDESC": "표준요금" }
```

| 대문자 필드 | 소문자 형식의 대응 |
|---|---|
| `RTYPE_NAME` | `rmKorDesc` |
| `RESERVE_RTYPE` | `rmType` |
| `RESERVE_YN` | `rsvnYn` |
| `RESERVE_PRICE` | `rate` |
| `RESERVE_PRICE_MIN` | `minPrice` |
| `RESERVE_PCNT` | `gst` |
| `RM_TOT` | (대응 없음 — 잔여 객실수) |
| `VIEWTYPE` | (대응 없음 — 전망) |

## 6. 화면 설계에 미치는 영향 (결정 필요)

아난티 달력은 **날짜별 예약가능 여부를 주지 않는다**(§3). 선택지는 둘이다.

| 방식 | 내용 | 문제 |
|---|---|---|
| (가) 사이트와 같게 | 달력에는 "예약 오픈된 날" 만 표시. 날짜를 눌러야 실제 가능 여부·요금이 나온다 | 소노와 화면이 달라 보인다 |
| (나) 날짜별로 미리 조회 | 한 달치 날짜마다 `search-only-room` 을 불러 달력을 채운다 | 한 번 조회에 요청 30번. 사람 속도(CLAUDE.md §7.4)에 어긋나고 10초를 넘긴다 |

→ **(가) 를 권한다.** 사이트가 주지 않는 정보를 30번 두드려 만들어내는 것은 §7.4 에 어긋난다.

## 7. 검증 결과 (2026-09-02)

빌라쥬 드 아난티 기준, 저장된 세션으로 재실행:

| 단계 | 시간 |
|---|---|
| 세션 확보 (복원) | 0.6초 |
| 달력 1개월 | 2.3초 |
| 상세 2박 (객실 15종) | **0.2초** |
| **전체** | **4.0초** |

상세가 0.2초인 이유는 **객실 목록과 요금이 한 번의 호출로 다 오기 때문**이다
(소노는 객실타입마다 요금을 따로 물어 3.6초가 걸린다).

## 5. 남은 확인 사항

- [x] ~~**사업장 목록과 `bsns` 코드**~~ → 6곳 확인 (§2-1)
- [x] ~~**사업장마다 URL 경로가 다른가**~~ → 다르다. API 이름과 응답 형식까지 다르다 (§2-1)
- [ ] 회사 회원권으로 **실제로 쓸 수 있는 숙소가 이 6곳 전부인지** (담당자 확인 필요)
- [ ] `memNo` · `guestNo` 를 어떤 API 로 얻는가 (지금은 페이지에서 온다)
- [x] ~~로그인 상태 판별~~ → `/ko/my/index` 의 302 여부 (§1)
- [ ] 날짜별 금액을 주는 API 가 따로 있는가
- [ ] 객실 사진(`roomImg`) 이 채워지는 경우가 있는가
- [ ] `search-workplace-all` 의 플래그 의미:
      `nhYn`(남해) · `vlYn`(빌라쥬) · `jjYn`(제주) · `csYn` · `psYn` · `phYn` · `jaYn` — 나머지는 추정
