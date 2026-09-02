/**
 * Phase 1 — 소노 기본정보 수집
 *
 * 하는 일: 담당자 계정으로 로그인해서 지역·숙소·동 트리와 객실 목록(정원·면적·사진 주소)을 읽어
 *          Firestore 의 nodes / rooms 에 넣는다. 1회성 작업이며, 다시 실행해도 같은 문서를 덮어쓴다.
 *
 * 하지 않는 일: 예약·취소·대기신청 등 사이트 상태를 바꾸는 동작. 읽기 전용이다.
 *
 * 실행:
 *   npm run seed:sono -- --dry-run     결과만 확인하고 Firestore 에 쓰지 않음 (먼저 이걸로 확인)
 *   npm run seed:sono                  Firestore 에 저장
 *   npm run seed:sono -- --limit=2     동 2개만 (빠른 시험)
 *   npm run seed:sono -- --headed      브라우저 창을 보면서 실행
 *
 * 계정은 실행 중에 물어본다. 파일에 저장하지 않는다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type APIRequestContext, type Browser, type Page } from 'playwright';

import { getSonoCredentials } from '../src/secrets.ts';
import { PROJECT_ID, writeNodes, writeResort, writeRooms, type NodeDoc, type RoomDoc } from '../src/store.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 상수 — 사이트가 바뀌면 이 블록만 고친다 (근거: docs/sono-site-notes.md)
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
  placeList: '/api/hms/user/memberReservation/room/placeList',
  roomDetail: '/api/hms/user/memberReservation/room/detail',
  roomLinkUrl: '/api/hms/user/management/room/reserveRoomLinkUrlMulti',
  facilityDetail: '/api/hms/user/management/room/detail',
  image: '/api/hms/user/management/file/image',
};

/** 모든 API 에 붙는 공통 쿼리 */
const COMMON_QS = 'lang=ko&deviceType=PC&mobileAppYn=N';

/** 조회 조건 상수. 의미는 아직 확인 안 됨 — 화면이 보내던 값을 그대로 쓴다. */
const RSV_IND_CD = '9';      // TODO(verify) 예약구분?
const USER_IND_CD = 'Y';     // TODO(verify)
const RSV_BLCK_CD = '000';   // TODO(verify)

/** 객실 목록을 읽을 기준 날짜: 오늘로부터 며칠 뒤 1박. 마감된 날짜여도 객실 목록 자체는 나온다. */
const PROBE_OFFSET_DAYS = [30, 90, 150];

/** 사람 속도로 (CLAUDE.md §7.4) */
const DELAY_MS: [number, number] = [500, 1200];

const RESORT_ID = 'sono';

// ─────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOT_DIR = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const HEADED = argv.includes('--headed');
const LIMIT = Number(argv.find((a) => a.startsWith('--limit='))?.slice('--limit='.length) ?? 0) || 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const humanDelay = () => sleep(DELAY_MS[0] + Math.random() * (DELAY_MS[1] - DELAY_MS[0]));

const ymd = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};

/** HTML 엔티티를 실제 문자로 되돌린다. 사이트가 &middot; 같은 걸 그대로 준다. */
const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&middot;': '·', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&apos;': "'", '&sim;': '~', '&ndash;': '–', '&mdash;': '—',
};

const stripTags = (html: string | null | undefined): string =>
  (html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-zA-Z]+;|&#\d+;/g, (m) => ENTITIES[m] ?? (m.startsWith('&#') ? String.fromCharCode(Number(m.slice(2, -1))) : m))
    .replace(/\s+/g, ' ')
    .trim();

/**
 * "2인(더블+싱글 최대 3인)" → { std: 2, max: 3 }
 *
 * 조건이 여러 개인 경우가 있다. 예: 펫 객실
 *   "소·중형견 투숙 시 4인(최대 6인) 중대·대형견 투숙 시 3인(최대 5인)"
 * 이럴 때는 첫 번째 조건의 숫자를 쓰되 ambiguous=true 로 표시한다.
 * 화면은 ambiguous 면 숫자 대신 원문(capacityText)을 보여줘야 한다.
 */
