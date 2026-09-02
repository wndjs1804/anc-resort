/**
 * 아난티 어댑터 (CLAUDE.md §7.1)
 *
 * 근거와 응답 구조는 docs/anantti-site-notes.md 에 정리돼 있다.
 *
 * 소노와 다른 점 두 가지를 기억할 것:
 *  1. 달력이 "예약 오픈된 날" 만 알려준다. 잔여는 날짜를 지정해야 나온다 → 상태는 open / full 뿐이다.
 *  2. 숙소마다 API 이름과 응답 필드가 다르다 (강남은 대문자, 코브는 엔드포인트 이름이 다름).
 *
 * 읽기 전용. 예약·취소 엔드포인트는 이 파일에 등장하지 않는다.
 */

import type { BrowserContext, Page } from 'playwright';

import { claimLoginSlot, saveStorageState } from '../browser.ts';
import { getCredentials } from '../secrets.ts';
import {
  AdapterError,
  type CalendarResult,
  type DayStatus,
  type DetailResult,
  type DetailRoom,
  type Node,
  type ResortAdapter,
  type RoomStatus,
} from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 상수 — 사이트가 바뀌면 이 블록만 고친다
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 'https://ananti.kr';
const LOGIN_BASE = 'https://me.ananti.kr';
const LOGIN_URL = `${LOGIN_BASE}/user/signin?loginRtnUrl=${encodeURIComponent(`${BASE}/ko/reservation`)}`;
const RESERVE_URL = `${BASE}/ko/reservation`;
/** 로그인 상태 확인용. 비로그인이면 302 로 로그인 페이지로 보낸다. */
const PROBE_URL = `${BASE}/ko/my/index`;

const SEL = { loginId: '#id', loginPw: '#pwd', loginSubmit: '#loginBtn' };

/**
 * 숙소별 설정 (docs/anantti-site-notes.md §2-1)
 * `shape: 'upper'` 는 응답 필드가 대문자인 곳이다.
 */
export const PROPERTIES: Record<string, {
  bsns: string; path: string; name: string; roomApi: 'search-only-room' | 'search-room'; shape: 'lower' | 'upper';
}> = {
  namhae:  { bsns: '12', path: 'namhae',  name: '아난티 남해',       roomApi: 'search-only-room', shape: 'lower' },
  chord:   { bsns: '24', path: 'chord',   name: '아난티코드 (가평)', roomApi: 'search-only-room', shape: 'lower' },
  cove:    { bsns: '25', path: 'cove',    name: '아난티코브 (부산)', roomApi: 'search-room',      shape: 'lower' },
  ganm:    { bsns: '36', path: 'ganm',    name: '아난티 앳 강남',    roomApi: 'search-only-room', shape: 'upper' },
  jeju:    { bsns: '38', path: 'jeju',    name: '아난티 (제주)',     roomApi: 'search-only-room', shape: 'lower' },
  village: { bsns: '40', path: 'village', name: '빌라쥬 드 아난티',  roomApi: 'search-only-room', shape: 'lower' },
};

/** 모든 예약 요청에 함께 나가는 값. 의미는 미확인이지만 화면이 늘 이 값을 보낸다. */
const GOLF_ID = 'G1';        // TODO(verify)
const RSVN_TYPE = 'RR';      // 객실(Room Reservation)

const MAINTENANCE_HINT = /(시스템\s*점검|서비스\s*점검|점검\s*중)/;
const BLOCKED_HINT = /(비정상적인 접근|접근이 차단|captcha|자동입력 방지)/i;

// ─────────────────────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(150 + Math.random() * 350);
const pad = (n: number) => String(n).padStart(2, '0');

