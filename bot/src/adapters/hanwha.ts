/**
 * 한화리조트 어댑터 (CLAUDE.md §7.1)
 *
 * 근거와 응답 구조는 docs/hanwha-site-notes.md 에 정리돼 있다.
 *
 * 소노·아난티와 다른 점:
 *  1. 엔드포인트가 사실상 하나다 (`/rst/cmn/doExecute.mvc`). 무엇을 조회할지는 본문의 INTF_ID 가 정한다.
 *  2. 로그인이 3단계다 (아이디/비밀번호 → 회원권 비밀번호 → 완료).
 *  3. 달력 한 번 호출로 날짜 × 객실타입 상태·잔여수·대기가 전부 온다.
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
  type PerNight,
  type ResortAdapter,
  type RoomStatus,
} from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 상수 — 사이트가 바뀌면 이 블록만 고친다
// ─────────────────────────────────────────────────────────────────────────────

const MAIN = 'https://www.hanwharesort.co.kr';
const BOOKING = 'https://booking.hanwharesort.co.kr';

const LOGIN_URL = `${MAIN}/irsweb/resort3/member/login.do`;
const STEP2_MARK = 'login_membership_password';
const RESERVE_URL = `${BOOKING}/rst/rrs/0010/serviceM00.mvc`;
/** 로그인 여부 확인용. 로그인 상태에서만 정상 응답한다. */
const SESSION_CHECK = `${MAIN}/irsweb/resort3/sessionCheck.do`;
const EXECUTE = `${BOOKING}/rst/cmn/doExecute.mvc`;

const SEL = {
  loginId: '#id',
  loginPw: '#pwd',
  loginSubmit: '#btnLogin',
  memberPw: '#membership_password',
};

/** 기능별 INTF_ID (docs/hanwha-site-notes.md §3~5) */
const INTF = {
  places: 'TFO00HBSITSCTM0160',   // 숙소 목록
  calendar: 'TFO00HBSREMPRR0113', // 날짜 × 객실타입 상태·잔여
  rooms: 'TFO00HBSREMPRR0119',    // 객실 카탈로그 (상품번호·정원) — 요금 조회에 필요
  price: 'TFO00HBSREMPRR2001',    // 요금
};

/** 화면이 늘 보내는 고정값들. 하나라도 빠지면 "캘린더구분 코드가 없습니다" 같은 오류가 난다. */
const CORP_CD = '1000';              // TODO(verify) 법인 코드
const MEMB_DIV_CD = '01';            // TODO(verify) 회원 구분
const RSRV_CLDR_CL_CD = '01';        // 캘린더 구분 — 필수
const RSRV_RCEPT_DIV_CD = '2';       // 예약 접수 구분
const CORP_CUST_YN = 'N';            // 법인 고객 여부

/**
 * 상태 문구 → 우리 코드. 모르는 문구는 추측하지 않고 unknown 으로 둔다.
 * (docs/hanwha-site-notes.md §4)
 */
const STATUS_BY_MSG: Array<[RegExp, RoomStatus]> = [
  [/^예약가능/, 'available'],
  [/대기예약/, 'waitlist'],
  [/예약불가/, 'full'],
  [/^마감/, 'full'],
];

/** 남은 객실이 이 수 이하면 '마감임박' 으로 본다. */
const CLOSING_THRESHOLD = 3;

/** 요금 조회 동시 실행 수 */
const PRICE_CONCURRENCY = 4;

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
const lastDayOf = (yyyyMM: string) =>
  `${yyyyMM}${pad(new Date(Number(yyyyMM.slice(0, 4)), Number(yyyyMM.slice(4, 6)), 0).getDate())}`;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

type SiteRef = { brchCd?: string; locCd?: string };
function refOf(node: Node): { brchCd: string; locCd: string } {
  const r = node.siteRef as SiteRef;
  if (!r?.brchCd || !r?.locCd) throw new AdapterError('parse_failed', `노드 ${node.id} 에 BRCH_CD/LOC_CD 가 없습니다.`);
  return { brchCd: r.brchCd, locCd: r.locCd };
}

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

