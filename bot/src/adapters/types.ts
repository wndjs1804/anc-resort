/**
 * 리조트 어댑터 공통 인터페이스 (CLAUDE.md §7.1)
 *
 * 리조트마다 사이트 구조가 다르므로, 화면과 서버가 기대하는 모양은 여기서 고정하고
 * 사이트를 읽는 방법만 어댑터가 각자 구현한다.
 */

import type { BrowserContext } from 'playwright';

export type ResortId = 'sono' | 'anantti' | 'hanwha';

/**
 * 달력 한 칸의 상태.
 *
 * `open` 은 아난티처럼 **사이트가 날짜별 잔여를 알려주지 않는 경우**에 쓴다.
 * "예약이 오픈된 날짜이니 눌러서 확인하라" 는 뜻이지, 방이 있다는 뜻이 아니다.
 * 없는 정보를 있는 것처럼 available 로 바꿔 쓰지 않는다.
 */
export type DayStatus = 'available' | 'closing' | 'waitlist' | 'full' | 'open' | 'unknown';

/** 객실 한 줄의 상태. 연박 중 일부만 가능하면 partial. */
export type RoomStatus = DayStatus | 'partial';

/** 선택 트리의 노드 (Firestore nodes 문서와 같은 모양) */
export type Node = {
  id: string;
  resortId: string;
  parentId: string | null;
  level: string;
  name: string;
  order: number;
  bookable: boolean;
  siteRef: Record<string, unknown>;
  active: boolean;
};

/** 하루치 금액 내역 */
export type PerNight = {
  date: string;      // yyyy-MM-dd
  base: number;      // 할인 전 원가
  discount: number;  // 할인액 (0 이면 할인 없음)
  final: number;     // 실제 금액
};

/** 상세 화면의 객실 한 줄 */
export type DetailRoom = {
  roomId: string;              // Firestore rooms 문서 id 와 같은 규칙
  path: string[];              // 계층 (그룹핑용)
  name: string;                // 사이트가 부르는 객실 이름
  status: RoomStatus;
  waitCount: number | null;    // 대기 순번/인원. 없으면 null
  availableNights: string[];   // partial 일 때만 채운다 (yyyy-MM-dd)
  total: number | null;        // 회원가 합계. 마감이면 null
  perNight: PerNight[];
  siteRef: Record<string, unknown>;
};

/** 같은 숙소 안 동별 잔여 (선택 기능) */
export type BuildingRemaining = {
  nodeId: string;
  name: string;
  remaining: number;
};

export type CalendarResult = {
  days: Record<string, DayStatus>;   // "2026-09-24" → 상태
  fetchedAt: Date;
};

export type DetailResult = {
  buildings: BuildingRemaining[];
  rooms: DetailRoom[];
  fetchedAt: Date;
};

/** 오류 코드 (CLAUDE.md §7.5) */
export type AdapterErrorCode =
  | 'auth_failed'    // 세션 복구·로그인 실패
  | 'parse_failed'   // 응답 구조가 예상과 다름 (사이트 개편 의심)
  | 'maintenance'    // 사이트 점검
  | 'blocked'        // 차단 감지
  | 'timeout'        // 시간 초과
  | 'rate_limited';  // 우리 쪽 로그인 상한 초과

export class AdapterError extends Error {
  constructor(
    readonly code: AdapterErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

export interface ResortAdapter {
  readonly id: ResortId;

  /** 쿠키 복원 → 로그인 여부 확인 → 필요할 때만 로그인 */
  ensureSession(ctx: BrowserContext): Promise<void>;

  /**
   * 세션이 살아 있는지만 확인한다. **로그인을 시도하지 않는다.**
   * /health 처럼 인증 없이 열린 곳에서 쓰기 위한 것이다.
   */
  sessionAlive(ctx: BrowserContext): Promise<boolean>;

  /** 월 달력. 박수와 무관하게 항상 1박 기준이다 (CLAUDE.md §8) */
  getCalendar(ctx: BrowserContext, node: Node, yyyyMM: string): Promise<CalendarResult>;

  /** 체크인 날짜 + 박수 기준 상세 */
  getDetail(ctx: BrowserContext, node: Node, checkin: string, nights: number): Promise<DetailResult>;

  /** 같은 숙소 안 동별 잔여. 지원하지 않으면 구현하지 않는다. */
  getBuildingSummary?(ctx: BrowserContext, node: Node, checkin: string, nights: number): Promise<BuildingRemaining[]>;
}
