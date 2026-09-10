/** 객실 사진 연결 코드만 추출한다. 원본 HTML·쿠키·회원 식별자는 저장하지 않는다. */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { getContext, closeAll } from '../src/browser.ts';
import { ananttiAdapter, PROPERTIES } from '../src/adapters/anantti.ts';

async function main() {
  process.env.SESSION_KEY = execFileSync('gcloud', ['secrets','versions','access','latest','--secret=session-key','--project=anc-resort'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  const ctx = await getContext('anantti');
  await ananttiAdapter.ensureSession(ctx);
  const out = '/tmp/anantti-image-evidence';
  await mkdir(out, { recursive: true });
  for (const p of Object.values(PROPERTIES)) {
    const page = await ctx.newPage();
    const response = await page.goto(`https://ananti.kr/ko/reservation/${p.path}/room-search`, { waitUntil: 'domcontentloaded' });
    if (!response?.ok()) throw new Error(`${p.path}: HTTP ${response?.status()}`);
    const body = await page.locator('body').innerText();
    if (/비정상적인 접근|접근이 차단|captcha|자동입력 방지|서비스 점검 중/i.test(body)) throw new Error(`${p.path}: 접근 중단`);
    const cards = await page.locator('.img-room').evaluateAll(images => images.map(image => {
      let ancestor = image.parentElement;
      while (ancestor && !ancestor.id) ancestor = ancestor.parentElement;
      const src = (image as HTMLElement).style.backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
      return { container: ancestor?.id, title: ancestor?.querySelector('h3,h4,h5')?.textContent?.trim(), image: src ? new URL(src, location.href).href : null };
    }));
    await writeFile(`${out}/${p.path}-cards.json`, JSON.stringify(cards, null, 2));
    const html = await page.content();
    const lines = html.split('\n').filter(line => /roomImg|501001|rTypeCode|modalRmType|rmType\s*==|rmType=|modal-room__img|findRmImg|room-img|rmImg|item\.|append\(\$roomInfo|modalRoomName|roomType|rmTypeCd/.test(line) && !/memNo|guestNo|csrf|token|password/i.test(line));
    await writeFile(`${out}/${p.path}.txt`,lines.join('\n'));
    console.log(`${p.path}: 사진 관련 코드 ${lines.length}줄`);
    await page.close();
    await new Promise(r=>setTimeout(r,1500));
  }
}
main().catch(()=>{ console.error('사진 경로 조사 실패 (인증정보 보호를 위해 원문 오류 생략)'); process.exitCode=1; }).finally(closeAll);
