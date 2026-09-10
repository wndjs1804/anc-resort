# 휴양시설 포털 디자인 검토

참고 PNG에 맞춰 배너, 사이드바, 필터, 달력·일정 카드, 객실 목록, 공지사항과 FAQ의 간격·글자 크기·색상을 조정했습니다.

- inquiry.png: 이용조회 데스크톱
- notices.png: 공지사항 (등록된 공지 없음)
- faq.png: 자주 묻는 질문
- mobile.png: 이용조회 모바일 390px

캡처의 조회 결과와 객실 사진은 자동 검증용 데이터입니다. 실제 리조트나 Firestore에 접근하지 않았습니다.

검증: `node web/tests/portal.mjs` — 저장 결과, 동적 숙소 선택, 날짜 선택, 연박/부분 가능 요금, 사진 확대 및 키보드 초점 복귀, 메뉴 이동, FAQ 검색, 빈 공지, 세 페이지의 320~1680px 레이아웃을 확인했습니다.

2026-09-10 Firebase Hosting 배포 완료: https://anc-resort.web.app
배포된 HTML, CSS, JS 및 이미지 7개 파일의 HTTP 200 응답과 로컬 파일 일치를 확인했습니다.

## 2026-09-10 최종 조정

- 최종 전달받은 가로·세로 일러스트를 Hero `resort-hero-v3.png`와 Sidebar `sidebar-resort-v3.png`로 반영했다.
- `crop-*`은 기존 `cover` 잘림 점검, `contain-*`은 전체 이미지 표시 점검, `v3-*`은 최종 색감·구도 점검 캡처다.
- `notice-type-adjusted.png`에서 공지 제목 `16px / 600`, 본문 `14px / 1.8`을 확인했다.
- 공지 작성기의 다중 이미지 붙여넣기와 모든 형식의 다중 첨부파일 UI를 브라우저 자동 검증했다.