type AnyRow = Record<string, unknown>;
type ExecuteResponse = {
  ds?: {
    Data?: Record<string, AnyRow[]>;
    MessageHeader?: { MSG_PRCS_RSLT_CD?: string; MSG_DATA_SUB?: Array<{ MSG_CTNS?: string }> };
  };
};

/** 컨텍스트별로 알아낸 고객 정보. 요금 조회가 이 값들을 전부 요구한다. */
type Who = { custNo: string; membNo: string; inhsCustNm: string; cyberId: string };
const ids = new WeakMap<BrowserContext, Who>();

/**
 * 한화 API 는 엔드포인트가 하나다. 무엇을 조회할지는 INTF_ID 로 정하고,
 * 본문은 `ds=<JSON>` 형태의 urlencoded 로 보낸다.
 */
async function execute(
  ctx: BrowserContext,
  intfId: string,
  payload: Record<string, AnyRow[]>,
): Promise<Record<string, AnyRow[]>> {
  const recvSvcCd = intfId.replace(/^TFO00/, '');
  const body = { ...payload, serviceInfo: { INTF_ID: intfId, RECV_SVC_CD: recvSvcCd } };

  let res;
  try {
    res = await ctx.request.fetch(EXECUTE, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        referer: RESERVE_URL,
      },
      data: `ds=${encodeURIComponent(JSON.stringify(body))}`,
      timeout: 25_000,
    });
  } catch (e) {
    throw new AdapterError('timeout', `${intfId} 응답이 없습니다.`, (e as Error).message);
  }

  if (res.status() === 401 || res.status() === 403) {
    throw new AdapterError('auth_failed', `${intfId} 인증 실패 (HTTP ${res.status()})`);
  }
  if (res.status() >= 500) {
    const text = await res.text().catch(() => '');
    throw new AdapterError(MAINTENANCE_HINT.test(text) ? 'maintenance' : 'parse_failed', `${intfId} HTTP ${res.status()}`);
  }
  if (!res.ok()) throw new AdapterError('parse_failed', `${intfId} HTTP ${res.status()}`);

  let json: ExecuteResponse;
  try {
    json = (await res.json()) as ExecuteResponse;
  } catch {
    // 세션이 끊기면 JSON 대신 로그인 페이지 HTML 이 온다.
    throw new AdapterError('auth_failed', `${intfId} 응답이 JSON 이 아닙니다. 세션이 끊겼을 수 있습니다.`);
  }

  const code = json.ds?.MessageHeader?.MSG_PRCS_RSLT_CD;
  if (code && code !== '0') {
    const msg = json.ds?.MessageHeader?.MSG_DATA_SUB?.[0]?.MSG_CTNS ?? '';
    throw new AdapterError('parse_failed', `${intfId} 처리 실패 (${code}) ${msg}`);
  }
  return json.ds?.Data ?? {};
}

async function probe(ctx: BrowserContext): Promise<boolean> {
  try {
    const res = await ctx.request.fetch(SESSION_CHECK, {
      method: 'POST',
      headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest', referer: MAIN },
      timeout: 15_000,
    });
    if (!res.ok()) return false;
    const text = await res.text();
    // 비로그인이면 로그인 페이지 HTML 이 돌아온다.
    return !/login\.do|<html/i.test(text);
  } catch {
    return false;
  }
}

async function guardAbnormal(page: Page): Promise<void> {
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) ?? '').catch(() => '');
  if (BLOCKED_HINT.test(text)) throw new AdapterError('blocked', '차단 화면이 감지됐습니다.');
  if (MAINTENANCE_HINT.test(text)) throw new AdapterError('maintenance', '사이트 점검 중입니다.');
}