function parseCapacity(html: string | null | undefined): {
  std: number | null; max: number | null; text: string | null; ambiguous: boolean;
} {
  const text = stripTags(html);
  if (!text) return { std: null, max: null, text: null, ambiguous: false };
  const maxAll = [...text.matchAll(/최대\s*(\d+)\s*인/g)];
  const max = maxAll.length ? Number(maxAll[0][1]) : null;
  const stdMatch = text.replace(/최대\s*\d+\s*인/g, ' ').match(/(\d+)\s*인/);
  const std = stdMatch ? Number(stdMatch[1]) : null;
  return { std, max: max ?? std, text, ambiguous: maxAll.length > 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 사이트 호출
// ─────────────────────────────────────────────────────────────────────────────

type ApiEnvelope<T> = { success: boolean; error: unknown; body: T };

/**
 * 페이지가 실제로 보내는 인증 헤더를 그대로 물려받는다.
 * 헤더 이름을 미리 알 수 없으므로, 브라우저가 알아서 붙이는 표준 헤더만 걸러내고 나머지를 전부 가져온다.
 * (쿠키 방식이면 비어 있어도 정상이다 — 쿠키는 BrowserContext 가 공유한다.)
 */
const inheritedHeaders: Record<string, string> = {};

/** 브라우저가 스스로 붙이는 헤더 — 우리가 흉내 낼 필요도, 물려받을 이유도 없다. */
const BROWSER_OWN_HEADERS = new Set([
  'host', 'connection', 'content-length', 'user-agent', 'accept', 'accept-encoding', 'accept-language',
  'referer', 'origin', 'cookie', 'content-type', 'cache-control', 'pragma', 'dnt', 'te', 'priority',
  'upgrade-insecure-requests', 'if-none-match', 'if-modified-since', 'range',
]);

async function callApi<T>(
  request: APIRequestContext,
  method: 'GET' | 'POST',
  apiPath: string,
  opts: { query?: string; data?: unknown } = {},
): Promise<T> {
  const url = `${BASE}${apiPath}?${COMMON_QS}${opts.query ? '&' + opts.query : ''}`;
  const res = await request.fetch(url, {
    method,
    headers: { accept: 'application/json', referer: RESERVE_URL, ...inheritedHeaders },
    ...(opts.data !== undefined ? { data: opts.data } : {}),
  });
  if (!res.ok()) throw new Error(`${method} ${apiPath} → HTTP ${res.status()}`);
  const json = (await res.json()) as ApiEnvelope<T>;
  if (json.success === false) throw new Error(`${method} ${apiPath} → success=false ${JSON.stringify(json.error).slice(0, 200)}`);
  return json.body;
}

/** 로그인 API 응답 요약. 본문(토큰 포함)은 절대 기록하지 않고 성공 여부만 본다. */
type LoginOutcome = { status: number | null; success: boolean | null; error: string | null };

async function login(page: Page, creds: { id: string; pw: string }): Promise<LoginOutcome> {
  const { id, pw } = creds;
  const outcome: LoginOutcome = { status: null, success: null, error: null };

  page.on('response', (res) => {
    if (!res.url().includes('/auth/login')) return;
    outcome.status = res.status();
    void res
      .json()
      .then((j: { success?: boolean; error?: unknown }) => {
        outcome.success = j?.success ?? null;
        outcome.error = j?.error ? JSON.stringify(j.error).slice(0, 200) : null;
      })
      .catch(() => {});
  });

  console.log('\n  로그인 중…');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });

  const idBox = page.locator(SEL.loginId);
  const pwBox = page.locator(SEL.loginPw);
  await idBox.waitFor({ state: 'visible', timeout: 20_000 });

  // 사람이 치듯 입력한다. 일부 폼은 fill() 로 넣은 값을 인식하지 못한다.
  await idBox.click();
  await idBox.pressSequentially(id, { delay: 40 });
  await humanDelay();
  await pwBox.click();
  await pwBox.pressSequentially(pw, { delay: 40 });
  await humanDelay();

  // 입력이 실제로 들어갔는지 확인 (보안 키패드 등으로 값이 안 들어가는 경우를 잡는다)
  const typed = await page.evaluate(
    (sel) => {
      const el = document.querySelector(sel.pw) as HTMLInputElement | null;
      const idEl = document.querySelector(sel.id) as HTMLInputElement | null;
      return { pwLen: el?.value.length ?? -1, idLen: idEl?.value.length ?? -1 };
    },
    { id: SEL.loginId, pw: SEL.loginPw },
  );
  if (typed.idLen <= 0 || typed.pwLen <= 0) {
    console.log(`  ⚠ 입력칸에 값이 들어가지 않았습니다 (아이디 ${typed.idLen}자, 비밀번호 ${typed.pwLen}자).`);
    console.log('    보안 키패드를 쓰는 화면일 수 있습니다. --headed 로 직접 확인이 필요합니다.');
  }

  const submit = page.locator(SEL.loginSubmit).first();
  if (await submit.count()) await submit.click();
  else await pwBox.press('Enter');

  await page.waitForURL((u) => !u.pathname.includes('/member/login'), { timeout: 20_000 }).catch(() => {});
  await sleep(2500);
  return outcome;
}

