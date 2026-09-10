# ACE Nanochem 휴양시설 포털 — 디자인 토큰 & 재현 프롬프트

## 1) 문서 목적
이 문서는 ACE Nanochem 휴양시설 포털의 시각 스타일을 일관되게 재현하기 위한 **디자인 토큰**, **공통 UI 규칙**, **페이지별 구조 가이드**, 그리고 **이미지 생성 프롬프트**를 정리한 문서입니다.

대상 페이지:
1. 이용조회
2. 공지사항
3. 자주 묻는 질문

이 문서는 기존 제작 페이지에 참조용 샘플 이미지를 넣고, 최대한 동일한 느낌으로 재현하기 위한 기준서로 사용합니다.

---

## 2) 디자인 컨셉 요약
- **키워드**: 신뢰감, 청결함, 휴양감, 복지포털, 정돈된 기업 UI
- **브랜드 인상**: 반도체/소재 기업의 전문성과 휴양시설의 편안함이 함께 느껴지는 디자인
- **분위기**: 밝고 시원한 블루 톤, 흰색 중심 레이아웃, 부드러운 라운드, 깔끔한 카드형 UI
- **스타일 방향**:
  - 기업 포털 UI
  - 호텔/리조트 예약 서비스의 정돈된 고급감
  - 과도하게 화려하지 않고 안정적이며 실사용 가능한 화면

---

## 3) 브랜드 자산 사용 원칙
- 좌측 상단 로고는 **ACE nanochem 로고**를 사용
- 로고 주변은 충분한 여백 유지
- 브랜드 컬러는 **블루 계열** 중심으로 확장
- 배경 이미지(히어로)는 **리조트/수영장/호수/산 풍경**이 어우러진 휴양형 비주얼 사용
- 전체 UI는 로고보다 튀지 않도록, 브랜드 블루를 메인 포인트로 활용

---

## 4) 디자인 토큰

### 4-1. Color Tokens

```yaml
color:
  brand:
    primary: "#1F6BFF"        # 메인 CTA, 활성 메뉴, 포인트 블루
    primary-hover: "#1657D9"
    primary-soft: "#EAF2FF"   # 연한 블루 배경
    primary-deep: "#153A8A"   # 제목/강조 텍스트
    logo-blue: "#1AA7E8"      # 로고 및 보조 비주얼 톤

  text:
    heading: "#102B60"        # 메인 타이틀
    body: "#31435F"           # 본문
    muted: "#6F809B"          # 설명, 서브 텍스트
    placeholder: "#98A5BA"
    inverse: "#FFFFFF"

  background:
    page: "#F4F8FC"           # 전체 화면 배경
    sidebar: "#F7FBFF"        # 좌측 사이드바 배경
    surface: "#FFFFFF"        # 카드/패널 배경
    hero-overlay: "rgba(255,255,255,0.16)"

  border:
    default: "#D9E4F2"
    soft: "#E7EEF7"
    strong: "#C9D7EB"

  state:
    available-text: "#21A366"
    available-bg: "#E9F8EF"

    low-text: "#F59E0B"
    low-bg: "#FFF4E5"

    wait-text: "#2563EB"
    wait-bg: "#EAF2FF"

    closed-text: "#7E8A9A"
    closed-bg: "#EFF2F6"

  board:
    important-text: "#E14B4B"
    important-bg: "#FDECEC"

    notice-text: "#2A6CF0"
    notice-bg: "#EAF2FF"

    event-text: "#239B63"
    event-bg: "#EAF8F0"

    faq-booking-text: "#2A6CF0"
    faq-booking-bg: "#EAF2FF"

    faq-payment-text: "#2FA46A"
    faq-payment-bg: "#EAF8F0"

    faq-usage-text: "#8A68E8"
    faq-usage-bg: "#F1ECFF"

    faq-etc-text: "#6F809B"
    faq-etc-bg: "#EFF2F6"
```

### 4-2. Typography Tokens