/** 고객번호·회원번호는 예약 화면이 API 에 실어 보낸다. 그 요청을 엿보아 가져온다. */
async function resolveIds(ctx: BrowserContext): Promise<Who> {
  const cached = ids.get(ctx);
  if (cached) return cached;

  const page = await ctx.newPage();
  const found: Partial<Who> = {};
  page.on('request', (req) => {
    const body = req.postData() ?? '';
    if (!body.includes('CUST_NO')) return;
    const decoded = decodeURIComponent(body);
    const pick = (key: string) => new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(decoded)?.[1];
    if (!found.custNo) found.custNo = pick('CUST_NO');
    if (!found.membNo) found.membNo = pick('MEMB_NO');
    if (!found.inhsCustNm) found.inhsCustNm = pick('INHS_CUST_NM');
    if (!found.cyberId) found.cyberId = pick('CYBER_ID');
  });

  try {
    await page.goto(RESERVE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // 꼭 필요한 건 고객번호다. 회원번호는 있으면 좋지만 안 올 수도 있으므로 오래 기다리지 않는다.
    for (let i = 0; i < 15; i++) {
      if (found.custNo && found.membNo) break;
      if (found.custNo && i >= 4) break;      // 고객번호만 얻었으면 약 3초까지만 더 본다
      await sleep(700);
    }
  } finally {
    await page.close().catch(() => {});
  }

  if (!found.custNo) {
    throw new AdapterError('parse_failed', '고객번호를 찾지 못했습니다. 화면 구조가 바뀌었을 수 있습니다.');
  }
  const value: Who = {
    custNo: found.custNo,
    membNo: found.membNo ?? '',
    inhsCustNm: found.inhsCustNm ?? '',
    cyberId: found.cyberId ?? '',
  };
  ids.set(ctx, value);
  return value;
}

/** 객실 카탈로그. 요금 조회에 필요한 상품번호와 접수타입, 그리고 정원을 준다. */
type RoomInfo = { roomTypeCd: string; roomTypeNm: string; goodsNo: string; receiptTypeCd: string; capacity: number | null };

async function fetchRoomCatalog(
  ctx: BrowserContext, node: Node, arrvDate: string,
): Promise<Map<string, RoomInfo>> {
  const { brchCd, locCd } = refOf(node);
  const { custNo } = await resolveIds(ctx);
  const today = compact(new Date().toISOString().slice(0, 10));
  const data = await execute(ctx, INTF.rooms, {
    ds_search: [{
      CORP_CD, BRCH_CD: brchCd, LOC_CD: locCd,
      BSN_DATE: today, CUST_NO: custNo, ARRV_DATE: arrvDate,
      RSRV_RCEPT_DIV_CD,
    }],
  });
  const map = new Map<string, RoomInfo>();
  for (const r of data.ds_result ?? []) {
    const code = String(r.ROOM_TYPE_CD ?? '');
    if (!code) continue;
    map.set(code, {
      roomTypeCd: code,
      roomTypeNm: String(r.ROOM_TYPE_NM ?? code),
      goodsNo: String(r.ROOM_GOODS_NO ?? ''),
      receiptTypeCd: String(r.REPR_ROOM_TYPE_CD ?? code),
      capacity: num(r.STDR_PRSN_CNT),
    });
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// 응답 해석
// ─────────────────────────────────────────────────────────────────────────────

const unknownMsgs = new Set<string>();

function mapStatus(msg: string, posblYn: string, remaining: number | null): RoomStatus {
  for (const [re, status] of STATUS_BY_MSG) {
    if (re.test(msg)) {
      if (status === 'available' && remaining !== null && remaining <= CLOSING_THRESHOLD) return 'closing';
      return status;
    }
  }
  // 문구가 처음 보는 것이면 Y/N 이라도 살린다. 다만 로그에 남긴다.
  if (!unknownMsgs.has(msg)) {
    unknownMsgs.add(msg);
    console.warn(`  [한화] 처음 보는 상태 문구입니다: "${msg}" (RSRV_POSBL_YN=${posblYn})`);
  }
  if (posblYn === 'Y') return remaining !== null && remaining <= CLOSING_THRESHOLD ? 'closing' : 'available';
  return 'unknown';
}

/** 하루치 여러 객실의 상태를 한 칸으로 합친다. 가장 예약하기 쉬운 상태가 이긴다. */
const DAY_PRIORITY: DayStatus[] = ['available', 'closing', 'waitlist', 'full', 'unknown'];
function mergeDay(statuses: RoomStatus[]): DayStatus {
  for (const s of DAY_PRIORITY) if (statuses.includes(s)) return s;
  return 'unknown';
}

type CalRow = {
  date: string; roomTypeCd: string; roomTypeNm: string;
  status: RoomStatus; remaining: number | null; waitSeq: number | null; seasonNm: string;
};

function readCalendarRows(rows: AnyRow[]): CalRow[] {
  const out: CalRow[] = [];
  for (const r of rows ?? []) {
    const date = String(r.SESN_DATE ?? '').replace(/-/g, '');
    if (!/^\d{8}$/.test(date)) continue;
    const remaining = num(r.RSRV_POSBL_CNT);
    out.push({
      date,
      roomTypeCd: String(r.ROOM_TYPE_CD ?? ''),
      roomTypeNm: String(r.ROOM_TYPE_NM ?? r.ROOM_TYPE_CD ?? ''),
      status: mapStatus(String(r.MSG ?? ''), String(r.RSRV_POSBL_YN ?? ''), remaining),
      remaining,
      waitSeq: num(r.WAIT_SEQ),
      seasonNm: String(r.SESN_NM ?? ''),
    });
  }
  return out;
}

async function fetchCalendarRows(
  ctx: BrowserContext, node: Node, fromYmd: string, toYmd: string,
): Promise<CalRow[]> {
  const { brchCd, locCd } = refOf(node);
  const { custNo, membNo } = await resolveIds(ctx);
  void membNo;   // 이 조회에서는 화면도 MEMB_NO 를 비워서 보낸다
  const data = await execute(ctx, INTF.calendar, {
    ds_search: [{
      CORP_CD, BRCH_CD: brchCd, LOC_CD: locCd,
      CUST_NO: custNo, MEMB_DIV_CD,
      MEMB_MAST_NO: '', CONT_NO: '', MEMB_NO: '', CUST_IDNT_NO: '', RSRV_LOC_CD: '',
      WAIT_RSRV_YN: 'N', WAIT_RSRV_NO: '', OB_YN: 'N',
      STRT_DATE: fromYmd, END_DATE: toYmd,
      RSRV_CLDR_CL_CD, RSRV_RCEPT_DIV_CD, RSRV_ROOM_CNT: '1', CORP_CUST_YN,
    }],
  });
  return readCalendarRows(data.ds_result ?? []);
}

// ─────────────────────────────────────────────────────────────────────────────
// 어댑터
// ─────────────────────────────────────────────────────────────────────────────

export const hanwhaAdapter: ResortAdapter = {
  id: 'hanwha',

  async sessionAlive(ctx) {
    return probe(ctx);
  },

  async ensureSession(ctx) {
    if (await probe(ctx)) return;

    /**
     * 여기까지 왔다는 건 저장된 세션이 못 쓴다는 뜻이다.
     * 그 쿠키를 남겨 두면 사이트가 로그인 페이지 대신 오류 페이지를 돌려준다(2026-09-02 확인).
     * 새로 로그인하기 전에 반드시 지운다.
     */
    await ctx.clearCookies();
    ids.delete(ctx);

    const page = await ctx.newPage();
    try {
      const { id, pw, extra } = await getCredentials('hanwha');
      if (!extra) throw new AdapterError('auth_failed', '회원권 비밀번호가 필요합니다.');

      // ① 아이디 · 비밀번호
      //    예약 화면으로 들어가면 returnUrl 이 붙은 로그인 페이지로 보내 준다.
      //    이 경로라야 입력 폼이 확실히 렌더링된다 (login.do 를 직접 열면 안내 링크만 나올 때가 있다).
      await page.goto(RESERVE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await guardAbnormal(page);
      await sleep(1000 + Math.random() * 2000);   // 사람 속도 (CLAUDE.md §7.4)

      const idBox = page.locator(SEL.loginId);
      const pwBox = page.locator(SEL.loginPw);
      try {
        await idBox.waitFor({ state: 'visible', timeout: 20_000 });
      } catch {
        // 폼이 안 보이면 로그인 페이지를 직접 열어 한 번 더 시도한다.
        console.warn(`  [한화] 로그인 폼이 보이지 않습니다. 현재 주소: ${page.url()}`);
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await idBox.waitFor({ state: 'visible', timeout: 20_000 }).catch(async () => {
          // 무엇을 받았는지 남긴다. 계정 정보는 찍지 않는다.
          const seen = await page.evaluate(() => ({
            title: document.title,
            text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300),
            html: document.documentElement.innerHTML.length,
          })).catch(() => ({ title: '(읽기 실패)', text: '', html: 0 }));
          console.warn(`  [한화] 받은 화면: 제목="${seen.title}" 길이=${seen.html} 본문="${seen.text}"`);
          // 공개 페이지이므로 내용을 남겨 원인을 가린다 (차단 안내인지, 자바스크립트 이동인지)
          const raw = await page.content().catch(() => '');
          console.warn(`  [한화] HTML: ${raw.replace(/\s+/g, ' ').slice(0, 700)}`);
          throw new AdapterError('parse_failed',
            `로그인 폼을 찾지 못했습니다 (${page.url()}). 화면 구조가 바뀌었을 수 있습니다.`);
        });
      }

      // 여기까지 왔으면 실제로 로그인을 시도한다. 이제야 횟수를 차감한다.
      await claimLoginSlot('hanwha');
      await idBox.click();
      await idBox.pressSequentially(id, { delay: 40 });
      await jitter();
      await pwBox.click();
      await pwBox.pressSequentially(pw, { delay: 40 });
      await jitter();
      await page.locator(SEL.loginSubmit).first().click();

      // ② 회원권 비밀번호
      await page.waitForURL((u) => u.href.includes(STEP2_MARK), { timeout: 30_000 }).catch(() => {});
      await guardAbnormal(page);
      if (page.url().includes(STEP2_MARK)) {
        const memberBox = page.locator(SEL.memberPw);
        await memberBox.waitFor({ state: 'visible', timeout: 20_000 });
        await memberBox.click();
        await memberBox.pressSequentially(extra, { delay: 40 });
        await jitter();
        await memberBox.press('Enter');
        await sleep(2000);
        // Enter 로 넘어가지 않으면 폼을 직접 제출한다 (확인 버튼이 JS 로 동작한다)
        if (page.url().includes(STEP2_MARK)) {
          await page.evaluate(() => {
            const f = document.forms.namedItem('mainForm');
            if (f) f.submit();
          }).catch(() => {});
          await sleep(2500);
        }
      }

      await sleep(1500);
      await guardAbnormal(page);
      if (!(await probe(ctx))) {
        throw new AdapterError('auth_failed', '로그인했지만 세션을 확인하지 못했습니다. 회원권 비밀번호를 확인하세요.');
      }
      await saveStorageState('hanwha', ctx);
    } finally {
      await page.close().catch(() => {});
    }
  },

  async getCalendar(ctx, node, yyyyMM): Promise<CalendarResult> {
    const today = compact(new Date().toISOString().slice(0, 10));
    const first = `${yyyyMM}01`;
    const rows = await fetchCalendarRows(ctx, node, first < today ? today : first, lastDayOf(yyyyMM));

    const byDate = new Map<string, RoomStatus[]>();
    for (const r of rows) {
      if (!r.date.startsWith(yyyyMM)) continue;
      const list = byDate.get(r.date) ?? [];
      list.push(r.status);
      byDate.set(r.date, list);
    }
    if (byDate.size === 0) throw new AdapterError('parse_failed', `${yyyyMM} 달력에 날짜가 하나도 없습니다.`);

    const days: Record<string, DayStatus> = {};
    for (const [ymd, statuses] of byDate) days[dashed(ymd)] = mergeDay(statuses);
    return { days, fetchedAt: new Date() };
  },

  async getDetail(ctx, node, checkin, nights): Promise<DetailResult> {
    const { brchCd, locCd } = refOf(node);
    const who = await resolveIds(ctx);
    const ciYmd = compact(checkin);
    const coYmd = addDays(ciYmd, nights);
    const stayDates = Array.from({ length: nights }, (_, i) => addDays(ciYmd, i));

    // 달력으로 묵는 날 전체의 객실별 상태를, 카탈로그로 상품번호·정원을 얻는다.
    const [rows, catalog] = await Promise.all([
      fetchCalendarRows(ctx, node, ciYmd, addDays(ciYmd, nights - 1)),
      fetchRoomCatalog(ctx, node, ciYmd).catch(() => new Map<string, RoomInfo>()),
    ]);

    const byType = new Map<string, CalRow[]>();
    for (const r of rows) {
      if (!stayDates.includes(r.date)) continue;
      const list = byType.get(r.roomTypeCd) ?? [];
      list.push(r);
      byType.set(r.roomTypeCd, list);
    }
    if (byType.size === 0) return { buildings: [], rooms: [], fetchedAt: new Date() };

    const entries = [...byType.entries()];
    const rooms = await pool(entries, PRICE_CONCURRENCY, async ([roomTypeCd, list]): Promise<DetailRoom> => {
      const info = catalog.get(roomTypeCd);
      const name = info?.roomTypeNm || list[0]?.roomTypeNm || roomTypeCd;

      // 묵는 날 전부 예약 가능해야 연박이 된다.
      const bookableDays = list.filter((r) => r.status === 'available' || r.status === 'closing');
      const allDays = bookableDays.length === nights && list.length === nights;
      const anyWait = list.some((r) => r.status === 'waitlist');

      let status: RoomStatus;
      if (allDays) status = list.some((r) => r.status === 'closing') ? 'closing' : 'available';
      else if (bookableDays.length > 0) status = 'partial';
      else if (anyWait) status = 'waitlist';
      else status = 'full';

      const remaining = list.length ? Math.min(...list.map((r) => r.remaining ?? 0)) : null;
      const waitSeq = list.map((r) => r.waitSeq ?? 0).find((v) => v > 0) ?? null;

      let total: number | null = null;
      let perNight: PerNight[] = [];
      if (status !== 'full') {
        // 실제로 예약 가능한 기간으로 요금을 묻는다 (연박이 안 되면 그 부분만).
        const from = allDays ? ciYmd : bookableDays[0]?.date;
        const count = allDays ? nights : bookableDays.length;
        if (from && count > 0) {
          await jitter();
          const priced = await fetchPrice(ctx, {
            brchCd, locCd, who, roomTypeCd,
            goodsNo: info?.goodsNo ?? '', receiptTypeCd: info?.receiptTypeCd ?? roomTypeCd,
            arrvDate: from, chkoutDate: addDays(from, count), nights: count,
          });
          total = priced.total;
          perNight = priced.perNight;
        }
      }

      return {
        roomId: `hanwha-${locCd}-${roomTypeCd}`,
        path: [name],
        name,
        status,
        waitCount: waitSeq,
        availableNights: status === 'partial' ? bookableDays.map((r) => dashed(r.date)) : [],
        total,
        perNight,
        siteRef: {
          brchCd, locCd, roomTypeCd,
          capacity: info?.capacity ?? null,
          remaining: remaining !== null && remaining > 0 ? remaining : null,
          seasonNm: list[0]?.seasonNm || null,
        },
      };
    });

    void coYmd;
    return { buildings: [], rooms, fetchedAt: new Date() };
  },
};

/**
 * 요금 한 건. 합계와 날짜별 내역이 함께 온다 (docs/hanwha-site-notes.md §5)
 *
 * 화면은 데이터셋 4개를 함께 보낸다. 하나라도 빠지면 처리되지 않는다.
 * `_RowType_: "I"` 는 프레임워크가 "새 행" 을 표시하는 값일 뿐, 예약을 만들지 않는다(확인됨).
 */
async function fetchPrice(
  ctx: BrowserContext,
  p: {
    brchCd: string; locCd: string; who: Who; roomTypeCd: string;
    goodsNo: string; receiptTypeCd: string;
    arrvDate: string; chkoutDate: string; nights: number;
  },
): Promise<{ total: number | null; perNight: PerNight[] }> {
  const today = compact(new Date().toISOString().slice(0, 10));
  let data: Record<string, AnyRow[]>;
  try {
    data = await execute(ctx, INTF.price, {
      ds_rsrvMast: [{
        _RowType_: 'I',
        CORP_CD, BRCH_CD: p.brchCd, LOC_CD: p.locCd, RSRV_NO: '',
        CUST_NO: p.who.custNo, MEMB_NO: p.who.membNo, CONT_NO: '', MEMB_MAST_NO: '',
        CUST_IDNT_NO: '', PAKG_NO: '', CPON_NO: '', RECV_SVC_CD: '',
        PYMNT_DIV_CD: '10', STTL_DIV_CD: '10', REQ_PASS_DIV_CD: '', MPASS_DIV_CD: '',
        RSRV_LOC_DIV_CD: '', ROOM_RSRV_STAT_CD: '',
        WAIT_RSRV_YN: 'N', WAIT_RSRV_NO: '',
        INHS_CUST_NM: p.who.inhsCustNm, CYBER_ID: p.who.cyberId,
        ARRV_DATE: p.arrvDate, CHKOT_EXPT_DATE: p.chkoutDate, OVNT_CNT: String(p.nights),
        RSRV_DATE: today, REQER_EMP_NO: '',
        SETLE_YN: 'N', EARLY_BIRD_YN: 'N', CORP_CUST_YN, OTHR_RSRV_YN: '',
      }],
      ds_rsrvRoomList: [{
        _RowType_: 'I',
        ROOM_ROW_ID: '1', BRCH_CD: p.brchCd, LOC_CD: p.locCd,
        ROOM_TYPE_CD: p.roomTypeCd, RCEPT_ROOM_TYPE_CD: p.receiptTypeCd,
        ROOM_GOODS_NO: p.goodsNo, RSRV_ROOM_CNT: '1',
      }],
      ds_adiSvcList: [],
      ds_adiSvcDtlList: [],
    });
  } catch (e) {
    if (e instanceof AdapterError && e.code === 'auth_failed') throw e;
    // 조용히 넘기지 않는다. 왜 금액이 비었는지 로그에 남긴다.
    console.warn(`  [한화] 요금을 받지 못했습니다 (${p.roomTypeCd}): ${(e as Error).message}`);
    return { total: null, perNight: [] };
  }

  const total = num(data.ds_totAmt?.[0]?.TOT_AMT);
  const perNight: PerNight[] = (data.ds_rsrvDrateList ?? [])
    .map((r) => {
      const date = String(r.BSN_DATE ?? '').replace(/-/g, '');
      const base = num(r.STDR_ROOM_RATE) ?? 0;
      const final = num(r.BSN_ROOM_RATE) ?? base;
      return /^\d{8}$/.test(date) ? { date: dashed(date), base, discount: Math.max(0, base - final), final } : null;
    })
    .filter((v): v is PerNight => v !== null);

  if (total !== null && perNight.length) {
    const sum = perNight.reduce((a, n) => a + n.final, 0);
    if (sum !== total) {
      console.warn(`  [한화] 요금 합계가 맞지 않습니다: 날짜별 합 ${sum} vs 합계 ${total} (${p.roomTypeCd})`);
    }
  }
  return { total, perNight };
}