function addDays(ymd: string, n: number): string {
  const d = new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
const dashed = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const compact = (s: string) => s.replace(/-/g, '');

function propertyOf(node: Node): (typeof PROPERTIES)[string] {
  const key = (node.siteRef as { property?: string }).property;
  const cfg = key ? PROPERTIES[key] : undefined;
  if (!cfg) throw new AdapterError('parse_failed', `노드 ${node.id} 의 숙소 설정을 찾을 수 없습니다.`);
  return cfg;
}

// ─────────────────────────────────────────────────────────────────────────────
// API 호출
// ─────────────────────────────────────────────────────────────────────────────

type Envelope<T> = { code: number; message: string | null; data: T };

/** 컨텍스트별로 알아낸 회원·고객 번호와 CSRF 토큰 */
type SessionInfo = { memNo: string; guestNo: string; csrfHeader: string; csrfToken: string };
const ids = new WeakMap<BrowserContext, SessionInfo>();

/**
 * 화면이 보내는 헤더를 그대로 맞춘다.
 * `x-requested-with` 가 없거나 referer 가 다르면 **403** 이 돌아온다 (2026-09-02 확인).
 */
function ajaxHeaders(referer: string, info?: SessionInfo): Record<string, string> {
  return {
    accept: 'application/json, text/javascript, */*; q=0.01',
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    ...(info ? { [info.csrfHeader]: info.csrfToken } : {}),
    referer,
  };
}

/** 숙소별 예약 화면 주소. referer 로 쓴다. */
const propertyPageUrl = (path: string) => `${BASE}/ko/reservation/${path}/room-search`;

async function call<T>(ctx: BrowserContext, apiPath: string, data: unknown, referer = RESERVE_URL): Promise<T> {
  let res;
  try {
    res = await ctx.request.fetch(`${BASE}${apiPath}`, {
      method: 'POST',
      headers: ajaxHeaders(referer, ids.get(ctx)),
      data,
      timeout: 20_000,
    });
  } catch (e) {
    throw new AdapterError('timeout', `${apiPath} 응답이 없습니다.`, (e as Error).message);
  }
  if (res.status() === 401 || res.status() === 403) {
    throw new AdapterError('auth_failed', `${apiPath} 인증 실패 (HTTP ${res.status()})`);
  }
  if (res.status() >= 500) {
    const text = await res.text().catch(() => '');
    throw new AdapterError(MAINTENANCE_HINT.test(text) ? 'maintenance' : 'parse_failed', `${apiPath} HTTP ${res.status()}`);
  }
  if (!res.ok()) throw new AdapterError('parse_failed', `${apiPath} HTTP ${res.status()}`);

  let json: Envelope<T>;
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    // 로그인이 풀리면 JSON 대신 로그인 페이지 HTML 이 온다.
    throw new AdapterError('auth_failed', `${apiPath} 응답이 JSON 이 아닙니다. 세션이 끊겼을 수 있습니다.`);
  }
  if (json.code !== 200) {
    throw new AdapterError('parse_failed', `${apiPath} code=${json.code} ${json.message ?? ''}`);
  }
  return json.data;
}

/** 로그인 상태 확인. 비로그인이면 로그인 페이지로 302 된다. */
async function probe(ctx: BrowserContext): Promise<boolean> {
  try {
    const res = await ctx.request.fetch(PROBE_URL, { maxRedirects: 0, timeout: 15_000 });
    return res.status() === 200;
  } catch {
    return false;
  }
}

async function guardAbnormal(page: Page): Promise<void> {
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) ?? '').catch(() => '');
  if (BLOCKED_HINT.test(text)) throw new AdapterError('blocked', '차단 화면이 감지됐습니다.');
  if (MAINTENANCE_HINT.test(text)) throw new AdapterError('maintenance', '사이트 점검 중입니다.');
}

/**
 * 회원번호·고객번호를 알아낸다.
 * 화면이 예약 API 를 부를 때 함께 보내므로, 그 요청을 엿보아 가져온다.
 */