```yaml
typography:
  font-family:
    primary: "Pretendard, Noto Sans KR, Apple SD Gothic Neo, sans-serif"

  font-size:
    display: 56px
    h1: 44px
    h2: 24px
    h3: 20px
    body-lg: 18px
    body: 16px
    body-sm: 14px
    caption: 12px

  font-weight:
    regular: 400
    medium: 500
    semibold: 600
    bold: 700

  line-height:
    tight: 1.2
    normal: 1.5
    relaxed: 1.7

  letter-spacing:
    tight: -0.02em
    normal: 0
    wide: 0.08em   # 상단 영문 서브 타이틀
```

### 4-3. Spacing Tokens

```yaml
spacing:
  4: 4px
  8: 8px
  12: 12px
  16: 16px
  20: 20px
  24: 24px
  32: 32px
  40: 40px
  48: 48px
  56: 56px
```

### 4-4. Radius Tokens

```yaml
radius:
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
  pill: 999px
```

### 4-5. Shadow Tokens

```yaml
shadow:
  card: "0 6px 24px rgba(17, 56, 114, 0.06)"
  floating: "0 10px 30px rgba(17, 56, 114, 0.10)"
  button: "0 6px 16px rgba(31, 107, 255, 0.18)"
```

### 4-6. Layout Tokens

```yaml
layout:
  desktop-canvas:
    width: 1680px
    height: 1024px

  sidebar:
    width: 220px
    padding-x: 20px
    padding-top: 28px

  content:
    padding-x: 24px
    padding-y: 24px
    gap: 16px

  hero-banner:
    height: 170px
    radius: 0px

  filter-card:
    min-height: 92px
    radius: 16px

  main-card:
    radius: 18px
```

### 4-7. Component Tokens

```yaml
components:
  sidebar-item:
    height: 56px
    radius: 14px
    icon-size: 22px
    text-size: 16px
    active-bg: "#1F6BFF"
    active-text: "#FFFFFF"
    default-text: "#1F3766"

  button-primary:
    height: 58px
    radius: 12px
    bg: "#1F6BFF"
    text: "#FFFFFF"
    icon-size: 22px

  input:
    height: 48px
    radius: 10px
    border: "1px solid #D9E4F2"
    bg: "#FFFFFF"

  badge:
    height: 30px
    padding-x: 12px
    radius: 999px
    text-size: 14px
    weight: 600

  card:
    bg: "#FFFFFF"
    radius: 18px
    border: "1px solid #E6EDF7"
    shadow: "0 6px 24px rgba(17, 56, 114, 0.06)"

  table-row:
    height: 68px
    divider: "#E6EDF7"

  accordion-item:
    min-height: 58px
    expanded-min-height: 128px
    radius: 14px
```

---

## 5) 공통 레이아웃 규칙

### 5-1. 좌측 사이드바
- 좌측 고정형 사이드바 사용
- 상단에 ACE nanochem 로고 배치
- 메뉴 3개 구성:
  1. 이용조회
  2. 공지사항
  3. 자주 묻는 질문
- 활성 메뉴는 **진한 블루 배경 + 흰색 아이콘/텍스트**
- 비활성 메뉴는 **흰색/밝은 배경 + 진한 남색 텍스트**
- 하단에는 옅은 블루 계열 기업 슬로건/그래픽 배치 가능

### 5-2. 메인 상단 히어로 영역
- 가로형 리조트 풍경 배너 사용
- 배너 위에 반투명한 시원한 톤 오버레이 허용
- 좌측 상단에는 소문자/대문자 영문 보조 문구:
  - `COMPANY BENEFIT 3`
- 메인 페이지 타이틀은 크게 표시
- 우상단에는 손글씨 느낌 슬로건 배치 가능

### 5-3. 카드 규칙
- 주요 정보 블록은 모두 흰색 카드
- 카드 모서리는 둥글고(16~18px), 그림자는 아주 은은하게
- 카드 내부는 충분한 상하좌우 패딩 유지

### 5-4. 상태 표기 규칙
캘린더 및 객실 상태는 **색상만 쓰지 말고 텍스트가 직접 보이게** 구성

상태 종류:
- 예약가능
- 잔여객실 적음
- 예약대기
- 마감

표시 방식:
- pill badge 형태
- 배경은 연한 톤, 텍스트는 진한 상태색
- 텍스트가 작더라도 직접 읽히게 해야 함