/** 로그인이 왜 안 됐는지 가려낸다. 계정 정보는 출력하지 않는다. */
async function diagnoseLogin(page: Page, request: APIRequestContext, outcome: LoginOutcome): Promise<void> {
  console.log('\n  ── 진단 ──────────────────────────────────────');
  console.log(`  로그인 API 응답     : ${outcome.status ?? '호출 기록 없음'}` +
    (outcome.success === null ? '' : ` · success=${outcome.success}`) +
    (outcome.error ? ` · error=${outcome.error}` : ''));
  console.log(`  로그인 후 주소      : ${page.url()}`);

  const visible = await page
    .evaluate(() => {
      const hits: string[] = [];
      document.querySelectorAll('*').forEach((el) => {
        if (el.children.length) return;
        const t = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
        if (t && t.length < 120 && /(일치하지|올바르지|확인해|실패|잠금|정지|오류|다시 시도|인증)/.test(t)) hits.push(t);
      });
      return [...new Set(hits)].slice(0, 5);
    })
    .catch(() => [] as string[]);
  console.log(`  화면의 안내 문구    : ${visible.length ? visible.join(' / ') : '없음'}`);

  const inPage = await page
    .evaluate(async (qs) => (await fetch(`/api/hms/user/management/auth/userinfo?${qs}`)).status, COMMON_QS)
    .catch(() => -1);
  const viaRequest = await request
    .fetch(`${BASE}${API.userinfo}?${COMMON_QS}`, { headers: { accept: 'application/json', ...inheritedHeaders } })
    .then((r) => r.status())
    .catch(() => -1);
  console.log(`  브라우저에서 확인   : userinfo → ${inPage}`);
  console.log(`  스크립트에서 확인   : userinfo → ${viaRequest}`);
  console.log(`  물려받은 인증 헤더  : ${Object.keys(inheritedHeaders).join(', ') || '없음'}`);

  const shotDir = path.join(BOT_DIR, 'docs', 'captures');
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = path.join(shotDir, `login-debug-${Date.now()}.png`);
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  console.log(`  화면 사진           : ${path.relative(process.cwd(), shot)}`);
  console.log('  ──────────────────────────────────────────────');

  if (inPage === 200 && viaRequest !== 200) {
    console.log('  → 로그인 자체는 됐습니다. 스크립트 쪽 인증 전달이 문제입니다. 이 결과를 알려주세요.');
  } else if (inPage !== 200) {
    console.log('  → 로그인이 실제로 되지 않았습니다. 비밀번호 또는 추가 인증 단계를 확인하세요.');
  }
}

/** 로그인 여부는 userinfo 의 상태코드로 판단한다 (docs/sono-site-notes.md §1) */
async function isLoggedIn(request: APIRequestContext): Promise<boolean> {
  const res = await request.fetch(`${BASE}${API.userinfo}?${COMMON_QS}`, {
    headers: { accept: 'application/json', ...inheritedHeaders },
  });
  return res.status() === 200;
}

// ─────────────────────────────────────────────────────────────────────────────
// 사이트 응답 타입 (확인된 필드만)
// ─────────────────────────────────────────────────────────────────────────────

