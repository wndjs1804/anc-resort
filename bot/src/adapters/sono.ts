/**
 * 소노 어댑터 (CLAUDE.md §7.3)
 *
 * 소노는 화면이 REST JSON API 를 부르는 구조라 DOM 을 긁지 않는다.
 * 근거와 응답 구조는 docs/sono-site-notes.md 에 정리돼 있다.
 *
 * 읽기 전용. 예약·취소·대기신청 엔드포인트는 이 파일에 등장하지 않는다.
 */

import type { APIRequestContext, BrowserContext, Page } from 'playwright';

import { claimLoginSlot, saveStorageState } from '../browser.ts';
import { getSonoCredentials } from '../secrets.ts';
import { getChildNodes } from '../store.ts';
import {
  AdapterError,
  type BuildingRemaining,
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

const BASE = 'https://www.sonohotelsresorts.com';
const LOGIN_URL = `${BASE}/member/login`;
const RESERVE_URL = `${BASE}/reserve/room?step=sch`;

const SEL = {
  loginId: '#lginId',
  loginPw: '#lginPw',
  loginSubmit: 'button.btn.xl.fill:has-text("로그인")',
};

const API = {
  userinfo: '/api/hms/user/management/auth/userinfo',
  memberNo: '/api/hms/user/management/member/reserve/representativeMemberNo',
  roomListPc: '/api/hms/user/memberReservation/room/list/pc',
  roomDetail: '/api/hms/user/memberReservation/room/detail',
  detailPrice: '/api/hms/user/memberReservation/room/detail/price',
};

const COMMON_QS = 'lang=ko&deviceType=PC&mobileAppYn=N';

/**
 * 조회 조건 상수.
 * rsvIndCd "9" = 본인(정회원/가족회원) — 2026-09-02 확인 (docs/sono-site-notes.md §4-1).
 * 나머지는 화면이 보내던 값 그대로. TODO(verify) 의미 미확인.
 */
const RSV_IND_CD = '9';
const USER_IND_CD = 'Y';
const RSV_BLCK_CD = '000';

/**
 * 상태 코드 → 우리 코드. 모르는 코드는 절대 추측하지 않고 unknown 으로 두고 로그에 남긴다.
 * (docs/sono-site-notes.md §3, §4)
 */
const STATUS_BY_CODE: Record<string, RoomStatus> = {
  A: 'available',   // 예약원활
  E: 'closing',     // 마감임박
  W: 'waitlist',    // 예약대기
  D: 'full',        // 예약마감
  N: 'full',        // 예약불가 — 2026-09-02 소노벨 A 에서 처음 확인. 예약할 수 없다는 점은 마감과 같다.
  T: 'partial',     // 부분마감 — 연박 상세에만 나온다
};

/** 달력 한 칸을 정할 때의 우선순위. 예약 가능성이 높은 쪽이 이긴다. */
const DAY_PRIORITY: DayStatus[] = ['available', 'closing', 'waitlist', 'full', 'unknown'];

/** 요금 조회 동시 실행 수. 너무 많이 한꺼번에 던지지 않는다. */
const PRICE_CONCURRENCY = 4;

/** 점검·차단으로 볼 문구 */
const MAINTENANCE_HINT = /(시스템\s*점검|서비스\s*점검|점검\s*중|일시\s*중단)/;
const BLOCKED_HINT = /(비정상적인 접근|접근이 차단|captcha|자동입력 방지)/i;

// ─────────────────────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(120 + Math.random() * 280);

const pad = (n: number) => String(n).padStart(2, '0');

/** Date → "20260924" */
function toYmd(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** "20260924" → Date (현지시간 자정) */
function fromYmd(s: string): Date {
  return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
}

function addDays(s: string, n: number): string {
  const d = fromYmd(s);
  d.setDate(d.getDate() + n);
  return toYmd(d);
}

/** "20260924" → "2026-09-24" */
const dashed = (s: string): string => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

/** "2026-09-24" → "20260924" (이미 압축형이면 그대로) */
const compact = (s: string): string => s.replace(/-/g, '');

/** 동시 실행 수를 제한해 순서대로 처리한다 */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 지금 실제로 잡을 수 있는 상태인가. 예약대기는 잡은 게 아니므로 제외한다. */
const isBookable = (s: RoomStatus | undefined): boolean => s === 'available' || s === 'closing';

/** 날짜 목록에서 가장 긴 연속 구간을 고른다. ["1002","1004"] 처럼 끊기면 긴 쪽만 남는다. */
function longestRun(dates: string[]): string[] {
  let best: string[] = [];
  let cur: string[] = [];
  for (const d of dates) {
    if (cur.length && addDays(cur[cur.length - 1], 1) !== d) cur = [];
    cur.push(d);
    if (cur.length > best.length) best = [...cur];
  }
  return best;
}

function storeCdOf(node: Node): string {
  const cd = (node.siteRef as { storeCd?: string }).storeCd;
  if (!cd) throw new AdapterError('parse_failed', `노드 ${node.id} 에 storeCd 가 없습니다.`);
  return cd;
}

// ─────────────────────────────────────────────────────────────────────────────
// API 호출
// ─────────────────────────────────────────────────────────────────────────────

type Envelope<T> = { success: boolean; error: unknown; body: T };

/**
 * 컨텍스트별로 물려받은 인증 헤더.
 * 쿠키만으로 되면 비어 있어도 정상이다. 토큰 방식이면 화면이 보내는 헤더를 그대로 쓴다.
 */
const inherited = new WeakMap<BrowserContext, Record<string, string>>();

const BROWSER_OWN_HEADERS = new Set([
  'host', 'connection', 'content-length', 'user-agent', 'accept', 'accept-encoding', 'accept-language',
  'referer', 'origin', 'cookie', 'content-type', 'cache-control', 'pragma', 'dnt', 'te', 'priority',
  'upgrade-insecure-requests', 'if-none-match', 'if-modified-since', 'range',
]);

function watchHeaders(ctx: BrowserContext, page: Page): void {
  page.on('request', (req) => {
    if (!req.url().includes('/api/hms/user/')) return;
    const bag = inherited.get(ctx) ?? {};
    for (const [key, value] of Object.entries(req.headers())) {
      const k = key.toLowerCase();
      if (BROWSER_OWN_HEADERS.has(k) || k.startsWith('sec-') || bag[k]) continue;
      bag[k] = value;
    }
    inherited.set(ctx, bag);
  });
}

async function call<T>(
  ctx: BrowserContext,
  method: 'GET' | 'POST',
  apiPath: string,
  opts: { query?: string; data?: unknown } = {},
): Promise<T> {
  const request: APIRequestContext = ctx.request;
  const url = `${BASE}${apiPath}?${COMMON_QS}${opts.query ? '&' + opts.query : ''}`;
  let res;
  try {
    res = await request.fetch(url, {
      method,
      headers: { accept: 'application/json', referer: RESERVE_URL, ...(inherited.get(ctx) ?? {}) },
      timeout: 20_000,
      ...(opts.data !== undefined ? { data: opts.data } : {}),
    });
  } catch (e) {
    throw new AdapterError('timeout', `${apiPath} 응답이 없습니다.`, (e as Error).message);
  }

  if (res.status() === 401 || res.status() === 403) {
    throw new AdapterError('auth_failed', `${apiPath} 인증 실패 (HTTP ${res.status()})`);
  }
  if (res.status() >= 500) {
    const text = await res.text().catch(() => '');
    throw new AdapterError(
      MAINTENANCE_HINT.test(text) ? 'maintenance' : 'parse_failed',
      `${apiPath} HTTP ${res.status()}`,
    );
  }
  if (!res.ok()) throw new AdapterError('parse_failed', `${apiPath} HTTP ${res.status()}`);

  let json: Envelope<T>;
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    throw new AdapterError('parse_failed', `${apiPath} 응답이 JSON 이 아닙니다.`);
  }
  if (json.success === false) {
    throw new AdapterError('parse_failed', `${apiPath} success=false`, json.error);
  }
  return json.body;
}

// ─────────────────────────────────────────────────────────────────────────────
// 사이트 응답 타입 (확인된 필드만)
// ─────────────────────────────────────────────────────────────────────────────

type CalRow = {
  ciYmd: string;
  rmTypeCd: string;
  rsvStatusCd: string;
  rsvStatusNm: string;
  rsvRmCnt: number;
};
type CalStore = { storeCd: string; storeNm: string; rmTypeList: CalRow[] };

type RmType = {
  rmTypeCd: string; rmTypeNm: string;
  rsvStatusCd: string; rsvStatusNm: string; rsvRmCnt: number;
  waitSeq: number | null;
  partialAvailableDays?: number; partialWaitDays?: number;
  bedNm?: string; cookNm?: string; viewCd?: string; dongNm?: string;
  /** 위탁운영 숙소 전용. 금액이 여기에 바로 들어온다(요금 API 는 400 을 낸다). */
  outsItemCd?: string | null; outsTotAmt?: number | null; outsRmTpCd?: string | null;
};
type ViewGroup = { viewCd: string; viewNm: string; rmTypeList: RmType[] };
type RoomGroup = { resortTypeNm: string; roomTypeNm: string; viewList: ViewGroup[] };

type DayAmt = { stndYmd: string; totAmt: number | null; levelAmt: number | null; dcAmt: number | null };
type PriceBody = { totAmt: number | null; originAmt: number | null; daysAmtInfoList: DayAmt[] | null };

// ─────────────────────────────────────────────────────────────────────────────

const unknownCodes = new Set<string>();

function mapStatus(code: string, name: string): RoomStatus {
  const mapped = STATUS_BY_CODE[code];
  if (mapped) return mapped;
  const key = `${code}:${name}`;
  if (!unknownCodes.has(key)) {
    unknownCodes.add(key);
    console.warn(`  [소노] 처음 보는 상태 코드입니다: ${key} — unknown 으로 둡니다.`);
  }
  return 'unknown';
}

/** 하루치 여러 객실의 상태를 한 칸으로 합친다. 가장 예약하기 쉬운 상태가 이긴다. */
function mergeDay(statuses: RoomStatus[]): DayStatus {
  for (const s of DAY_PRIORITY) {
    if (statuses.includes(s)) return s;
  }
  return 'unknown';
}

let cachedMemNo: string | null = null;

async function memberNo(ctx: BrowserContext): Promise<string> {
  if (cachedMemNo) return cachedMemNo;
  cachedMemNo = await call<string>(ctx, 'GET', API.memberNo);
  return cachedMemNo;
}

/** 달력 원본 행. getCalendar 와 getDetail(연박 부분가능 계산)이 함께 쓴다. */
async function fetchCalendarRows(
  ctx: BrowserContext,
  storeCds: string[],
  ciYmd: string,
): Promise<CalStore[]> {
  const memNo = await memberNo(ctx);
  return call<CalStore[]>(ctx, 'POST', API.roomListPc, {
    data: {
      memNo, userIndCd: USER_IND_CD, rsvIndCd: RSV_IND_CD,
      ciYmd, coYmd: addDays(ciYmd, 1), nights: 1,
      rmCnt: 1, adultCnt: 1, childCnt: 0,
      storeCdList: storeCds, rmTypeCode: '',
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 어댑터
// ─────────────────────────────────────────────────────────────────────────────

export const sonoAdapter: ResortAdapter = {
  id: 'sono',

  async sessionAlive(ctx: BrowserContext): Promise<boolean> {
    return probe(ctx);
  },

  async ensureSession(ctx: BrowserContext): Promise<void> {
    // 1) 복원한 세션이 아직 살아 있는가?
    if (await probe(ctx)) return;

    // 2) 화면을 한 번 열어 본다. 세션은 살아 있는데 인증 헤더만 없을 수 있다.
    const page = await ctx.newPage();
    try {
      watchHeaders(ctx, page);
      await page.goto(RESERVE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await sleep(2500);
      await guardAbnormal(page);
      if (await probe(ctx)) {
        await saveStorageState('sono', ctx);
        return;
      }

      // 3) 그래도 안 되면 로그인한다.
      //    못 쓰는 세션 쿠키는 먼저 버린다 (남겨 두면 사이트가 오류 페이지를 주는 경우가 있다)
      await ctx.clearCookies();
      //    자격을 먼저 확보한 뒤에 횟수를 차감한다. 입력 실패로 시도조차 못 했는데 깎이면 안 된다.
      const { id, pw } = await getSonoCredentials();

      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await guardAbnormal(page);
      await sleep(1000 + Math.random() * 2000);   // 사람 속도 (CLAUDE.md §7.4)

      const idBox = page.locator(SEL.loginId);
      const pwBox = page.locator(SEL.loginPw);
      await idBox.waitFor({ state: 'visible', timeout: 20_000 });
      await claimLoginSlot('sono');   // 폼을 확인한 뒤에 횟수를 차감한다
      await idBox.click();
      await idBox.pressSequentially(id, { delay: 40 });
      await jitter();
      await pwBox.click();
      await pwBox.pressSequentially(pw, { delay: 40 });
      await jitter();

      const submit = page.locator(SEL.loginSubmit).first();
      if (await submit.count()) await submit.click();
      else await pwBox.press('Enter');

      await page.waitForURL((u) => !u.pathname.includes('/member/login'), { timeout: 30_000 }).catch(() => {});
      await sleep(2000);
      await guardAbnormal(page);

      // 화면이 API 를 부르게 해서 인증 헤더를 물려받는다.
      await page.goto(RESERVE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
      await sleep(2500);

      if (!(await probe(ctx))) {
        throw new AdapterError('auth_failed', '로그인했지만 세션을 확인하지 못했습니다.');
      }
      await saveStorageState('sono', ctx);
    } finally {
      await page.close().catch(() => {});
    }
  },

  async getCalendar(ctx, node, yyyyMM): Promise<CalendarResult> {
    const storeCd = storeCdOf(node);
    const rows = await fetchCalendarRows(ctx, [storeCd], monthProbeDate(yyyyMM));

    const byDate = new Map<string, RoomStatus[]>();
    for (const store of rows) {
      for (const r of store.rmTypeList ?? []) {
        if (!r.ciYmd?.startsWith(yyyyMM)) continue;   // 요청한 달만 남긴다
        const list = byDate.get(r.ciYmd) ?? [];
        list.push(mapStatus(r.rsvStatusCd, r.rsvStatusNm));
        byDate.set(r.ciYmd, list);
      }
    }
    if (byDate.size === 0) {
      throw new AdapterError('parse_failed', `${yyyyMM} 달력에 날짜가 하나도 없습니다.`);
    }

    const days: Record<string, DayStatus> = {};
    for (const [ymd, statuses] of byDate) days[dashed(ymd)] = mergeDay(statuses);
    return { days, fetchedAt: new Date() };
  },

  async getDetail(ctx, node, checkin, nights): Promise<DetailResult> {
    const storeCd = storeCdOf(node);
    const ciYmd = compact(checkin);
    const coYmd = addDays(ciYmd, nights);
    const memNo = await memberNo(ctx);

    const groups = await call<RoomGroup[]>(ctx, 'POST', API.roomDetail, {
      data: {
        storeCdList: [storeCd], rsvIndCd: RSV_IND_CD, memNo, actualMemNo: memNo,
        rsvBlckCd: RSV_BLCK_CD, userIndCd: USER_IND_CD,
        ciYmd, coYmd, nights, rmCnt: 1, adultCnt: 1, childCnt: 0,
        // 위탁운영 숙소(파나크 영덕·팔라티움 해운대·경주 감포)는 이 두 값이 있어야
        // 응답의 outsTotAmt(금액)가 채워진다. 없으면 null 로 온다. (2026-09-02 확인)
        outsMemNo: '', outsBrandSeq: -1,
      },
    });

    const flat: Array<{ group: RoomGroup; view: ViewGroup; rt: RmType }> = [];
    for (const g of groups ?? []) for (const v of g.viewList ?? []) for (const rt of v.rmTypeList ?? []) flat.push({ group: g, view: v, rt });

    // 연박 중 일부만 가능한 객실이 있으면, 어느 날이 가능한지 달력에서 알아낸다.
    const stayDates = Array.from({ length: nights }, (_, i) => addDays(ciYmd, i));
    const needsNights = flat.some((f) => mapStatus(f.rt.rsvStatusCd, f.rt.rsvStatusNm) === 'partial');
    const perDate = needsNights ? await calendarByRoomType(ctx, storeCd, stayDates) : null;

    const rooms = await pool(flat, PRICE_CONCURRENCY, async (f): Promise<DetailRoom> => {
      const status = mapStatus(f.rt.rsvStatusCd, f.rt.rsvStatusNm);
      const optionLabel = [f.rt.bedNm, f.rt.cookNm].map((v) => (v ?? '').trim()).filter(Boolean).join(' · ');
      const path = [f.group.resortTypeNm, f.group.roomTypeNm, f.view.viewNm, optionLabel || f.rt.rmTypeNm]
        .map((v) => (v ?? '').trim())
        .filter(Boolean);

      // 연박 중 일부만 가능한 객실은 "실제로 잡을 수 있는 날" 을 먼저 확정한다.
      const availableYmd = status === 'partial' && perDate
        ? longestRun(stayDates.filter((d) => isBookable(perDate.get(`${d}|${f.rt.rmTypeCd}`))))
        : [];

      /**
       * 요금은 실제로 예약 가능한 기간으로 조회한다.
       * 1박만 가능한데 2박 금액을 보여주면 직원이 오해한다.
       * 박수가 바뀌면 1박당 금액도 달라질 수 있으므로, 2박 견적을 잘라 쓰지 않고 다시 묻는다.
       */
      let total: number | null = null;
      let perNight: PerNight[] = [];

      /**
       * 위탁운영 객실은 요금 API 가 "금액계산구분코드는 필수입니다" 로 400 을 낸다.
       * 대신 객실 목록 응답의 outsTotAmt 에 금액이 이미 들어 있으므로 그것을 쓴다.
       * 날짜별 내역은 주지 않는다.
       */
      const outsAmt = f.rt.outsItemCd ? (f.rt.outsTotAmt ?? null) : null;
      const isOuts = Boolean(f.rt.outsItemCd);

      const priceRange = isOuts ? null
        : status === 'full' ? null
        : status === 'partial' ? (availableYmd.length ? { from: availableYmd[0], count: availableYmd.length } : null)
        : { from: ciYmd, count: nights };

      if (isOuts) {
        total = status === 'full' ? null : outsAmt;
      }

      if (priceRange) {
        await jitter();
        const price = await fetchPrice(ctx, {
          memNo, ciYmd: priceRange.from, coYmd: addDays(priceRange.from, priceRange.count),
          storeCd, rmTypeCd: f.rt.rmTypeCd,
        });
        total = price.total;
        perNight = price.perNight;
      }

      return {
        roomId: `sono-${storeCd}-${f.rt.rmTypeCd}`,
        path,
        name: f.rt.rmTypeNm,
        status,
        waitCount: f.rt.waitSeq ?? null,
        availableNights: availableYmd.map(dashed),
        total,
        perNight,
        siteRef: {
          storeCd, rmTypeCd: f.rt.rmTypeCd, viewCd: f.view.viewCd ?? null, dongNm: f.rt.dongNm ?? null,
          outsourced: isOuts || null,
        },
      };
    });

    return { buildings: [], rooms, fetchedAt: new Date() };
  },

  async getBuildingSummary(ctx, propertyNode, checkin, nights): Promise<BuildingRemaining[]> {
    const children = (await getChildNodes(propertyNode.id)).filter((n) => n.bookable);
    if (children.length <= 1) return [];

    const codes = children.map((c) => (c.siteRef as { storeCd?: string }).storeCd).filter((v): v is string => Boolean(v));
    const ciYmd = compact(checkin);
    const stayDates = Array.from({ length: nights }, (_, i) => addDays(ciYmd, i));

    // 동 여러 개를 한 번에 요청해 본다. 되면 호출 1회로 끝난다.
    let stores = await fetchCalendarRows(ctx, codes, ciYmd);
    if (stores.length < codes.length) {
      // 한 번에 하나만 주는 사이트였다. 동마다 따로 부른다.
      const each = await pool(codes, 3, async (cd) => {
        await jitter();
        return fetchCalendarRows(ctx, [cd], ciYmd);
      });
      stores = each.flat();
    }

    const byStore = new Map(stores.map((s) => [s.storeCd, s]));
    const out: BuildingRemaining[] = [];
    for (const child of children) {
      const cd = (child.siteRef as { storeCd?: string }).storeCd;
      const store = cd ? byStore.get(cd) : undefined;
      out.push({ nodeId: child.id, name: child.name, remaining: store ? remainingForStay(store, stayDates) : 0 });
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 내부 도우미
// ─────────────────────────────────────────────────────────────────────────────

/** 로그인 상태 확인. userinfo 가 200 이면 살아 있다 (docs/sono-site-notes.md §1) */
async function probe(ctx: BrowserContext): Promise<boolean> {
  try {
    const res = await ctx.request.fetch(`${BASE}${API.userinfo}?${COMMON_QS}`, {
      headers: { accept: 'application/json', ...(inherited.get(ctx) ?? {}) },
      timeout: 15_000,
    });
    return res.status() === 200;
  } catch {
    return false;
  }
}

/** 점검·차단 화면이면 즉시 중단한다 (CLAUDE.md §7.4) */
async function guardAbnormal(page: Page): Promise<void> {
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) ?? '').catch(() => '');
  if (BLOCKED_HINT.test(text)) throw new AdapterError('blocked', '차단 화면이 감지됐습니다.');
  if (MAINTENANCE_HINT.test(text)) throw new AdapterError('maintenance', '사이트 점검 중입니다.');
}

/** 그 달의 달력을 받기 위한 기준 날짜. 지난 날짜는 사이트가 잘라서 준다. */
function monthProbeDate(yyyyMM: string): string {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}${pad(now.getMonth() + 1)}`;
  return yyyyMM === thisMonth ? toYmd(now) : `${yyyyMM}01`;
}

/**
 * 요금 한 건. 최상위 totAmt 는 최종가, daysAmtInfoList[].totAmt 는 원가다.
 * 이름이 같지만 뜻이 다르다 (docs/sono-site-notes.md §5).
 */
async function fetchPrice(
  ctx: BrowserContext,
  p: { memNo: string; ciYmd: string; coYmd: string; storeCd: string; rmTypeCd: string },
): Promise<{ total: number | null; perNight: PerNight[] }> {
  let body: PriceBody;
  try {
    body = await call<PriceBody>(ctx, 'POST', API.detailPrice, {
      data: {
        memNo: p.memNo, ciYmd: p.ciYmd, coYmd: p.coYmd, rsvBlckCd: RSV_BLCK_CD,
        storeCd: p.storeCd, userIndCd: USER_IND_CD, rsvIndCd: RSV_IND_CD,
        rmTypeCd: p.rmTypeCd, rmCnt: 1, preAftPayYn: 'N',
      },
    });
  } catch (e) {
    if (e instanceof AdapterError && e.code === 'auth_failed') throw e;
    return { total: null, perNight: [] };   // 요금을 못 받는 객실이 있다. 금액만 비운다.
  }

  /**
   * `daysAmtInfoList[].totAmt` 는 **할인이 이미 반영된 금액**이다 (2026-09-02 사용자 확인).
   * 여기서 levelAmt·dcAmt 를 또 빼면 실제보다 싸게 나온다. 빼지 않는다.
   * (levelAmt 는 "이 금액에 등급할인이 얼마나 반영됐는지" 를 알려주는 참고값으로만 쓴다)
   */
  const perNight: PerNight[] = (body.daysAmtInfoList ?? []).map((d) => {
    const amount = d.totAmt ?? 0;
    return { date: dashed(d.stndYmd), base: amount, discount: 0, final: amount };
  });

  // 합계도 날짜별 금액을 더해서 만든다. 최상위 totAmt 는 이보다 낮게 오는 경우가 있다.
  const total = perNight.length
    ? perNight.reduce((a, n) => a + n.final, 0)
    : (body.totAmt ?? null);

  return { total, perNight };
}

/** 숙박 기간에 걸친 날짜별·객실타입별 상태. "어느 날이 가능한가" 를 알아내는 데 쓴다. */
async function calendarByRoomType(
  ctx: BrowserContext,
  storeCd: string,
  stayDates: string[],
): Promise<Map<string, RoomStatus>> {
  const map = new Map<string, RoomStatus>();
  const seenMonths = new Set<string>();

  for (const date of stayDates) {
    const month = date.slice(0, 6);
    if (seenMonths.has(month)) continue;
    seenMonths.add(month);

    const stores = await fetchCalendarRows(ctx, [storeCd], date);
    for (const s of stores) {
      for (const r of s.rmTypeList ?? []) {
        map.set(`${r.ciYmd}|${r.rmTypeCd}`, mapStatus(r.rsvStatusCd, r.rsvStatusNm));
      }
    }
  }
  return map;
}

/**
 * 연박 기준 잔여 객실수.
 * 객실타입마다 "묵는 날 전체에서 가장 적은 잔여수" 를 구하고, 그것들을 더한다.
 * (하루라도 0이면 그 타입은 연박이 안 되므로 0)
 */
function remainingForStay(store: CalStore, stayDates: string[]): number {
  const byType = new Map<string, number[]>();
  for (const r of store.rmTypeList ?? []) {
    if (!stayDates.includes(r.ciYmd)) continue;
    const list = byType.get(r.rmTypeCd) ?? [];
    list.push(Math.max(0, r.rsvRmCnt ?? 0));
    byType.set(r.rmTypeCd, list);
  }
  let total = 0;
  for (const counts of byType.values()) {
    if (counts.length < stayDates.length) continue;   // 날짜가 빠졌으면 셈에서 뺀다
    total += Math.min(...counts);
  }
  return total;
}
