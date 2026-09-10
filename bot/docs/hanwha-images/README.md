# 한화 객실 사진 경로 조사 (2026-09-10)

## 결론

조사 당시 `seed-hanwha.ts`는 숙소·동만 저장하고 사진 수집이 빠져 있었다. 2026-09-10 별도 사진 수집 스크립트로 연결을 완료했다.

15개 숙소·동의 공개 객실안내 페이지에서 총 139개 객실 옵션 코드를 확인했다. 각 숙소의 기본 선택 객실 갤러리에 사진이 있으며 대표 URL의 HTTP 200과 이미지 응답을 확인했다. 이후 각 옵션의 실제 선택 코드와 갤러리를 모두 확인하고 대표 사진을 수집했다.

기존 Firestore 저장 상세에 있는 6개 위치의 고유 객실 코드 63종은 모두 해당 공식 페이지 선택 목록에 존재한다. 나머지는 저장 상세가 없어 이번 코드 비교 대상에 포함되지 않았다. 숫자는 `coverage.json`에 기록했다.

## 정확한 연결 경로

- 공식 URL: `https://www.hanwharesort.co.kr/irsweb/resort3/resort/rs_room.do?bp_cd={LOC_CD}&rm_cd={ROOM_TYPE_CD}`
- 숙소/동은 `LOC_CD`와 URL의 `bp_cd`를 연결한다. `BRCH_CD`를 넣으면 안 된다.
- 객실은 기존 `ROOM_TYPE_CD`와 URL의 `rm_cd`를 연결한다.
- 페이지의 `#sel_rm_cd` 선택 목록에 코드가 있는지 확인하고, `domSelectBox.val(...)`의 실제 선택 코드가 요청 코드와 일치하는지 확인해야 한다. 잘못된 코드의 기본 객실 사진을 가져오면 안 된다.
- `.rs_gallery .gallery .mg img`가 객실 갤러리다. 페이지 전체 img를 모으면 메뉴의 숙소 사진·이벤트 광고·평면도가 섞인다.
- 기존 `roomId=hanwha-{LOC_CD}-{ROOM_TYPE_CD}`를 그대로 사용해 Storage 사본과 `rooms/{roomId}.images`를 연결하면 프론트의 사진 확대를 재사용할 수 있다.
- 사진만 저장하는 문서는 이미 구현된 API 정원 fallback을 이용하므로 정원 정보가 가려지지 않는다.

실제 확인 예: [설악 쏘라노 HTE 객실](https://www.hanwharesort.co.kr/irsweb/resort3/resort/rs_room.do?bp_cd=0101&rm_cd=HTE)에는 해당 객실의 사진 6장이 있다. 비로그인으로 읽을 수 있다.

## 더플라자 예외

[더플라자 안내](https://www.hanwharesort.co.kr/irsweb/resort3/resort/plaza/rsa_room.do?bp_cd=3901)는 별도 템플릿이다. 비즈니스·디럭스·프리미어 스위트·플라자 스위트의 사진과 예약 객실 코드의 연결도 2026-09-10 추가 확인했다. BUK=비즈니스 룸, DXK/DXT=디럭스 룸 킹/트윈, PMK=프리미어 스위트, CPK=플라자 스위트다. 상단 기본 갤러리 3장은 사용하지 않고 해당 객실 유형 사진을 연결한다. DXK/DXT는 공식 공용 대표 사진을 사용하고 침대 구성 안내를 표시한다. `manifest.json`의 `roomImageCandidates`에 이름과 URL만 기록했다.

## 자료

- `manifest.json`: 16개 위치의 공식 URL, 15개 위치의 객실 선택 목록, 기본 선택 코드와 갤러리 URL, 대표 이미지 검증 결과.
- `coverage.json`: 기존 저장 예약 결과와 공식 코드 목록의 비교.
- `bot/scripts/inspect-hanwha-images.py`: 공개 페이지 재조사. 로그인 및 예약 API 호출 없음.
- `bot/scripts/check-hanwha-image-coverage.ts`: 저장 결과와 공식 코드의 비교. Firestore 읽기만 수행.

2026-09-10 운영 사진 데이터 연결과 Firebase Hosting 배포를 완료했다. 일반 15개 위치의 139개 객실과 더플라자 5개 객실, 총 144개 객실에 사진을 연결했다. 조회 API와 요금 계산 변경은 필요하지 않았다.

## 사진 연결 구현

- `seed-hanwha-images.ts --apply`: 공개 안내 페이지의 선택 코드와 요청 코드를 확인하고 객실별 대표 사진을 Storage에 복사, 기존 `hanwha-{LOC_CD}-{ROOM_TYPE_CD}` 문서에 연결한다. 이미 수집한 사진은 재사용하며 기존에 여러 장 저장된 갤러리도 보존한다.
- `seed-plaza-images.ts --apply`: 실제 예약 API에서 확인한 코드·이름과 공식 객실 유형 사진을 연결한다. 근거는 `plaza-rooms.json`, `plaza-mapping.json`에 있다.
- `verify-hanwha-images.ts`: 대상 객실 문서의 연결과 저장소 이미지 HTTP 응답을 점검한다.
- `tests/hanwha-images.ts`: 코드 불일치, 광고·평면도 혼입, 미확인 출처를 걸러내는지 검증한다.
- 운영 화면에서 설악 쏘라노와 더플라자의 썸네일 및 확대 사진 표시를 확인했다.