---

## 6) 페이지별 구조 규칙

## 6-1. 이용조회 페이지 구조

### 화면 구성 순서
1. 좌측 사이드바
2. 상단 히어로 배너 + 페이지 제목
3. 조회 필터 카드
4. 캘린더 카드
5. 우측 선택 일정 카드
6. 하단 이용 가능 객실 목록

### 조회 필터 항목
- 리조트
- 지역
- 숙소
- 동
- 박수
- 조회하기 버튼

### 캘린더 규칙
- 월 단위 보기
- 각 날짜 셀 안에 직접 상태 텍스트 배지 노출
- 범례도 상단에 함께 표시
- 선택한 날짜는 연한 블루 하이라이트

### 우측 선택 일정 카드
항목 예시:
- 선택한 일정
- 2026년 9월 24일 (목)
- 리조트: 소노
- 지역: 강원권
- 숙소: 소노펫 비발디파크
- 동: 전체
- 박수: 1박
- 안내문: 예약은 담당자 김사랑 Pro에게 요청해 주세요.

### 하단 객실 목록 규칙
- **갤러리형 금지**, **목록형 유지**
- 각 행에는 다음 정보 포함:
  - 사진 썸네일
  - 객실명
  - 객실 특징(예: 파크뷰 · 침대 · 취사)
  - 기준/최대 인원
  - 객실 상태
  - 1박 요금
  - 우측 액션 버튼(객실 정보)
- 테이블형 + 카드형의 중간 느낌
- 각 row는 흰색 바탕, 구분선, 가벼운 라운드

---

## 6-2. 공지사항 페이지 구조

### 화면 구성 순서
1. 좌측 사이드바
2. 상단 히어로 배너 + 페이지 제목
3. 공지사항 메인 카드
4. 카테고리 드롭다운 + 검색창 + 검색 버튼
5. 공지 목록 테이블
6. 하단 총 건수 + 페이지네이션

### 테이블 컬럼
- No.
- 구분
- 제목
- 등록일
- 조회
- 우측 화살표/상세 이동

### 구분 배지 예시
- 중요
- 안내
- 이벤트

### 시각 포인트
- 제목은 한 줄 또는 두 줄 내에서 정돈되게
- 상단 헤더 row는 옅은 블루 그레이 배경
- hover 시 row 강조 가능해 보이는 스타일

---

## 6-3. 자주 묻는 질문 페이지 구조

### 화면 구성 순서
1. 좌측 사이드바
2. 상단 히어로 배너 + 페이지 제목
3. FAQ 메인 카드
4. 카테고리 드롭다운 + 검색창 + 검색 버튼
5. FAQ 아코디언 목록
6. 하단 총 건수 + 페이지네이션

### FAQ 카테고리 배지 예시
- 예약
- 결제
- 이용
- 기타

### FAQ 아코디언 규칙
- 첫 1~2개는 펼쳐진 상태 예시 가능
- 나머지는 접힌 상태
- 질문은 굵게, 답변은 muted body text
- 각 row 우측에는 chevron 아이콘
- 아코디언 박스는 흰색/연한 블루 라인 기반

---

## 7) 참조 이미지 사용 가이드
실제 재현 시, 아래 이미지들을 참조 이미지로 함께 넣는 것을 권장합니다.

### 공통 참조
- **참조 이미지 A**: ACE nanochem 로고 이미지
- **참조 이미지 B**: 이용조회 페이지 샘플
- **참조 이미지 C**: 공지사항 페이지 샘플
- **참조 이미지 D**: 자주 묻는 질문 페이지 샘플

### 참조 목적
- A: 브랜드 로고 형태와 컬러 확인
- B: 공통 레이아웃, 사이드바, 필터, 캘린더, 객실 리스트 구조 확인
- C: 공지사항 보드형 목록 UI 구조 확인
- D: FAQ 아코디언 UI 구조 확인

---

## 8) 이미지 생성 공통 프롬프트 작성 원칙
프롬프트에는 아래 조건을 항상 포함하는 것을 권장합니다.