type Store = { storeCd: string; storeNm: string; outsYn?: string };
type Place = { placeSeq: number; placeNm: string; jiyukCd: string; jiyukNm: string; jiyukSortNo?: number; storeList?: Store[] };
type RmType = {
  rmTypeCd: string; rmTypeNm: string;
  bedNm?: string; cookNm?: string; dongCd?: string; dongNm?: string;
  pyeongCd?: string; viewCd?: string; bedCd?: string; cookCd?: string; petYn?: string;
};
type ViewGroup = { viewCd: string; viewNm: string; rmTypeList: RmType[] };
type RoomGroup = { resortTypeNm: string; roomTypeNm: string; roomTypeCd: string; viewList: ViewGroup[] };
type LinkUrl = { storeCd: string; rmTypeCd: string; facilityCd: string; linkUrl: string };
type FacilityDetail = { facilityCd: string; facilityNm: string; personCnt?: string; roomPyeong?: string; images?: Array<{ fileFetchId?: string }> };

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('  ANC 리조트 — Phase 1 소노 기본정보 수집');
  console.log('  ────────────────────────────────────────────────');
  console.log(`  대상: Firestore 프로젝트 ${PROJECT_ID}`);
  console.log(`  모드: ${DRY_RUN ? 'dry-run (저장하지 않음)' : '저장'}${LIMIT ? ` · 동 ${LIMIT}개만` : ''}`);
  console.log('  이 스크립트는 읽기만 합니다. 예약·취소를 하지 않습니다.');
  console.log('  ────────────────────────────────────────────────');

  // 자격을 먼저 받는다. 브라우저를 미리 띄워 두면 빈 창이 떠 있는 동안 사용자가 닫아 버릴 수 있다.
  const creds = await getSonoCredentials();

  console.log('');
  console.log(HEADED
    ? '  브라우저 창을 띄웁니다. 실행이 끝날 때까지 창을 닫지 마세요.'
    : '  브라우저를 띄웁니다(화면에는 보이지 않습니다).');

  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: !HEADED, channel: 'chrome' });
  } catch {
    browser = await chromium.launch({ headless: !HEADED });
  }
  // 창 크기를 고정한다. 좁으면 사이트가 모바일 화면(/reserve/room/mo)으로 넘어가 흐름이 달라진다.
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  });
  const page = await ctx.newPage();

  // 페이지가 API 를 부를 때 쓰는 인증 헤더를 그대로 물려받는다.
  page.on('request', (req) => {
    if (!req.url().includes('/api/hms/user/')) return;
    for (const [key, value] of Object.entries(req.headers())) {
      const k = key.toLowerCase();
      if (BROWSER_OWN_HEADERS.has(k) || k.startsWith('sec-') || inheritedHeaders[k]) continue;
      inheritedHeaders[k] = value;
    }
  });

  try {
    const outcome = await login(page, creds);

    // 예약 화면을 한 번 열어 실제 API 호출을 발생시킨다(헤더 물려받기 + 세션 확인)
    await page.goto(RESERVE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    await sleep(3000);

    if (!(await isLoggedIn(ctx.request))) {
      await diagnoseLogin(page, ctx.request, outcome);
      throw new Error('로그인 상태를 확인하지 못했습니다. 위 진단 내용을 확인하세요.');
    }
    console.log('  로그인 확인됨');
    if (Object.keys(inheritedHeaders).length) {
      console.log(`  인증 헤더 물려받음: ${Object.keys(inheritedHeaders).join(', ')}`);
    } else {
      console.log('  인증은 쿠키로 처리됨 (별도 헤더 없음)');
    }

    const memNo = await callApi<string>(ctx.request, 'GET', API.memberNo);
    console.log(`  회원번호 확인됨 (${memNo.length}자리)`);

    // ── 1. 지역 · 숙소 · 동 트리 ────────────────────────────────────────────
    const placeBody = await callApi<{ placeList: Place[] }>(
      ctx.request, 'GET', API.placeList,
      { query: `memNo=${encodeURIComponent(memNo)}&userIndCd=${USER_IND_CD}&outsExcludeYn=N` },
    );
    const places = placeBody.placeList ?? [];

    const nodes: NodeDoc[] = [];
    const regionSeen = new Map<string, { name: string; order: number }>();
    const buildings: Array<{ nodeId: string; storeCd: string; storeNm: string; placeNm: string }> = [];

    places.forEach((p, pi) => {
      if (!regionSeen.has(p.jiyukCd)) {
        regionSeen.set(p.jiyukCd, { name: p.jiyukNm, order: p.jiyukSortNo ?? regionSeen.size });
      }
      const regionId = `${RESORT_ID}-region-${p.jiyukCd}`;
      const placeId = `${RESORT_ID}-place-${p.placeSeq}`;
      nodes.push({
        id: placeId, resortId: RESORT_ID, parentId: regionId, level: 'property',
        name: p.placeNm, order: pi, bookable: false, siteRef: { placeSeq: p.placeSeq }, active: true,
      });
      (p.storeList ?? []).forEach((s, si) => {
        const storeId = `${RESORT_ID}-store-${s.storeCd}`;
        nodes.push({
          id: storeId, resortId: RESORT_ID, parentId: placeId, level: 'building',
          name: s.storeNm.trim(), order: si, bookable: true,
          siteRef: { storeCd: s.storeCd, outsYn: s.outsYn ?? 'N' }, active: true,
        });
        buildings.push({ nodeId: storeId, storeCd: s.storeCd, storeNm: s.storeNm.trim(), placeNm: p.placeNm });
      });
    });
    for (const [jiyukCd, r] of regionSeen) {
      nodes.push({
        id: `${RESORT_ID}-region-${jiyukCd}`, resortId: RESORT_ID, parentId: null, level: 'region',
        name: r.name, order: r.order, bookable: false, siteRef: { jiyukCd }, active: true,
      });
    }

    console.log(`\n  지역 ${regionSeen.size} · 숙소 ${places.length} · 동 ${buildings.length}`);

    // 중간에 끊겨도 여기까지는 남도록 바로 저장한다.
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    const outDir = path.join(BOT_DIR, 'docs', 'captures', `seed-${stamp}`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'nodes.json'), JSON.stringify(nodes, null, 2));

    // ── 2. 동마다 객실 목록 ────────────────────────────────────────────────
    const targets = LIMIT ? buildings.slice(0, LIMIT) : buildings;
    const rooms: RoomDoc[] = [];
    const failures: Array<{ store: string; reason: string }> = [];

    for (const [i, b] of targets.entries()) {
      const label = `[${i + 1}/${targets.length}] ${b.placeNm} · ${b.storeNm}`;
      try {
        let groups: RoomGroup[] = [];
        for (const offset of PROBE_OFFSET_DAYS) {
          const ciYmd = ymd(offset);
          const coYmd = ymd(offset + 1);
          groups = await callApi<RoomGroup[]>(ctx.request, 'POST', API.roomDetail, {
            data: {
              storeCdList: [b.storeCd], rsvIndCd: RSV_IND_CD, memNo, actualMemNo: memNo,
              rsvBlckCd: RSV_BLCK_CD, userIndCd: USER_IND_CD,
              ciYmd, coYmd, nights: 1, rmCnt: 1, adultCnt: 1, childCnt: 0,
            },
          });
          if (groups?.length) break;
          await humanDelay();
        }
        if (!groups?.length) {
          failures.push({ store: label, reason: '객실 목록이 비어 있음' });
          console.log(`  ${label} — 객실 없음`);
          continue;
        }

        const flat: Array<{ group: RoomGroup; view: ViewGroup; rt: RmType }> = [];
        for (const g of groups) for (const v of g.viewList ?? []) for (const rt of v.rmTypeList ?? []) flat.push({ group: g, view: v, rt });

        // rmTypeCd → facilityCd (사진·정원 페이지 식별자)
        let linkMap = new Map<string, LinkUrl>();
        try {
          const links = await callApi<LinkUrl[]>(ctx.request, 'POST', API.roomLinkUrl, {
            data: { condition: flat.map((f) => ({ storeCd: b.storeCd, rmTypeCd: f.rt.rmTypeCd })) },
          });
          linkMap = new Map(links.map((l) => [l.rmTypeCd, l]));
        } catch (e) {
          failures.push({ store: label, reason: `사진 매핑 실패: ${(e as Error).message}` });
        }

        // facilityCd 별 정원·면적·사진 (같은 facilityCd 는 한 번만)
        const facilityCache = new Map<string, FacilityDetail | null>();
        for (const fc of new Set([...linkMap.values()].map((l) => l.facilityCd))) {
          await humanDelay();
          try {
            facilityCache.set(fc, await callApi<FacilityDetail>(ctx.request, 'GET', API.facilityDetail, { query: `facilityCd=${encodeURIComponent(fc)}` }));
          } catch {
            facilityCache.set(fc, null);
          }
        }

        for (const f of flat) {
          const link = linkMap.get(f.rt.rmTypeCd);
          const detail = link ? facilityCache.get(link.facilityCd) ?? null : null;
          const cap = parseCapacity(detail?.personCnt);
          const optionLabel = [f.rt.bedNm, f.rt.cookNm].map((v) => (v ?? '').trim()).filter(Boolean).join(' · ');
          const pathParts = [f.group.resortTypeNm, f.group.roomTypeNm, f.view.viewNm, optionLabel || f.rt.rmTypeNm]
            .map((v) => (v ?? '').trim())
            .filter(Boolean);

          rooms.push({
            id: `${RESORT_ID}-${b.storeCd}-${f.rt.rmTypeCd}`,
            nodeId: b.nodeId,
            path: pathParts,
            capacityStd: cap.std,
            capacityMax: cap.max,
            capacityText: cap.text,
            capacityAmbiguous: cap.ambiguous,
            areaText: stripTags(detail?.roomPyeong) || null,
            images: [],
            imageSourceUrls: (detail?.images ?? [])
              .map((im) => im.fileFetchId)
              .filter((v): v is string => Boolean(v))
              .map((id) => `${BASE}${API.image}/${id}/1`),
            siteRef: {
              storeCd: b.storeCd, rmTypeCd: f.rt.rmTypeCd, rmTypeNm: f.rt.rmTypeNm,
              facilityCd: link?.facilityCd ?? null,
              viewCd: f.view.viewCd, pyeongCd: f.rt.pyeongCd ?? null,
              bedCd: f.rt.bedCd ?? null, cookCd: f.rt.cookCd ?? null,
              dongCd: f.rt.dongCd ?? null, dongNm: f.rt.dongNm ?? null,
              petYn: f.rt.petYn ?? 'N',
            },
            active: true,
          });
        }

        const withPhoto = rooms.filter((r) => r.nodeId === b.nodeId && r.imageSourceUrls.length).length;
        console.log(`  ${label} — 객실 ${flat.length}종 (사진 ${withPhoto})`);
        // 동 하나가 끝날 때마다 저장. 10분짜리 작업이 중간에 끊겨도 앞부분은 남는다.
        fs.writeFileSync(path.join(outDir, 'rooms.json'), JSON.stringify(rooms, null, 2));
      } catch (e) {
        failures.push({ store: label, reason: (e as Error).message });
        console.log(`  ${label} — 실패: ${(e as Error).message}`);
      }
      await humanDelay();
    }

    // ── 3. 결과 저장 ───────────────────────────────────────────────────────
    fs.writeFileSync(path.join(outDir, 'rooms.json'), JSON.stringify(rooms, null, 2));
    if (failures.length) fs.writeFileSync(path.join(outDir, 'failures.json'), JSON.stringify(failures, null, 2));

    console.log('');
    console.log('  ────────────────────────────────────────────────');
    console.log(`  nodes ${nodes.length}건 · rooms ${rooms.length}건 · 실패 ${failures.length}건`);
    console.log(`  결과 파일: ${path.relative(process.cwd(), outDir)}`);

    if (DRY_RUN) {
      console.log('  dry-run 이므로 Firestore 에 쓰지 않았습니다.');
    } else {
      await writeResort(RESORT_ID, '소노');
      const n = await writeNodes(nodes);
      const r = await writeRooms(rooms);
      console.log(`  Firestore 저장 완료: nodes ${n} · rooms ${r}`);
    }
    console.log('  ────────────────────────────────────────────────');
    console.log('');
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  const msg = (err as Error).message;
  console.error('\n  실패:', msg);
  if (/has been closed|Target page|browser has been closed/i.test(msg)) {
    console.error('  → 브라우저 창이 닫혔습니다. 실행이 끝날 때까지 창을 그대로 두세요.');
  }
  process.exit(1);
});
