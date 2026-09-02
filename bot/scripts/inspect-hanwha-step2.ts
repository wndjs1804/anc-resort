/**
 * 한화 로그인 2단계(회원권 비밀번호) 화면의 폼 구조만 확인하는 일회성 도구.
 *
 *   npm run inspect:hanwha
 *   npm run inspect:hanwha -- --headed     화면을 보면서
 *
 * 아이디·비밀번호로 1단계만 통과한 뒤, 2단계 화면의 **구조만** 출력하고 끝낸다.
 * 회원권 비밀번호는 입력하지 않는다. 값은 어떤 것도 출력하지 않는다.
 */

import { chromium } from 'playwright';

import { getCredentials } from '../src/secrets.ts';

const LOGIN_URL = 'https://www.hanwharesort.co.kr/irsweb/resort3/member/login.do';
const SEL = { id: '#id', pw: '#pwd', submit: '#btnLogin' };
const STEP2 = 'login_membership_password';

const HEADED = process.argv.includes('--headed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('');
  console.log('  한화 로그인 2단계 화면 구조 확인');
  console.log('  ──────────────────────────────────────────────');
  console.log('  아이디·비밀번호로 1단계만 통과합니다.');
  console.log('  회원권 비밀번호는 입력하지 않고, 화면 구조만 봅니다.');
  console.log('  ──────────────────────────────────────────────');

  const { id, pw } = await getCredentials('hanwha');

  const browser = await chromium.launch({ headless: !HEADED, channel: 'chrome' }).catch(() => chromium.launch({ headless: !HEADED }));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const page = await ctx.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.locator(SEL.id).fill(id);
    await sleep(400);
    await page.locator(SEL.pw).fill(pw);
    await sleep(400);
    await page.locator(SEL.submit).first().click();

    await page.waitForURL((u) => u.href.includes(STEP2), { timeout: 30_000 }).catch(() => {});
    await sleep(2000);

    console.log(`\n  현재 주소: ${page.url()}`);
    if (!page.url().includes(STEP2)) {
      console.log('  ⚠ 회원권 비밀번호 화면이 아닙니다. 아래는 지금 화면의 구조입니다.');
    }
    console.log(`  제목: ${await page.title()}`);

    // 값은 절대 출력하지 않는다. 이름·형태만 본다.
    const dump = await page.evaluate(() => {
      const forms = [...document.querySelectorAll('form')].map((f) => ({
        action: f.getAttribute('action') ?? '',
        method: (f.getAttribute('method') ?? 'get').toUpperCase(),
        id: f.id || '',
        name: f.getAttribute('name') ?? '',
      }));
      const inputs = [...document.querySelectorAll('input, select, textarea')].map((e) => {
        const i = e as HTMLInputElement;
        return {
          tag: e.tagName.toLowerCase(),
          type: i.type ?? '',
          id: i.id || '',
          name: i.name || '',
          placeholder: i.placeholder || '',
          maxLength: i.maxLength > 0 ? i.maxLength : null,
          visible: !!(e as HTMLElement).offsetParent,
        };
      });
      const buttons = [...document.querySelectorAll('button, input[type=submit], input[type=button], a[href="#"]')].map((e) => ({
        tag: e.tagName.toLowerCase(),
        text: (e.textContent || (e as HTMLInputElement).value || '').trim().replace(/\s+/g, ' ').slice(0, 20),
        id: e.id || '',
        cls: (e.className || '').toString().slice(0, 45),
        onclick: (e.getAttribute('onclick') ?? '').slice(0, 70),
      })).filter((b) => b.text || b.id);
      const security = ['captcha', 'recaptcha', 'keypad', 'transkey', 'nprotect', 'touchen', 'astx', 'raon']
        .filter((k) => document.documentElement.innerHTML.toLowerCase().includes(k));
      const guide = [...document.querySelectorAll('p, li, span, label, h1, h2, h3')]
        .map((e) => (e.textContent || '').trim().replace(/\s+/g, ' '))
        .filter((t) => t && t.length < 60 && /비밀번호|회원권|입력|확인/.test(t));
      return { forms, inputs, buttons, security, guide: [...new Set(guide)].slice(0, 6) };
    });

    console.log('\n  ■ 폼');
    for (const f of dump.forms) console.log(`     ${f.method} action="${f.action}" id=${f.id || '-'} name=${f.name || '-'}`);
    console.log('\n  ■ 입력칸 (값은 읽지 않음)');
    for (const i of dump.inputs) {
      console.log(`     <${i.tag}> type=${i.type} id=${i.id || '-'} name=${i.name || '-'} ` +
        `ph=${i.placeholder || '-'} maxlen=${i.maxLength ?? '-'} 보임=${i.visible}`);
    }
    console.log('\n  ■ 버튼');
    for (const b of dump.buttons) console.log(`     "${b.text}" <${b.tag}> id=${b.id || '-'} class=${b.cls || '-'}${b.onclick ? ` onclick=${b.onclick}` : ''}`);
    console.log('\n  ■ 화면 안내 문구');
    for (const g of dump.guide) console.log(`     ${g}`);
    console.log(`\n  ■ 보안모듈: ${dump.security.join(', ') || '없음'}`);
    console.log('');
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error('\n  실패:', (e as Error).message);
  process.exit(1);
});