### 필수 공통 지시사항
- ACE nanochem 복지포털 스타일 유지
- 밝고 정돈된 기업형 웹 UI
- 흰색 카드, 연한 블루 배경, 선명한 브랜드 블루 포인트
- 좌측 고정 사이드바 유지
- 로고는 좌측 상단에 배치
- 한글 UI, 가독성 높은 실제 웹화면 느낌
- 너무 화려한 랜딩페이지가 아니라 실무에서 바로 쓸 수 있는 관리자/직원 포털 수준의 완성도
- 가짜 텍스트 남발 금지, 실제 읽을 수 있는 한국어 문구 위주
- 스크린샷 목업처럼 정면에서 본 데스크톱 웹 화면
- 16:9 또는 넓은 데스크톱 비율

---

## 9) 페이지별 재현 프롬프트

## 9-1. 이용조회 페이지 프롬프트

```text
Create a polished desktop web UI mockup for the ACE nanochem corporate benefits portal. Use the provided reference images to closely match the same visual system and layout.

Reference usage:
- Image A is the ACE nanochem logo reference. Use it in the top-left of the left sidebar.
- Image B is the main style and layout reference for the 이용조회 page. Match its overall layout, spacing, color palette, card style, and information hierarchy.

Design requirements:
- Clean Korean enterprise portal UI.
- Light blue and white color palette with bright brand-blue accents.
- Fixed left sidebar with three menu items: 이용조회, 공지사항, 자주 묻는 질문.
- The active sidebar item is 이용조회.
- Large resort hero banner across the top of the content area, with a calm luxury vacation mood, blue lake or sea, mountains, and poolside resort chairs.
- Small English label near the top: "COMPANY BENEFIT 3".
- Main page title: "휴양시설 이용조회".
- Subtitle: "회사 휴양시설의 예약 가능 일정과 객실 정보를 확인하세요."

Filter bar:
- White rounded search card under the hero banner.
- Include dropdown fields labeled: 리조트, 지역, 숙소, 동, 박수.
- Selected values can be: 소노 / 강원권 / 소노펫 비발디파크 / 전체 / 1박.
- Large blue button on the right labeled "조회하기".

Calendar area:
- Large white rounded card showing "2026년 9월".
- Show previous and next month buttons.
- At the top of the calendar, display a legend with four statuses: 예약가능, 잔여객실 적음, 예약대기, 마감.
- Inside date cells, do not use dots only; directly show text badges such as "예약가능", "잔여객실 적음", "예약대기", and "마감".
- Use soft green, orange, blue, and gray pill badges.
- Highlight one selected date: 24.

Selected schedule card on the right:
- Title: "선택한 일정".
- Main date: "2026년 9월 24일 (목)".
- Display rows for 리조트, 지역, 숙소, 동, 박수.
- Example values: 소노 / 강원권 / 소노펫 비발디파크 / 전체 / 1박.
- Bottom info text: "예약은 담당자 김사랑 Pro에게 요청해 주세요."

Room list area:
- Section title: "이용 가능한 객실".
- Show a small count badge, for example "3개".
- Use a list-style layout, not a gallery grid.
- Each row should include a small room thumbnail photo on the left, then room name, room features, occupancy, status badge, price per night, and a right-side button.
- Keep the original list/table style.
- Example rows:
  1) 패밀리 Pet Club / 파크뷰 · 침대 · 취사 / 기준 4인 | 최대 6인 / 예약가능 / 280,000원 / 1박 / button "객실 정보"
  2) 스탠다드 Pet Club / 스탠다드 · 침대 · 취사 / 기준 4인 | 최대 6인 / 잔여객실 적음 / 245,000원 / 1박 / button "객실 정보"
  3) 디럭스 Pet Club / 마운틴뷰 · 침대 · 취사 / 기준 6인 | 최대 8인 / 예약대기 / 320,000원 / 1박 / button "객실 정보"

Visual quality:
- High-fidelity UI screenshot mockup.
- Crisp typography, realistic alignment, soft shadows, rounded cards.
- Professional corporate portal quality.
```

---

## 9-2. 공지사항 페이지 프롬프트

