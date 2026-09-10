# ANC 리조트 예약현황 조회 — 프로젝트 스펙

> 이 파일은 Claude Code 세션의 지속 컨텍스트다. 작업 전 반드시 전체를 읽고, 여기 적힌 결정을 임의로 바꾸지 않는다. 바꿔야 하면 사용자에게 먼저 묻는다.

## 1. 배경과 목적

- 에이스나노켐(ANC, 직원 약 85명)은 법인 리조트 회원권 3종(소노, 아난티, 한화)을 보유.
- 회원 ID/비밀번호는 관리팀 담당자 1인이 단독 관리. 과거 ID 공유로 오예약·실수 취소 사고가 있었기 때문.
- 현재는 직원이 담당자에게 "○월○일 ○○리조트 가능해요?"라고 묻고, 담당자가 로그인해서 확인 후 알려주는 수작업 반복.
- 목표: **직원이 사내 게시판의 게시글을 열면 회원가 기준 예약가능현황·금액을 직접 볼 수 있게 한다.** 예약 자체는 여전히 담당자가 수행한다.
- 리조트 3사 모두 임직원 조회용 계정을 제공하지 않음(확인 완료). 따라서 담당자 계정으로 로그인하는 브라우저 자동화 봇이 유일한 수단이다.

## 2. 확정된 요구사항

### 해야 하는 것
- 직원이 리조트 → 지역 → 숙소 → 동(건물) → 박수 를 고르고 **[조회]** 를 누르면, 그 시점에 봇이 실제 사이트에서 읽어온 현황을 보여준다.
- 조회 결과는 **한 달 달력** (날짜별 예약가능 / 마감임박 / 예약대기 / 마감). 전월·다음월 이동 가능.
- 달력의 날짜를 누르면 그 날짜를 **체크인**으로 하여 선택한 박수만큼의 **연박 기준** 상세를 보여준다:
  - 해당 동의 **객실 형태별** 예약가능 여부 (연박 불가 시 "○일만 가능" 표시)
  - 객실 형태별 **회원가 합계** 와 날짜별 내역 (스마트요금 등 할인이 있으면 원가·할인 표시)
  - 정원(기준/최대), 객실 사진
  - (조건부) 같은 숙소 안 **동별 잔여 객실수** 한 줄 — §12 참고
- 게시글을 열거나 숙소 선택을 바꾼 직후에는 달력을 표시하지 않는다. 사용자가 숙소를 선택하고 **조회하기**를 눌러야 해당 조건의 달력 결과를 표시한다.
- 조회 버튼은 횟수 제한 없이 누를 수 있어야 한다. 응답 목표 10초 이내.
- 객실 목록의 계층(객실종류 → 전망 → 침대/취사 옵션 등)은 리조트·숙소마다 다르다. **화면은 계층 깊이와 명칭을 하드코딩하지 않고 봇이 읽어온 구조를 그대로 렌더링한다.**
- 사내 게시판 게시글에 `<iframe>` 으로 삽입해 사용.
- 객실 결과는 객실 종류별로 묶고 낮은 등급부터 표시한다. `가능 객실만 보기`는 `available`과 `closing`만 남긴다.
- 대한민국 공휴일·명절 연휴·대체공휴일을 달력에 이름과 함께 표시한다.
- 별도 관리자 페이지 없이 좌측 하단 이미지를 더블클릭해 관리자 로그인하며, 공지사항과 FAQ를 관리한다.

### 하지 않는 것
- 예약, 취소, 대기 신청 등 **사이트 상태를 바꾸는 어떤 동작도 하지 않는다.** 읽기 전용.
- 정기(스케줄) 크롤링 없음. 사용자가 조회를 눌렀을 때만 사이트에 접근.
- 직원 개인 로그인 없음 (게시판 접근 자체가 사내 인증).
- 카카오 챗봇 연동 없음. 관심 등록·알림 기능 없음 (추후 검토 가능).

## 3. 아키텍처

```
사내 게시판 게시글
  └─ <iframe src="https://<hosting>/?t=<token>">
        └─ web/  (정적 HTML + JS, Firebase Hosting)
              ├─ Firestore 읽기: 기본정보, 명시적으로 조회한 조건의 저장 결과
              └─ HTTPS 호출 → bot/ (Cloud Run 서비스)
                                  ├─ Playwright 브라우저 상시 유지 (min instance 1)
                                  ├─ 로그인 세션 쿠키 보관·재사용
                                  ├─ 리조트별 어댑터로 페이지 읽기
                                  └─ 결과 반환 + Firestore에 마지막 결과 저장
```