async function resolveIds(ctx: BrowserContext): Promise<SessionInfo> {
  const cached = ids.get(ctx);
  if (cached) return cached;

  const page = await ctx.newPage();
  const found: { memNo?: string; guestNo?: string } = {};
  page.on('request', (req) => {
    if (!req.url().includes('ananti.kr')) return;
    const body = req.postData() ?? '';
    const url = req.url();
    const m1 = /"memNo"\s*:\s*"([^"]+)"/.exec(body) ?? /[?&]memNo=([^&]+)/.exec(url);
    const m2 = /"guestNo"\s*:\s*"([^"]+)"/.exec(body) ?? /[?&]guestNo=([^&]+)/.exec(url);
    if (m1?.[1] && !found.memNo) found.memNo = decodeURIComponent(m1[1]);
    if (m2?.[1] && !found.guestNo) found.guestNo = decodeURIComponent(m2[1]);
  });

  /**
   * CSRF 토큰은 페이지의 <meta name="_csrf"> 에 있고, 보낼 헤더 이름은 <meta name="_csrf_header"> 에 있다.
   * 이 헤더가 없으면 예약 API 가 403 을 돌려준다 (2026-09-02 확인).
   */
  let csrf: { header: string; token: string } | null = null;
  try {
    await page.goto(`${BASE}/ko/reservation/village/room-search`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    csrf = await page.evaluate(() => ({
      header: document.querySelector('meta[name="_csrf_header"]')?.getAttribute('content') ?? '',
      token: document.querySelector('meta[name="_csrf"]')?.getAttribute('content') ?? '',
    })).catch((e) => {
      console.warn('  [아난티] CSRF 토큰을 읽지 못했습니다:', (e as Error).message);
      return null;
    });
    for (let i = 0; i < 12; i++) {
      if (found.memNo && found.guestNo) break;
      await sleep(700);
    }
  } finally {
    await page.close().catch(() => {});
  }

  if (!found.memNo || !found.guestNo) {
    throw new AdapterError('parse_failed', '회원번호·고객번호를 찾지 못했습니다. 화면 구조가 바뀌었을 수 있습니다.');
  }
  if (!csrf?.token) {
    throw new AdapterError('parse_failed', 'CSRF 토큰을 찾지 못했습니다. 이게 없으면 조회가 403 이 됩니다.');
  }
  const value: SessionInfo = {
    memNo: found.memNo, guestNo: found.guestNo,
    csrfHeader: (csrf.header || 'X-CSRF-TOKEN').toLowerCase(),
    csrfToken: csrf.token,
  };
  ids.set(ctx, value);
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// 응답 해석 — 숙소마다 필드 이름이 다르다
// ─────────────────────────────────────────────────────────────────────────────

type AnyRow = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** 달력 한 줄: 소문자(cdDt/rrYn)든 대문자(RESERVE_DATE/RESERVE_YN)든 받는다 */
function readCalendarRow(r: AnyRow): { date: string; open: boolean } | null {
  const date = str(r.cdDt || r.RESERVE_DATE).replace(/-/g, '');
  if (!/^\d{8}$/.test(date)) return null;
  const yn = str(r.rrYn || r.RESERVE_YN).toUpperCase();
  return { date, open: yn === 'Y' };
}

/** 객실 한 줄 */
function readRoomRow(r: AnyRow, shape: 'lower' | 'upper') {
  if (shape === 'upper') {
    return {
      code: str(r.RESERVE_RTYPE),
      name: str(r.RTYPE_NAME),
      sub: str(r.VIEWTYPE),
      capacity: num(r.RESERVE_PCNT),
      bookable: str(r.RESERVE_YN).toUpperCase() === 'Y',
      total: num(r.RESERVE_PRICE),
      minPrice: num(r.RESERVE_PRICE_MIN),
      remaining: num(r.RM_TOT),
      rateDesc: str(r.RMDESC),
      reason: '',
    };
  }
  return {
    code: str(r.rmType),
    name: str(r.rmKorDesc || r.rmDesc),
    sub: str(r.bedType),
    capacity: num(r.gst),
    bookable: str(r.rsvnYn).toUpperCase() === 'Y',
    total: num(r.rate),
    minPrice: num(r.minPrice),
    remaining: null,
    rateDesc: str(r.rateDesc).trim(),
    reason: str(r.rsvnReason),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 어댑터
// ─────────────────────────────────────────────────────────────────────────────

export const ananttiAdapter: ResortAdapter = {
  id: 'anantti',

  async sessionAlive(ctx) {
    return probe(ctx);
  },

  async ensureSession(ctx) {
    if (await probe(ctx)) return;

    // 못 쓰는 세션 쿠키는 먼저 버린다
    await ctx.clearCookies();
    ids.delete(ctx);

    const page = await ctx.newPage();
    try {
      const { id, pw } = await getCredentials('anantti');

      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await guardAbnormal(page);
      await sleep(1000 + Math.random() * 2000);   // 사람 속도 (CLAUDE.md §7.4)

      const idBox = page.locator(SEL.loginId);
      const pwBox = page.locator(SEL.loginPw);
      await idBox.waitFor({ state: 'visible', timeout: 20_000 });
      await claimLoginSlot('anantti');   // 폼을 확인한 뒤에 횟수를 차감한다
      await idBox.click();
      await idBox.pressSequentially(id, { delay: 40 });
      await jitter();
      await pwBox.click();
      await pwBox.pressSequentially(pw, { delay: 40 });
      await jitter();
      await page.locator(SEL.loginSubmit).first().click();

      await page.waitForURL((u) => !u.host.startsWith('me.'), { timeout: 30_000 }).catch(() => {});
      await sleep(2500);
      await guardAbnormal(page);

      if (!(await probe(ctx))) {
        throw new AdapterError('auth_failed', '로그인했지만 세션을 확인하지 못했습니다.');
      }
      await saveStorageState('anantti', ctx);
    } finally {
      await page.close().catch(() => {});
    }
  },

  /**
   * 달력. 아난티는 **날짜별 잔여를 주지 않는다**.
   * `open` = 예약이 오픈된 날(눌러서 확인), 그 밖의 날은 아예 넣지 않는다.
   */
  async getCalendar(ctx, node, yyyyMM): Promise<CalendarResult> {
    const cfg = propertyOf(node);
    const { memNo, guestNo } = await resolveIds(ctx);

    const rows = await call<AnyRow[]>(ctx, `/reservation/${cfg.path}/ajax/init-calendar`, {
      bsns: cfg.bsns, golfId: GOLF_ID, date: `${yyyyMM}01`,
      memNo, guestNo, rate: '', type: RSVN_TYPE, rsvnType: RSVN_TYPE,
    }, propertyPageUrl(cfg.path));

    const days: Record<string, DayStatus> = {};
    let seen = 0;
    for (const raw of rows ?? []) {
      const row = readCalendarRow(raw);
      if (!row || !row.date.startsWith(yyyyMM)) continue;
      seen++;
      if (row.open) days[dashed(row.date)] = 'open';
    }
    if (seen === 0) throw new AdapterError('parse_failed', `${yyyyMM} 달력에 날짜가 하나도 없습니다.`);

    return { days, fetchedAt: new Date() };
  },

  async getDetail(ctx, node, checkin, nights): Promise<DetailResult> {
    const cfg = propertyOf(node);
    const { memNo, guestNo } = await resolveIds(ctx);
    const frDate = compact(checkin);
    const toDate = addDays(frDate, nights);

    const rows = await call<AnyRow[]>(ctx, `/reservation/${cfg.path}/ajax/${cfg.roomApi}`, {
      bsns: cfg.bsns, memNo, guestNo,
      frDate, toDate, nig: String(nights),
      rsvnType: RSVN_TYPE, type: RSVN_TYPE,
    }, propertyPageUrl(cfg.path));

    const rooms: DetailRoom[] = [];
    for (const raw of rows ?? []) {
      const r = readRoomRow(raw, cfg.shape);
      if (!r.code && !r.name) continue;

      const status: RoomStatus = r.bookable ? 'available' : 'full';
      const path = [r.name, r.sub].map((v) => v.trim()).filter(Boolean);

      rooms.push({
        roomId: `anantti-${cfg.path}-${r.code}`,
        path: path.length ? path : [r.name || r.code],
        name: r.name || r.code,
        status,
        waitCount: null,
        availableNights: [],
        // 아난티는 기간 합계만 준다. 날짜별 내역이 없으므로 perNight 는 비운다.
        total: r.bookable ? r.total : null,
        perNight: [],
        siteRef: {
          bsns: cfg.bsns, property: cfg.path, rmType: r.code,
          capacity: r.capacity, remaining: r.remaining,
          minPrice: r.minPrice, rateDesc: r.rateDesc || null, reason: r.reason || null,
        },
      });
    }

    // 빈 목록은 오류가 아니다. 예약 오픈 기간 밖이거나 그날 배정된 객실이 없으면 정상적으로 비어 온다.
    // (응답 자체가 배열이 아니면 위 call() 이 parse_failed 로 걸러 준다)
    return { buildings: [], rooms, fetchedAt: new Date() };
  },

  // 아난티는 한 숙소 안에 '동' 개념이 없다. getBuildingSummary 는 구현하지 않는다.
};