```text
Create a polished desktop web UI mockup for the ACE nanochem corporate benefits portal notice board page. Use the provided reference images to closely match the same design system.

Reference usage:
- Image A is the ACE nanochem logo reference. Use it in the top-left of the left sidebar.
- Image B is the shared portal style reference for layout, colors, hero banner, and sidebar.
- Image C is the main structure reference for the 공지사항 page. Match the notice-list layout closely.

Design requirements:
- Same overall layout system as the 이용조회 page.
- Fixed left sidebar with menu items: 이용조회, 공지사항, 자주 묻는 질문.
- The active sidebar item is 공지사항.
- Same bright resort hero banner and corporate-blue UI language.
- Small English label near the top: "COMPANY BENEFIT 3".
- Main page title: "공지사항".
- Subtitle: "휴양시설 이용과 관련된 중요한 안내사항을 확인해 주세요."

Main notice board card:
- Large rounded white content panel.
- Top controls include a category dropdown on the left, a large search field in the center, and a blue search button on the right.
- Category default: "전체".
- Search placeholder: "제목 또는 내용을 검색하세요."

Notice list table:
- Use a neat table-style board.
- Column headers: No. / 구분 / 제목 / 등록일 / 조회 / action.
- Header background should be a very light blue-gray.
- Each row has a category badge and a clean right arrow icon.
- Use readable Korean text, not gibberish.

Example rows:
- 128 / 중요 / 2026년 하반기 휴양시설 이용 신청 안내 / 2026.08.25 / 243
- 127 / 안내 / 소노펫 비발디파크 객실 리뉴얼 및 추가 오픈 안내 / 2026.08.18 / 156
- 126 / 안내 / 2026년 추석 연휴 휴양시설 운영 일정 안내 / 2026.08.10 / 312
- 125 / 안내 / 휴양시설 이용 시 유의사항 안내 / 2026.07.28 / 198
- 124 / 안내 / 여름 성수기(7~8월) 이용 현황 및 잔여 객실 안내 / 2026.07.12 / 164
- 123 / 안내 / 아난티코브 신규 제휴 및 객실 이용 안내 / 2026.06.30 / 221
- 122 / 이벤트 / 휴양시설 이용 후기 이벤트 안내 / 2026.06.15 / 178
- 121 / 안내 / 한화리조트 이용 시설 및 부대시설 안내 / 2026.05.22 / 145
- 120 / 안내 / 휴양시설 예약 문의처 안내 / 2026.05.08 / 201
- 119 / 안내 / 2025년 이용 우수 후기 선정 결과 발표 / 2026.04.25 / 260

Badge colors:
- 중요: soft red badge
- 안내: soft blue badge
- 이벤트: soft green badge

Footer:
- Bottom-left text: "총 128건"
- Center pagination with active page 1 and surrounding page numbers.

Visual quality:
- High-fidelity Korean web UI screenshot.
- Consistent spacing and typography with the shared portal design.
```

---

## 9-3. 자주 묻는 질문 페이지 프롬프트