- **bot/** : Node.js + Playwright, Docker, Cloud Run **서비스**(Job 아님).
  `--min-instances=0` 으로 시작한다 (2026-09-02 결정). 세션을 Firestore 에 저장해 두므로
  인스턴스가 꺼졌다 켜져도 다시 로그인하지 않는다. 콜드 스타트 시 첫 조회 15~25초, 이후 6초대.
  느리다고 판단되면 `--min-instances=1` 로 올린다(월 2~3만원).
- **web/** : 프레임워크 없는 HTML/CSS/JS 한 장 + Firebase JS SDK (Firestore 읽기). Flutter Web 사용 금지 — iframe 안에서 가볍게 떠야 함.
- **Firestore** : 기본정보(숙소·객실·사진) 와 마지막 조회 결과 캐시.
- **Firebase Storage** : 객실 사진 사본.
- **Secret Manager** : 리조트 3사 ID/비밀번호. 코드·환경파일·Firestore 어디에도 평문 저장 금지.

## 4. 기술 스택

| 영역 | 선택 | 비고 |
|---|---|---|
| 봇 런타임 | Node.js 20, TypeScript, Playwright (chromium) | `mcr.microsoft.com/playwright` 베이스 이미지 |
| 봇 호스팅 | Cloud Run 서비스, asia-northeast3 | min 0 / max 2 인스턴스, 메모리 2GB, 동시성 1~4 |
| DB | Firestore | 기존 ANC Firebase 프로젝트 또는 신규 프로젝트 — 사용자에게 확인 |
| 프론트 | Vanilla HTML/JS, Firebase Hosting | 빌드 도구 없이 시작, 필요 시 Vite |
| 비밀 | Google Secret Manager | 봇 서비스 계정에만 접근 권한 |
| 알림 | 이메일(Cloud Functions + Nodemailer 또는 SendGrid) | 봇 실패·차단 감지 시 담당자에게 |

## 5. 저장소 구조

```
anc-resort/
├── CLAUDE.md
├── bot/
│   ├── src/
│   │   ├── server.ts           # HTTP 엔드포인트
│   │   ├── browser.ts          # Playwright 인스턴스·세션 관리
│   │   ├── adapters/
│   │   │   ├── types.ts        # 공통 인터페이스
│   │   │   ├── sono.ts
│   │   │   ├── anantti.ts      # Phase 6
│   │   │   └── hanwha.ts       # Phase 6
│   │   ├── store.ts            # Firestore 읽기/쓰기
│   │   ├── secrets.ts
│   │   └── notify.ts
│   ├── scripts/
│   │   └── seed-master.ts      # 기본정보(숙소·객실·사진) 1회 수집
│   ├── Dockerfile
│   └── package.json
├── web/
│   ├── public/
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   └── firebase.json
└── firestore.rules
```

## 6. Firestore 스키마

기본 원칙: **계층은 데이터가 정한다.** 리조트마다 "지역 → 숙소 → 동" 이 3단일 수도, 2단일 수도 있다. 드롭다운은 `nodes` 트리를 따라 자동 생성한다.

```
resorts/{resortId}                      # sono | anantti | hanwha
  name: "소노"
  active: true

nodes/{nodeId}                          # 선택 트리 (지역/숙소/동)
  resortId
  parentId: null | nodeId
  level: "region" | "property" | "building"   # 리조트마다 level 종류·깊이 상이
  name: "델피노"
  order: 1
  bookable: false                        # true면 이 노드에서 조회 가능 (보통 building)
  siteRef: { ... }                       # 어댑터가 사이트 조회에 쓰는 식별자 (코드, URL 파라미터 등)
  active: true

rooms/{roomId}                          # 기본정보 (seed-master가 채움)
  nodeId                                 # bookable 노드
  path: ["패밀리", "스탠다드", "침대·취사"]   # 가변 계층. 화면은 path[0..n-2]로 그룹핑, 마지막을 항목명으로
  capacityStd: 2
  capacityMax: 4
  images: ["gs://.../rooms/xxx.jpg"]
  siteRef: { ... }

snapshots/{nodeId}_{yyyyMM}            # 달력 마지막 조회 결과
  fetchedAt
  nights: 1                              # 달력은 항상 1박 기준
  days: { "2026-09-24": "waitlist", ... }  # available | closing | waitlist | full | unknown

details/{nodeId}_{checkin}_{nights}    # 날짜 상세 마지막 조회 결과
  fetchedAt
  checkin: "2026-09-24"
  nights: 2
  buildings: [ { nodeId, name, remaining: 5 } ]        # 조건부(§12), 없으면 빈 배열
  rooms: [
    {
      roomId, path,
      status: "available" | "closing" | "waitlist" | "full" | "partial",
      waitCount: 1,                       # 대기 인원 (있을 때)
      availableNights: ["2026-09-24"],    # partial 일 때만
      total: 282000,
      perNight: [ { date, base: 151000, discount: 20000, final: 131000 } ]
    }
  ]

portalContent/{contentId}              # 관리자 변경 공지·FAQ와 기본 FAQ 삭제 표시
  kind: "notice" | "faq"
  category, title, body
  date                                  # notice만 yyyy-mm-dd
  inlineImages: [ { url, path, name } ] # 내용에 붙여넣은 이미지, 개수 제한 없음
  attachments: [                        # 일반 첨부파일
    { url, path, name, contentType, size }
  ]
  deleted: false | true                 # 기본 FAQ 삭제는 tombstone으로 보존
  updatedAt

meta/config
  boardToken: "..."                      # iframe URL 토큰 (해시 저장)
```

## 7. 봇 설계

### 7.1 어댑터 인터페이스

```ts
interface ResortAdapter {
  id: "sono" | "anantti" | "hanwha";
  ensureSession(page: Page): Promise<void>;          // 쿠키 복원 → 로그인 여부 확인 → 필요 시 로그인
  getCalendar(page, node: Node, yyyyMM): Promise<Record<string, DayStatus>>;
  getDetail(page, node: Node, checkin, nights): Promise<DetailResult>;
  getBuildingSummary?(page, propertyNode: Node, checkin, nights): Promise<BuildingRemaining[]>;  // 선택 구현
  seedMaster(page): Promise<{ nodes: Node[]; rooms: Room[] }>;
}
```

### 7.2 세션 관리 (browser.ts)
- 프로세스 시작 시 chromium 1개를 띄우고, 리조트별 `BrowserContext` 1개씩 유지.
- 쿠키는 Firestore `sessions/{resortId}` 에 **암호화(KMS 또는 AES, 키는 Secret Manager)** 하여 저장. 재시작 시 복원.
- 요청마다 로그인하지 않는다. `ensureSession` 은 "로그인 상태를 나타내는 요소가 있는가"로 판단하고, 없을 때만 로그인.
- 로그인은 리조트당 **하루 최대 20회** 로 상한. 초과하면 조회 실패로 응답하고 담당자에게 알림 (계정 이상 신호).
- 같은 노드에 대한 동시 요청은 하나로 합친다(in-flight dedup). 같은 노드 2초 내 재요청은 직전 결과 반환.

### 7.3 소노 어댑터 (sono.ts) — 확인된 화면 흐름
스크린샷 기준(2026-09):
1. 로그인 후 메인 하단에 검색바: `지역 또는 숙소` / 날짜 / 객실·인원 / [검색].
2. 숙소 선택 팝업은 `소노펫 비발디파크`, `비발디파크 > 소노벨 A·B·C·소노캄·소노벨 D`, `델피노 > 소노벨 EAST·WEST …` 처럼 **숙소 > 동** 2단 목록.
3. 검색 후 `객실 예약` 페이지: 상단에 `통합예약 홈`, `잔여 객실 보기` 메뉴. 본문에 월 달력, 좌측에 `숙소유형`, `객실종류` 체크박스(패밀리·패밀리 테라스·스위트·스위트 테라스·스위트 Pet Friendly·골드 테라스·골드). 달력 각 날짜 아래 동 이름 행에 상태 텍스트: `마감임박`, `예약대기` 등. (`예약가능`, `마감` 표기는 실물에서 확인 필요)
4. 날짜 클릭 → `Reservation` 모달: 상단 날짜/박수, 필터 버튼(초기화·숙소유형·객실층류·전망·객실내부). 본문은 `리조트 / 패밀리` 같은 그룹 헤더 아래 `스탠다드`, `파노라마`, `설악마운틴`(전망) 행, 각 행에 `침대 취사` / `침대 클린` 옵션 행과 상태(`마감임박`, `대기 1`). 각 옵션에 `객실보기`, `쿠폰할인가 보기` 링크.
5. 옵션 하나를 선택하면 하단 `예상결제금액`: `객실요금 ₩141,000`, `스마트요금할인 -₩20,000`.

구현 지침:
- **먼저 네트워크 응답(XHR/fetch JSON)을 찾아라.** 달력과 모달이 JSON API로 데이터를 받는다면 DOM 클릭 없이 `page.waitForResponse` 로 가로채는 것이 훨씬 빠르고 견고하다. 첫 작업은 `headless: false` 로 띄워 DevTools Network를 관찰하는 탐색 스크립트다.
- JSON을 못 쓰면 DOM 파싱: 모달에서 옵션을 순서대로 클릭하며 `예상결제금액` 을 읽는다. 클릭 사이 300~800ms 랜덤 대기.
- 상태 텍스트 → 코드 매핑은 `sono.ts` 상단 상수 테이블에 두고, 알 수 없는 텍스트는 `unknown` 으로 저장하고 로그에 남긴다. 절대 추측해서 `available` 로 바꾸지 않는다.
- 9/9 00:00~05:00 같은 점검 안내 팝업이 뜰 수 있다. 팝업·레이어는 `ensureSession` 에서 닫고, 점검 페이지면 `maintenance` 에러로 응답.

### 7.4 사이트 접근 규칙 (모든 어댑터 공통)
- 읽기 전용. `예약하기`, `대기신청`, `취소` 류 버튼 선택자는 코드에 등장조차 시키지 않는다.
- 페이지 전환 사이 1~3초 랜덤 대기. 사람 속도.
- 캡차, 차단 페이지, 비정상 리다이렉트 감지 시 즉시 중단 → `blocked` 에러 응답 + 담당자 알림 + 해당 리조트 30분 조회 정지.
- User-Agent는 실제 데스크톱 크롬 값으로 고정. headless 탐지 회피 트릭(스텔스 플러그인 등)은 쓰지 않는다 — 차단되면 차단된 대로 알리는 것이 맞다.

### 7.5 오류 처리
| 상황 | 응답 코드 | 화면 문구 |
|---|---|---|
| 세션 복구·로그인 실패 | `auth_failed` | 지금은 확인이 안 됩니다. 담당자에게 문의하세요 |
| 파싱 실패(구조 변경 의심) | `parse_failed` | 위와 동일 + 담당자 알림 |
| 사이트 점검 | `maintenance` | 리조트 사이트 점검 중입니다 |
| 차단 감지 | `blocked` | 위와 동일 + 담당자 알림 |
| 타임아웃(30초) | `timeout` | 응답이 늦어요. 잠시 후 다시 눌러주세요 |

실패 시에도 Firestore의 마지막 성공 결과는 지우지 않는다. 화면은 마지막 결과를 유지하고 오류 문구만 덧붙인다.

## 8. HTTP API (bot/ 서비스)

모든 요청은 `Authorization: Bearer <boardToken>` 필요. 응답은 JSON.

```
POST /calendar   { resortId, nodeId, yyyyMM }
  → { days: {...}, fetchedAt }

POST /detail     { resortId, nodeId, checkin, nights }
  → { buildings: [...], rooms: [...], fetchedAt }

GET  /content
  → { items: [...] }

GET  /holidays?year=2026
  → { year, days: { "2026-09-24": "추석", ... } }

POST /admin/login    { password } → { session, expiresIn }
POST /admin/content  { action, kind, id, ... } → { ok }
POST /admin/upload   { id, usage, name, contentType, data } → { url, path, name, contentType, size }

GET  /health     → { ok, sessions: { sono: "alive" | "expired" } }
```

- `/calendar` 성공 시 `snapshots/` 갱신, `/detail` 성공 시 `details/` 갱신.
- `/content`는 정적 기본 FAQ에 합칠 관리자 변경분을 반환한다. `/admin/content`만 `portalContent/`를 쓴다.
- `/admin/upload`는 관리자 세션을 확인한 뒤 파일 한 개를 Storage `portal/notices/`에 저장한다. 내용 이미지는 PNG/JPG/WebP 각 4MB 이하, 첨부파일은 모든 형식 각 10MB 이하이다.
- 관리자 로그인은 8시간 서명 세션을 발급하며 동일 접속자의 실패는 15분 동안 5회로 제한한다.
- 달력은 항상 1박 기준으로 조회한다(박수와 무관). 상세만 박수를 반영.

## 9. 화면 스펙 (web/)

확정된 레이아웃 (위에서 아래로):

1. **조회 조건 줄** — `[리조트] [지역] [숙소] [동] [박수 1~3, 기본 1박] [조회]`. 드롭다운은 `nodes` 트리에서 생성. 리조트에 따라 단계 수가 달라도 됨(없는 단계는 렌더링하지 않음). 날짜 선택 없음.
2. **상태 줄** — "마지막 조회 9/2 14:32 · 회원가 기준 · 예약은 관리팀 ○○○에게 요청". 조회 중에는 "조회 중…" 표시, 버튼은 비활성화하지 않음(중복은 서버가 합침).
3. **월 이동** — `[< 8월] 2026년 9월 [10월 >]`. 월을 넘기면 그 달의 `snapshots` 가 있으면 즉시 표시하고, 없으면 리조트 사이트의 해당 월을 `/calendar`로 자동 조회한다. 리조트별 오픈 기간이 다르므로 화면에 공통 미래 월 상한을 두지 않는다.
4. **달력** — 숙소를 선택하고 조회하기를 누른 뒤 표시한다. 7열이며 각 칸에 날짜와 상태 뱃지 (가능=초록, 잔여객실 적음=주황, 대기=파랑, 마감=회색, unknown=점선)를 둔다. 일요일·대한민국 공휴일은 빨강, 토요일은 파랑. 설날·추석 연휴와 대체공휴일은 휴일명도 표시한다. 날짜 클릭 = 체크인 선택. 박수가 2 이상이면 체크인부터 박수만큼 칸을 연하게 함께 강조.
5. **상세 헤더** — "9/24(목) → 9/26(토) · 2박", 상세조회 시각, `[지금 다시 확인]` 버튼.
6. **동별 잔여 줄(조건부)** — "델피노 동별 잔여 객실 · 2박 연박 기준", 동 이름과 실수를 칩으로. 선택된 동은 강조. 칩 클릭 시 그 동으로 전환 후 재조회. `buildings` 가 비어 있으면 이 영역 자체를 그리지 않는다.
7. **객실 목록** — `rooms[].path` 로 그룹핑하고 스탠다드·패밀리 → 디럭스·캐빈 → 프리미어 → 스위트 → 로얄·플래티넘 순으로 정렬한다. 같은 등급은 객실명순이다. 행: 썸네일(없으면 `사진 없음`) · 항목명 · 기준/최대 인원 · 상태 · 회원가 합계 · 사진 버튼. `가능 객실만 보기`는 예약가능과 잔여객실 적음만 표시하고 결과 수를 `2/4개`처럼 보여준다.
8. **공지사항·FAQ 관리** — 좌측 하단 이미지를 더블클릭해 관리자 비밀번호를 입력한다. 인증되면 공지 등록·수정·삭제와 FAQ 추가·수정·삭제 버튼이 표시된다. 공지 내용 칸에는 `Ctrl+V`/`⌘V`로 이미지를 개수 제한 없이 붙여넣고, 모든 형식의 첨부파일을 여러 개 추가할 수 있다. 다시 더블클릭하면 로그아웃한다.

스타일: ACE Blue 중심의 Clean Corporate + Modern Resort Illustration. 최종 제공된 밝은 Sky/Aqua/Green 일러스트를 Hero와 Sidebar에 전체 표시하고, 흰 카드·얇은 테두리·절제된 그림자를 사용한다. 폭은 100%, 높이는 내용에 맞춰 늘어난다.

썸네일 클릭 시 사진 확대 모달(같은 페이지 내 오버레이). 사진이 여러 장이면 좌우 넘김.

## 10. 보안

- `firestore.rules`: 모든 컬렉션 **읽기만 허용**, 쓰기는 서비스 계정(Admin SDK)만. `sessions/`, `meta/` 는 클라이언트 읽기도 금지.
- 봇 API는 `boardToken` 없이는 401. 토큰은 게시글 iframe URL 에만 존재. 유출 의심 시 `meta/config` 에서 교체.
- 관리자 비밀번호는 `admin-password` Secret Manager에만 두며 브라우저 코드와 Firestore에는 저장하지 않는다. 브라우저에는 8시간 서명 세션만 `sessionStorage`로 보관한다.
- Firestore의 `portalContent/`도 클라이언트 직접 쓰기를 금지하고, 관리자 세션을 검증한 Cloud Run Admin SDK만 쓴다.
- 공지 파일은 `gs://anc-resort-rooms/portal/notices/`에 저장하며 Cloud Run 서비스 계정에 버킷 범위 `roles/storage.objectAdmin`만 부여한다.
- 봇 Cloud Run 은 인증 없는 호출 허용하되(게시판 iframe 에서 직접 호출) CORS 를 Hosting 도메인으로 제한.
- 리조트 계정 정보는 Secret Manager 에서만 읽는다. 로그에 URL·쿠키·계정 정보를 남기지 않는다.
- 객실 사진은 사내 열람용으로만 Storage 에 보관. 외부 공개 금지(Storage 규칙으로 Hosting 도메인 제한 또는 서명 URL).

## 11. 배포

### 배포 완료 (2026-09-02)

| 항목 | 값 |
|---|---|
| GCP/Firebase 프로젝트 | `anc-resort` (프로젝트 번호 551643700321) |
| 봇 서비스 URL | `https://anc-resort-bot-551643700321.asia-northeast3.run.app` |
| 화면 URL | `https://anc-resort.web.app` (게시글 삽입 코드는 `web/게시판-삽입-코드.txt`) |
| 사진 저장소 | `gs://anc-resort-rooms` — 다운로드 토큰이 든 주소로만 열람 가능 |
| 서비스 계정 | `anc-resort-bot@anc-resort.iam.gserviceaccount.com` |
| 비밀 | `sono-id` · `sono-pw` · `anantti-id` · `anantti-pw` · `session-key` · `board-token` · `admin-password` |
| 지원 리조트 | **소노**(동 35 · 객실 386) · **아난티**(숙소 6) · **한화**(숙소 13 / 위치 16) |
| 배포 명령 | `bash 배포.sh` (봇+화면) · `bash 배포.sh bot` · `bash 배포.sh web`; 봇 배포는 `admin-password`를 포함한 모든 Secret을 재연결 |
| 담당자용 문서 | `bot/docs/운영-안내.md` |
| 결제 계정 | `ace-resort` (0148DB-6E07EC-8AAF66) · 예산 알림 월 5만원 |

측정된 응답 시간 (소노벨 EAST 기준, 객실 21종 = 전체 동 중 최대):

| 요청 | 콜드 | 따뜻할 때 |
|---|---|---|
| `/health` | 3.0초 | 0.2초 |
| `/calendar` | 5.3초 | 0.7~1.0초 |
| `/detail` (2박) | — | 4.6~4.8초 |
| 2초 내 같은 요청 | — | 0.08초 (합쳐짐) |

`/health` 는 토큰 없이 열려 있으므로 **로그인을 유발하지 않는다**(`sessionAlive` 만 호출).
세션이 만료됐으면 `expired` 로 보고만 하고, 되살리는 일은 토큰이 있는 실제 조회가 할 때 한다.

### 화면에서 지켜야 할 것 (Phase 4 에서 확정)

- **게시글을 여는 것만으로 리조트 사이트에 접근하지 않는다.** 화면을 열 때는 Firestore 의 마지막 결과만
  보여주고, 사이트 조회는 [조회] 를 눌렀을 때와 날짜를 눌렀을 때(저장된 결과가 없을 때)만 한다. (§2)
- 지난 달로는 이동할 수 없다. 사이트가 지난 날짜를 주지 않는다.
- 정원이 조건부인 객실(펫 객실 등)은 숫자로 줄이지 않고 원문 문장을 그대로 보여준다.
- `partial`(연박 불가) 객실은 **실제 예약 가능한 박수의 금액**을 보여준다. 요청한 박수의 금액이 아니다.

### 배포 명령

```
# bot
gcloud run deploy anc-resort-bot --source bot/ --region asia-northeast3 \
  --min-instances 0 --max-instances 2 --memory 2Gi --concurrency 4 --timeout 60 \
  --set-secrets SONO_ID=sono-id:latest,SONO_PW=sono-pw:latest,ANANTTI_ID=anantti-id:latest,ANANTTI_PW=anantti-pw:latest,HANWHA_ID=hanwha-id:latest,HANWHA_PW=hanwha-pw:latest,HANWHA_MEMBER_PW=hanwha-member-pw:latest,SESSION_KEY=session-key:latest,BOARD_TOKEN=board-token:latest,ADMIN_PASSWORD=admin-password:latest

# web
firebase deploy --only hosting,firestore:rules
```

게시글 삽입 예시:
```html
<iframe src="https://anc-resort.web.app/?t=TOKEN" width="100%" height="1400" style="border:0"></iframe>
```

## 12. 남은 확인 사항

**소노**
- 위탁운영 객실의 `outsTotAmt` 가 1박 금액인지 기간 합계인지 (1박으로만 확인함)
- `rsvBlckCd:"000"` · `userIndCd:"Y"` · `availableRsvDate` 의 의미

**아난티**
- 회사 회원권으로 실제 쓸 수 있는 숙소가 6곳 전부인지
- 날짜별 금액을 주는 API 가 따로 있는지 (지금은 기간 합계만)

**한화**
- `REMPRR0113` 의 조회 기간을 한 번에 얼마나 넓힐 수 있는지
- `CLOSING_THRESHOLD`(잔여 3실 이하 = 마감임박) 기준이 적절한지 — 써 보고 조정
- 회사 회원권으로 실제 쓸 수 있는 숙소가 16곳 전부인지

**공통**
- 객실 사진: 소노·아난티 지원. 아난티는 2026-09-10 공식 예약 페이지의 rmCode/RESERVE_RTYPE 분기에서 39개 대표 사진 그룹을 확인하고 고유 객실 ID 67개에 연결·배포했다. 비활성 갤러리에는 다른 숙소 사진이 섞여 있어 사용하지 않는다. `bot/docs/anantti-images/README.md` 참고. 한화도 2026-09-10 공개 안내의 LOC_CD/ROOM_TYPE_CD로 139객실, 별도 플라자 매핑으로 5객실 사진을 연결·배포했다. `bot/docs/hanwha-images/README.md` 참고.

## 12-1. 원래 스펙의 미확정 사항 (해소 완료)

- **`잔여 객실 보기` 페이지의 실체.** 한 숙소의 여러 동 잔여수를 한 번에 보여주면 `getBuildingSummary` 를 그 페이지로 구현(1회 로드). 단순 링크이거나 연박 조건을 못 받으면: (a) 동마다 `/calendar` 를 읽어 합산하거나 (b) 이 기능을 제외. 사용자와 상의 후 결정.
- 소노 달력에서 `예약가능`·`마감` 이 실제로 어떤 텍스트/스타일로 표시되는지 (스크린샷엔 `마감임박`, `예약대기` 만 확인됨).
- 객실종류 체크박스 상태가 URL 파라미터로 전달되는지. 되면 달력을 객실종류별로도 보여줄 수 있음 (선택 기능).
- 사내 게시판이 게시글 내 iframe 을 허용하는지. 불가하면 게시글에는 링크 버튼만 두고 새 창으로 연다.
  (`web/게시판-삽입-코드.txt` 에 iframe 과 링크 버튼 두 가지를 다 넣어 뒀다 — 게시판에서 시험 필요)
- ~~Firebase 프로젝트~~ -> 신규 `anc-resort` 생성 완료 (2026-09-02). Firestore 서울 리전, 보안 규칙 배포됨.
- 아난티·한화 화면 구조 (Phase 6 진입 시 스크린샷 수집).

## 13. 단계별 작업

- **Phase 0 — 탐색** : `bot/scripts/explore-sono.ts`. `headless:false` 로 소노 로그인 → 달력 → 모달까지 수동 진행하며 네트워크 요청 기록. JSON API 유무와 URL 파라미터 구조 파악. 결과를 `bot/docs/sono-site-notes.md` 에 기록.
- **Phase 1 — 기본정보** : `seed-master.ts` 로 소노 `nodes`, `rooms`, 사진 수집 → Firestore/Storage. 직원이 실제 가는 숙소만 `active:true`.
- **Phase 2 — 소노 어댑터** : `getCalendar`, `getDetail` 로컬 성공. 세션 재사용 검증(로그인 1회 후 재시작해도 로그인 안 함).
- **Phase 3 — 서비스화** : `server.ts`, Dockerfile, Cloud Run 배포, Secret Manager 연결, `/health`.
- **Phase 4 — 화면** : `web/` 구현, Hosting 배포, 게시판 iframe 삽입 테스트.
- **Phase 5 — 관찰 2~3주** : 실패율, 로그인 횟수, 응답 시간 로그 확인. 계정 이상 없으면 통과. **← 현재 단계**
- **Phase 6 — 확장** : ~~아난티~~ ~~한화~~ **완료** (2026-09-02).
  `docs/anantti-site-notes.md` · `docs/hanwha-site-notes.md`

### 리조트 세 곳의 차이 (한눈에)

| | 소노 | 아난티 | 한화 |
|---|---|---|---|
| API 구조 | 경로별 REST | 숙소별 경로 | **엔드포인트 1개 + `INTF_ID`** |
| 로그인 | 1단계 | 1단계 (별도 도메인) | **3단계** (+회원권 비밀번호) |
| 달력 상태 | 5단계 (A/E/W/D/N) | **2단계** (오픈 여부만) | 3단계 |
| 잔여 객실수 | ○ | 강남만 | ○ |
| 날짜별 요금 | ○ | ✗ (합계만) | ○ |
| 객실 사진 | ○ | ○ (대표 사진 그룹 연결) | ○ (객실 코드 연결) |
| 특이사항 | 위탁 3곳은 요금 방식이 다름 | CSRF 토큰 필수 | 숙소별 응답 형식 상이 |

### 반복해서 부딪힌 것들 (다음 리조트 작업 때 먼저 확인)

1. **로그인 요청 본문이 기록에 평문으로 남을 수 있다.** 한화가 `j_username`/`j_password` 를
   `/static/j_spring_security_check.sec` 로 보내는데 마스킹을 빠져나갔다.
   `explore.ts` 의 `AUTH_URL` 과 `isSensitive()` 를 먼저 확인할 것.
2. **인증 헤더는 쿠키만이 아니다.** 아난티는 `x-csrf-token`(페이지 `<meta name="_csrf">`),
   `x-requested-with` 가 모두 있어야 한다. 셋 중 하나만 빠져도 403.
3. **못 쓰는 세션 쿠키는 반드시 지우고 로그인한다.** 남겨 두면 사이트가 오류 페이지를 준다(한화).
4. **모르는 상태 코드는 절대 추측하지 않는다.** `unknown` 으로 두고 로그에 남기면
   화면에 점선으로 드러난다. 소노 `N: 예약불가` 를 이렇게 찾았다.
5. **계산식을 바꾸면 `details`·`snapshots` 를 비운다.** 안 그러면 옛 결과가 화면에 계속 보인다.
6. **로그인 상한은 실제로 자격을 넣기 직전에만 차감한다.** 폼을 못 찾은 실패까지 세면
   하루 20회가 금방 소진된다.

### 아난티에서 배운 것 (한화 작업 때 참고)

- 예약 API 가 **CSRF 토큰**(`x-csrf-token`)을 요구했다. 쿠키만으로는 403 이다.
  토큰은 페이지의 `<meta name="_csrf">` 에 있다 → **API 를 부르기 전에 페이지를 한 번 열어야 한다.**
- 그래서 탐색 스크립트가 `x-*` 헤더를 기록하도록 고쳤다(토큰 값은 가림). 같은 삽질을 반복하지 않는다.
- 사이트가 주지 않는 정보는 만들어내지 않는다. 아난티 달력은 잔여를 주지 않으므로
  `open`(눌러서 확인) 이라는 별도 상태로 두었다. `available` 로 바꿔 쓰면 거짓이 된다.
- 같은 리조트 안에서도 **숙소마다 API 이름과 응답 필드가 다를 수 있다**(아난티 코브·강남).

## 14. 작업 규칙 (Claude Code에게)

- 한 Phase 를 끝내기 전에 다음 Phase 코드를 미리 쓰지 않는다.
- 사이트 구조는 스크린샷·탐색 결과에서 확인된 것만 코드에 반영한다. 추측한 선택자는 `// TODO(verify)` 주석을 단다.
- 선택자·상태 텍스트·URL 패턴은 어댑터 파일 상단 상수로 모은다. 사이트가 바뀌면 그 블록만 고치면 되게.
- 계정 정보, 쿠키, 토큰을 커밋·로그·채팅 출력에 절대 포함하지 않는다.
- 예약을 실행하거나 상태를 바꾸는 코드는 어떤 이유로도 작성하지 않는다.
- 사용자는 비개발자다. 명령어를 안내할 때는 복사해서 그대로 실행할 수 있는 형태로, 무엇을 하는 명령인지 한 줄 설명을 붙인다.
- 커밋 메시지·주석·문서는 한국어.
