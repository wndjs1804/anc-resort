// 실제 리조트나 Firestore에 접근하지 않고 기존 조회 흐름과 새 포털 화면을 검증한다.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from '../../bot/node_modules/playwright/index.mjs';

const root = new URL('../public/', import.meta.url);
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = new URL(`.${path === '/' ? '/index.html' : path}`, root);
    if (!file.href.startsWith(root.href)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    const type = file.pathname.endsWith('.js') ? 'text/javascript' : file.pathname.endsWith('.css') ? 'text/css' : file.pathname.endsWith('.png') ? 'image/png' : 'text/html';
    res.writeHead(200, { 'content-type': type }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const errors = [];
const calls = [];
const now = new Date();
const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
const checkin = `${ym.slice(0, 4)}-${ym.slice(4)}-24`;
const days = Object.fromEntries(Array.from({ length: 28 }, (_, i) => [`${ym.slice(0, 4)}-${ym.slice(4)}-${String(i + 1).padStart(2, '0')}`, ['available', 'closing', 'waitlist', 'full', 'open', 'unknown'][i % 6]]));
const resorts = [{ id: 'sono', name: '소노' }, { id: 'hanwha', name: '한화' }];
const nodes = [
  { id: 'region', resortId: 'sono', parentId: null, level: 'region', name: '강원권', order: 1 },
  { id: 'property', resortId: 'sono', parentId: 'region', level: 'property', name: '소노벨 비발디파크', order: 1 },
  ...['A', 'B'].map((id, order) => ({ id, resortId: 'sono', parentId: 'property', level: 'building', name: `소노벨 ${id}`, bookable: true, order })),
  { id: 'hanwha-property', resortId: 'hanwha', parentId: null, level: 'property', name: '한화 설악', bookable: true, order: 1 },
];
const detail = (nights = 1) => ({ fetchedAt: new Date().toISOString(), buildings: [], rooms: [
  { roomId: 'full', path: ['리조트', '스위트', '파크뷰', '침대 · 취사'], status: 'full', total: null },
  { roomId: 'closing', path: ['리조트', '디럭스', '오션뷰', '침대 · 클린'], status: 'closing', total: 170000 * nights, perNight: [] },
  { roomId: 'partial', siteRef: { photoGroup: 'anantti-photo-test', capacity: 4 }, path: ['리조트', '스위트', '마운틴뷰', '침대 · 클린'], status: 'partial', total: 190000, availableNights: [checkin], perNight: [{ date: checkin, final: 190000 }] },
  { roomId: 'family', path: ['리조트', '패밀리', '스탠다드', '침대 · 취사'], status: 'available', total: 140000 * nights, perNight: Array.from({ length: nights }, (_, i) => ({ date: `${ym.slice(0, 4)}-${ym.slice(4)}-${24 + i}`, base: 150000, final: 140000, discount: 10000 })) },
] });
const fixture = `
export const initializeApp = () => ({});
export const getFirestore = () => ({});
export const collection = (_, name) => ({ name });
export const doc = (_, name, id) => ({ name, id });
export const where = (...args) => args;
export const query = (ref) => ref;
export async function getDocs(ref) {
 const data = ref.name === 'resorts' ? ${JSON.stringify(resorts)} : ref.name === 'nodes' ? ${JSON.stringify(nodes)} : [{ id: 'family', capacityStd: 4, capacityMax: 6, images: ['./assets/resort-hero.png'] }, { id: 'partial', images: [] }, { id: 'anantti-photo-test', images: ['./assets/resort-hero.png'] }];
 return { docs: data.map(({id, ...value}) => ({ id, data: () => value })) };
}
export async function getDoc(ref) {
 if (ref.name === 'snapshots' && ref.id.endsWith('_${ym}')) return { exists: () => true, data: () => ({ days: ${JSON.stringify(days)}, fetchedAt: ${JSON.stringify(new Date().toISOString())} }) };
 return { exists: () => false };
}`;
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1024 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://www.gstatic.com/firebasejs/**', (route) => route.fulfill({ contentType: 'text/javascript', body: fixture }));
  await page.route('https://anc-resort-bot-*/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON(); calls.push({ path, body });
    const response = path === '/holidays'
      ? { days: { [`${ym.slice(0, 4)}-${ym.slice(4)}-15`]: '광복절 (대체공휴일)' } }
      : path === '/detail' ? detail(body.nights) : { days, fetchedAt: new Date().toISOString() };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });
  await page.goto(`${base}/?t=local-test`);
  await page.locator('#picks select').first().waitFor();
  assert.equal(await page.locator('#calendarSection').isVisible(), false, '첫 화면에서는 기본 숙소 달력을 표시하지 않는다');
  assert.match(await page.locator('#status').innerText(), /조회하기/);
  assert.equal(calls.filter((call) => ['/calendar', '/detail'].includes(call.path)).length, 0, '조회하기 전에는 리조트 조회 API를 호출하지 않는다');
  await page.locator('#search').click();
  await page.locator('#calendar .pickable').first().waitFor();
  await page.locator('#calendar .holiday').waitFor();
  assert.match(await page.locator('#calendar .holiday').innerText(), /광복절 \(대체공휴일\)/, '대체공휴일명을 달력에 표시한다');
  const badgeTops = await page.locator('#calendar .cell').evaluateAll((cells) => [14, 15].map((day) => {
    const cell = cells.find((node) => node.querySelector('.d')?.textContent === String(day));
    return Math.round(cell.querySelector('.badge').getBoundingClientRect().top);
  }));
  assert.equal(badgeTops[0], badgeTops[1], '일반 날짜와 공휴일의 객실 상태를 같은 하단 줄에 표시한다');
  assert.equal(await page.locator('#queryLoading').isVisible(), false);
  // 응답을 보류하여 로딩의 표시·종료와 오류 후 복구를 확인한다.
  for (const endpoint of ['calendar', 'detail']) {
    for (const fail of [false, true]) {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const pattern = `https://anc-resort-bot-*/${endpoint}`;
      await page.route(pattern, async (route) => {
        await gate;
        await route.fulfill({ status: fail ? 503 : 200, contentType: 'application/json', body: JSON.stringify(fail ? { error: 'maintenance' } : endpoint === 'calendar' ? { days, fetchedAt: new Date().toISOString() } : detail()) });
      });
      if (endpoint === 'calendar') await page.locator('#search').click();
      else await page.locator('#calendar button').filter({ has: page.locator('.d', { hasText: /^24$/ }) }).click();
      await page.locator('#queryLoading').waitFor({ state: 'visible' });
      assert.match(await page.locator('#queryLoading').innerText(), /첫 조회는 준비 시간이 필요/);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#queryLoading').isVisible(), true);
      if (endpoint === 'calendar' && !fail) await page.screenshot({ path: '/tmp/ace-portal-loading.png' });
      release();
      await page.locator('#queryLoading').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#status').evaluate((node) => node.classList.contains('loading')), false);
      if (fail) assert.match(await page.locator('#status').innerText(), /점검 중/);
      await page.unroute(pattern);
    }
  }
  assert.equal(await page.locator('#picks select').count(), 4);
  await page.locator('#calendar button').filter({ has: page.locator('.d', { hasText: /^24$/ }) }).click();
  await page.locator('#detailSection:not([hidden])').waitFor();
  assert.match(await page.locator('#selectedDate').innerText(), /24일/);
  assert.match(await page.locator('#rooms').innerText(), /140,000원/);
  assert.deepEqual(await page.locator('.group-head').allTextContents(), ['소노벨 A · 리조트 · 패밀리', '소노벨 A · 리조트 · 디럭스', '소노벨 A · 리조트 · 스위트'], '객실 종류와 낮은 등급순으로 정렬');
  assert.deepEqual(await page.locator('.room').evaluateAll((rows) => rows.map((row) => row.dataset.roomId)), ['family', 'closing', 'partial', 'full'], '같은 종류 안에서 객실명순 정렬');
  assert.equal(await page.locator('.room[data-room-id="partial"] img.thumb').count(), 1, '새 객실은 공식 사진 그룹으로 연결');
  assert.match(await page.locator('.room[data-room-id="partial"] .room-capacity').innerText(), /기준 4인/, '사진 전용 문서가 API 정원을 가리지 않는다');
  await page.locator('#availableOnly').click();
  assert.equal(await page.locator('#availableOnly').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await page.locator('.room').evaluateAll((rows) => rows.map((row) => row.dataset.roomId)), ['family', 'closing'], '가능과 잔여객실 적음만 표시');
  assert.equal(await page.locator('#roomCount').innerText(), '2/4개');
  await page.locator('#availableOnly').click();
  assert.equal(await page.locator('.room').count(), 4);
  await page.selectOption('#nights', '2');
  await page.waitForFunction(() => document.querySelector('#rooms').textContent.includes('280,000원'));
  assert.match(await page.locator('#rooms').innerText(), /2박 합계/);
  assert.match(await page.locator('#rooms').innerText(), /1박 합계/);
  await page.locator('.thumb[role="button"]').first().focus();
  await page.keyboard.press('Enter');
  await page.locator('#lightbox:not([hidden])').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#lightbox').isVisible(), false);
  await page.locator('.room-photo').first().click();
  await page.locator('#lightbox:not([hidden])').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.room-photo').first().evaluate((node) => node === document.activeElement), true, '사진을 닫으면 버튼으로 초점 복귀');
  assert.match(await page.locator('.room-capacity').first().innerText(), /기준 4인/);
  await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: '/tmp/ace-portal-desktop.png', fullPage: true });
  await page.getByRole('link', { name: '자주 묻는 질문', exact: true }).click();
  await page.locator('#faqPage:not([hidden])').waitFor();
  assert.equal(await page.locator('.faq-item').count(), 8);
  await page.fill('#faqQuery', '아난티');
  await page.locator('#faqSearch button').click();
  assert.equal(await page.locator('.faq-item').count(), 1);
  await page.fill('#faqQuery', '없는질문123');
  await page.locator('#faqSearch button').click();
  assert.match(await page.locator('#faqList').innerText(), /검색 결과가 없습니다/);
  await page.getByRole('link', { name: '공지사항', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#pageTitle').textContent === '공지사항');
  assert.match(await page.locator('#noticeEmpty').innerText(), /등록된 공지사항이 없습니다/);
  await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: '/tmp/ace-portal-notices.png', fullPage: true });
  await page.getByRole('link', { name: '이용조회', exact: true }).click();
  await page.locator('#inquiryPage:not([hidden])').waitFor();
  assert.match(await page.locator('#selectedDate').innerText(), /24일/);
  for (const width of [1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}px 가로 넘침`);
    if (width === 390) await page.screenshot({ path: '/tmp/ace-portal-mobile.png', fullPage: true });
  }
  await page.locator('#picks select').last().selectOption('B');
  assert.equal(await page.locator('#detailSection').isVisible(), false);
  assert.equal(await page.locator('#calendarSection').isVisible(), false, '숙소를 바꾸면 이전 숙소 달력을 숨긴다');
  assert.match(await page.locator('#selectedDetails').innerText(), /소노벨 B/);
  await page.locator('#picks select').first().selectOption('hanwha');
  assert.equal(await page.locator('#picks select').count(), 2, '리조트마다 선택 계층을 동적으로 표시한다');
  await page.locator('#search').click();
  await page.waitForFunction(() => !document.querySelector('#status').classList.contains('loading'));
  const calendarCalls = calls.filter((call) => call.path === '/calendar').length;
  await page.locator('#nextMonth').click();
  await page.waitForFunction(() => !document.querySelector('#status').classList.contains('loading'));
  assert.equal(calls.filter((call) => call.path === '/calendar').length, calendarCalls + 1, '저장본이 없는 다음 달은 리조트 사이트를 자동 조회한다');
  assert.equal(calls.at(-1).body.nodeId, 'hanwha-property');
  await page.getByRole('link', { name: '자주 묻는 질문', exact: true }).click();
  await page.fill('#faqQuery', ''); await page.locator('#faqSearch button').click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '/tmp/ace-portal-faq.png', fullPage: true });
  for (const hash of ['#faq', '#notices']) {
    await page.getByRole('link', { name: hash === '#faq' ? '자주 묻는 질문' : '공지사항', exact: true }).click();
    for (const width of [1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${hash} ${width}px 가로 넘침`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { sessionStorage.setItem('ancAdminSession', 'test-session'); location.reload(); });
  await page.locator('#addNotice:not([hidden])').waitFor();
  await page.locator('#adminTrigger').dblclick();
  assert.equal(await page.locator('#addNotice').isVisible(), false, '좌측 하단을 다시 더블클릭하면 관리자 모드를 종료한다');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('ancAdminSession')), null, '로그아웃하면 관리자 세션을 제거한다');
  await page.locator('#adminTrigger').dblclick();
  assert.equal(await page.locator('#adminLogin').isVisible(), true, '로그아웃 후 더블클릭하면 다시 로그인 창을 연다');
  assert.deepEqual(errors, []);
  console.log('PASS: 저장 결과, 날짜 선택, 연박 요금, 사진 키보드, 메뉴 이동, FAQ 검색, 빈 공지, 리조트 계층, 조회 요청, 320~1680px 레이아웃');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