```text
Create a polished desktop web UI mockup for the ACE nanochem corporate benefits portal FAQ page. Use the provided reference images to closely match the same design system and style.

Reference usage:
- Image A is the ACE nanochem logo reference. Use it in the top-left of the left sidebar.
- Image B is the shared portal style reference for the overall layout, hero banner, sidebar, and card design.
- Image D is the main structure reference for the FAQ page. Match the FAQ panel and accordion layout closely.

Design requirements:
- Same overall ACE nanochem portal style.
- Fixed left sidebar with menu items: 이용조회, 공지사항, 자주 묻는 질문.
- The active sidebar item is 자주 묻는 질문.
- Light blue and white enterprise UI with a resort hero banner.
- Small English label near the top: "COMPANY BENEFIT 3".
- Main page title: "자주 묻는 질문".
- Subtitle: "휴양시설 이용 중 자주 문의하시는 내용을 확인해보세요."

Main FAQ card:
- Large rounded white panel.
- Top controls include a category dropdown, a search field, and a blue search button.
- Category default: "전체".
- Search placeholder: "질문 또는 내용을 검색하세요."

FAQ list:
- Use accordion-style rows.
- Each row includes a soft colored category badge on the left, a bold question title, and a chevron icon on the right.
- Show the first two items expanded and the rest collapsed.
- Expanded answer text should be readable, soft, and neatly aligned.

Example FAQ items:
1) 예약 / 예약은 어떻게 진행하나요?
   Answer: 이 화면은 휴양시설에 대한 정보 조회 전용입니다. 실제 예약은 각 사업장 담당자를 통해 신청해 주시기 바랍니다. 예약 가능 일정, 객실 유형, 이용 인원 등 상세 내용은 담당자에게 문의하시면 안내받으실 수 있습니다.

2) 결제 / 객실 요금은 회원가 기준인가요?
   Answer: 표시된 금액은 회사 임직원 대상 회원가 기준입니다. 실제 예약 가능 여부와 요금은 조회 시점 및 해당 시설의 운영 정책에 따라 달라질 수 있으므로, 정확한 금액은 담당자에게 확인해 주시기 바랍니다.

3) 예약 / 마감임박은 예약이 불가능한 상태인가요?
4) 이용 / 1박 초과 이용도 가능한가요?
5) 예약 / 예약 취소는 어떻게 하나요?
6) 이용 / 동반 인원 기준은 어디에서 확인하나요?
7) 이용 / 펫 객실 이용 시 유의사항이 있나요?
8) 기타 / 문의는 누구에게 하면 되나요?

Badge colors:
- 예약: soft blue badge
- 결제: soft green badge
- 이용: soft purple badge
- 기타: soft gray badge

Footer:
- Bottom-left text: "총 28건"
- Center pagination with active page 1.

Visual quality:
- High-fidelity, realistic Korean corporate web UI screenshot.
- Same spacing, card radius, and typography as the other pages.
```

---

## 10) 개발/디자인 적용 시 체크리스트

### 공통 체크리스트
- [ ] 좌측 사이드바 유지 여부 확인
- [ ] ACE nanochem 로고 반영
- [ ] 3개 메뉴 구조 일관성 유지
- [ ] 히어로 배너 톤 동일성 확보
- [ ] 카드 라운드/그림자 수준 통일
- [ ] 컬러 토큰 동일 적용
- [ ] 한글 텍스트 가독성 확보
- [ ] 실제 웹 서비스처럼 정면 데스크톱 UI 느낌 유지

### 이용조회 체크리스트
- [ ] 캘린더에 상태가 텍스트로 직접 표기되는지
- [ ] 하단 객실 목록이 목록형인지
- [ ] 갤러리형으로 바뀌지 않았는지
- [ ] 우측 선택 일정 카드 유지되는지

### 공지사항 체크리스트
- [ ] 공지 구분 배지 색상 구분이 명확한지
- [ ] 표 구조가 지나치게 복잡하지 않은지
- [ ] 페이지네이션과 총 건수 정보가 하단에 있는지

### FAQ 체크리스트
- [ ] 아코디언 구조가 명확한지
- [ ] 질문/답변 구분이 명확한지
- [ ] 카테고리 배지가 직관적인지

---

## 11) 권장 파일명
- `design-tokens-ace-resort-portal.md`
- `ace-resort-portal-prompts.md`
- 또는 본 문서를 통합 사용

---

## 12) 샘플 이미지 파일 매핑(참고)
프로젝트 내에서 참조하기 좋은 예시 파일명:
- `ace-logo.png`
- `sample-resort-inquiry-page.png`
- `sample-notice-page.png`
- `sample-faq-page.png`

실제 현재 대화 기준 생성 샘플:
- 이용조회 샘플: `휴양시설_예약조회_대시보드.png`
- 공지사항 샘플: `a_clean_web_ui_screenshot_of_a_corporate_benefit_p.png`
- FAQ 샘플: `ace_나노켐_자주_묻는_질문_페이지.png`

---

## 13) 한 줄 요약
이 포털은 **ACE nanochem의 기업 신뢰감**과 **휴양시설 서비스의 편안함**을 동시에 전달하는, 밝고 정돈된 블루 톤의 **기업형 복지 포털 UI**로 설계한다.
