# 아난티 객실 사진 경로 조사 — 2026-09-10

## 확인 결과

6개 숙소의 39개 객실 **유형/그룹**에 대해 공식 예약 페이지의 분기 조건과 대표 사진 URL을 확인했다. 개별 예약 옵션 수와는 다르다. 모든 URL은 비로그인 GET으로 HTTP 200, image/* Content-Type, 0보다 큰 응답 크기를 확인했다. 빌라쥬 듀플렉스는 이미지를 열어 실제 객실 내부 사진임을 확인했다.

[manifest.json](manifest.json)에 공식 페이지 URL, 카드 ID, 이름, 조건식, 사진 주소와 검증 결과를 기록했다. 조건식은 조사 근거이며 실행하지 않는다.

## 경로와 연결 방법

1. 공식 회원 예약 페이지 `https://ananti.kr/ko/reservation/{property}/room-search`에 저장된 인증 세션으로 접근한다.
2. 페이지 내부 JS가 예약 응답의 `rmCode`를 검사해 특정 카드(`#…Div .roomInfo`)에 객실을 배치한다. 강남만 `RESERVE_RTYPE`을 사용한다.
3. 그 카드의 `.img-room` 배경 이미지가 해당 객실 그룹의 대표 사진이다. CDN URL은 로그인 없이 열 수 있다.
4. 다른 날짜의 가격·전망·침대 옵션이 같은 카드로 묶이는 경우, 공식 페이지도 같은 대표 사진을 사용한다. 옵션마다 별도로 촬영한 사진이라고 표시하면 안 된다.

예: 빌라쥬 `rmCode=CDH` → `dupDiv` → [듀플렉스 사진](https://cdn.ananti.kr/plf/ui/img/reservation/roomImg/village/duplex_20260812.jpg).

## 숙소별 확인 범위

| 숙소 | 대표 사진 연결 그룹 수 | 연결 기준 |
|---|---:|---|
| 남해 | 5 | rmCode |
| 코드(가평) | 5 | rmCode |
| 코브(부산) | 6 | rmCode |
| 강남 | 7 | RESERVE_RTYPE |
| 제주 | 6 | rmCode |
| 빌라쥬 | 10 | rmCode |

## 갤러리 코드를 그대로 수집하면 안 되는 이유

- 빌라쥬의 갤러리 버튼은 주석 처리돼 있고, 남아 있는 갤러리 함수가 부산 호텔 사진을 가리킨다. 실제 카드 사진을 사용해야 한다.
- 제주의 비활성 갤러리 함수에는 남해 사진이 남아 있다. 제주 카드에는 올바른 제주 사진이 있다.
- 공통 모달 초기 HTML에는 코드(가평)의 기본 이미지가 다른 숙소에도 포함돼 있다. 페이지 전체의 img URL을 한꺼번에 모으면 오매칭된다.
- 코브 Royal Chapter는 공식 카드 자체가 씨사이드와 같은 대표 이미지를 사용한다.
- 강남 일부 갤러리에는 해피아워 안내 이미지가 섞여 있다. 사진 확대 갤러리를 추가할 때는 객실 사진과 혜택 안내를 구분해야 한다.

## 현재 프로그램에 연결할 때 필요한 변경

- `bot/src/adapters/anantti.ts`의 `readRoomRow()`는 `rmType`을 보존하지만 `rmCode`는 버린다. `rmCode`를 읽고 상세의 `siteRef`에 보존해야 한다.
- 기존 `roomId=anantti-{property}-{rmType}`는 유지한다. 이름 유사도 대신 **숙소 + rmCode**(강남은 RESERVE_RTYPE)로 확인된 대표 사진 그룹을 찾는다.
- 사진은 기존 소노와 같은 Storage 수집 흐름으로 옮겨 `rooms/{roomId}.images`에 연결할 수 있다. 정원 데이터가 없는 사진 전용 문서는 기존 API 정원 표시를 가리지 않게 처리해야 한다.
- 이전에 저장된 상세에는 `rmCode`가 없으므로 새 상세 조회 또는 기본정보 수집으로 숫자 `rmType`과 `rmCode`의 짝을 확보해야 한다.
- 확인되지 않은 신규 코드는 사진 없음으로 유지한다.

## 연결 및 배포 완료 (2026-09-10)

- 공식 분기 규칙을 `bot/src/adapters/anantti-images.json`과 `anantti-images.ts`에 반영했다. 알 수 없는 코드는 연결하지 않는다.
- 상세 응답에 `rmCode`와 `photoGroup`을 보존하고, 화면에서 기존 객실 사진 또는 해당 그룹의 사진을 표시한다.
- 39개 대표 사진 그룹을 Storage에 저장하고 예약 옵션 69행에 해당하는 고유 객실 ID 67개에 연결했다. 코브는 일부 옵션이 같은 객실 ID를 사용하며 사진 그룹 충돌이 없음을 검증했다.
- 사진 전용 문서가 API의 정원 정보를 가리지 않도록 화면의 정원 표시를 보완했다.
- 사진 저장소 39개 파일의 HTTP 응답, 그룹 매핑 테스트, TypeScript 검사, 프론트 자동 검증을 통과했다.
- Firebase Hosting과 Cloud Run 리비전 `anc-resort-bot-00014-tgb`에 배포했다. 운영 빌라쥬 조회에서 썸네일 및 사진 확대를 확인했다.
- 추가 수집: `tsx scripts/seed-anantti-images.ts`로 dry-run 후 `--apply`로 저장한다. 기존 사진이 있으면 재사용한다.
- 저장소 검증: `tsx scripts/verify-anantti-images.ts`.


## 재조사

`bot/scripts/inspect-anantti-images.ts`는 기존 암호화 세션을 재사용하여 6개 페이지에서 카드 정보와 사진 관련 코드만 `/tmp/anantti-image-evidence/`에 추출한다. 원본 HTML·쿠키·회원 식별자는 저장하지 않는다. 실행에는 기존 GCP 인증이 필요하다.
