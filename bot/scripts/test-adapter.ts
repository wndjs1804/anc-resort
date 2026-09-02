/**
 * Phase 2 검증 스크립트 — 소노 어댑터를 로컬에서 돌려 본다.
 *
 *   npm run test:sono                        기본값으로 전체 확인
 *   npm run test:sono -- --node=sono-store-54
 *   npm run test:sono -- --checkin=2026-10-15 --nights=2
 *   npm run test:sono -- --headed            브라우저를 보면서
 *
 * 세션 재사용을 확인하려면 SESSION_KEY 를 정해 두고 두 번 실행한다.
 * 두 번째 실행에서 "로그인 없이 세션 복원" 이 나와야 한다.
 */

import { ananttiAdapter } from '../src/adapters/anantti.ts';
import { hanwhaAdapter } from '../src/adapters/hanwha.ts';
import { sonoAdapter } from '../src/adapters/sono.ts';
import { AdapterError, type Node, type ResortAdapter, type ResortId } from '../src/adapters/types.ts';
import { closeAll, getContext, getLoginCount } from '../src/browser.ts';
import { getNode } from '../src/store.ts';

const ADAPTERS: Record<string, ResortAdapter> = { sono: sonoAdapter, anantti: ananttiAdapter, hanwha: hanwhaAdapter };

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const HEADED = argv.includes('--headed');
const RESORT = (arg('resort') ?? 'sono') as ResortId;
const DEFAULT_NODE: Record<string, string> = {
  sono: 'sono-store-70',              // 델피노 · 소노벨 EAST (형제 동 4개)
  anantti: 'anantti-place-village',   // 빌라쥬 드 아난티
  hanwha: 'hanwha-loc-0101',          // 설악 쏘라노
};
const NODE_ID = arg('node') ?? DEFAULT_NODE[RESORT] ?? '';
const NIGHTS = Number(arg('nights') ?? 2);
const adapter = ADAPTERS[RESORT];
if (!adapter) { console.error(`모르는 리조트입니다: ${RESORT}`); process.exit(1); }

const pad = (n: number) => String(n).padStart(2, '0');
const nextMonth = (): string => {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}`;
};
const inDays = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const MONTH = arg('month') ?? nextMonth();
const CHECKIN = arg('checkin') ?? inDays(30);

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}초`;
const took = (start: number) => `${((Date.now() - start) / 1000).toFixed(1)}초`;

async function main(): Promise<void> {
  console.log('');
  console.log(`  ANC 리조트 — 어댑터 검증 (${RESORT})`);
  console.log('  ──────────────────────────────────────────────');
  console.log(`  노드 ${NODE_ID} · 달력 ${MONTH} · 체크인 ${CHECKIN} · ${NIGHTS}박`);
  if (!process.env.SESSION_KEY) {
    console.log('  ⚠ SESSION_KEY 가 없어 세션을 저장하지 않습니다 (매번 로그인).');
  }
  console.log('  ──────────────────────────────────────────────');

  const node = (await getNode(NODE_ID)) as Node | null;
  if (!node) throw new Error(`노드를 찾을 수 없습니다: ${NODE_ID}. Firestore 에 기본정보가 있는지 확인하세요.`);
  const ref = Object.entries(node.siteRef ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`\n  대상: ${node.name} (${ref})`);

  const ctx = await getContext(RESORT, HEADED);

  // ── 1. 세션 ────────────────────────────────────────────────────────────
  const beforeLogins = await getLoginCount(RESORT);
  let s = Date.now();
  await adapter.ensureSession(ctx);
  const afterLogins = await getLoginCount(RESORT);
  console.log(`\n  [1] 세션 확보 ${took(s)}`);
  console.log(afterLogins > beforeLogins
    ? `      새로 로그인했습니다 (오늘 ${afterLogins}회)`
    : `      로그인 없이 세션 복원 ✅ (오늘 ${afterLogins}회)`);

  // ── 2. 달력 ────────────────────────────────────────────────────────────
  s = Date.now();
  const cal = await adapter.getCalendar(ctx, node, MONTH);
  const counts = Object.values(cal.days).reduce<Record<string, number>>((a, v) => ({ ...a, [v]: (a[v] ?? 0) + 1 }), {});
  console.log(`\n  [2] 달력 ${MONTH} — ${took(s)}`);
  console.log(`      ${Object.keys(cal.days).length}일 · ${JSON.stringify(counts)}`);
  const sample = Object.entries(cal.days).slice(0, 7).map(([d, v]) => `${d.slice(8)}일:${v}`).join(' ');
  console.log(`      ${sample} …`);

  // ── 3. 상세 ────────────────────────────────────────────────────────────
  s = Date.now();
  const detail = await adapter.getDetail(ctx, node, CHECKIN, NIGHTS);
  console.log(`\n  [3] 상세 ${CHECKIN} ${NIGHTS}박 — ${took(s)}  (객실 ${detail.rooms.length}종)`);
  for (const r of detail.rooms.slice(0, 8)) {
    const wait = r.waitCount ? ` 대기${r.waitCount}` : '';
    const basis = r.perNight.length && r.perNight.length !== NIGHTS ? ` ${r.perNight.length}박 기준` : '';
    const price = r.total === null ? '—' : `합계 ${r.total.toLocaleString()}원${basis}`;
    const partial = r.status === 'partial' ? ` · 가능: ${r.availableNights.join(', ') || '없음'}` : '';
    console.log(`      ${r.path.join(' · ')}`);
    console.log(`        ${r.status}${wait}${partial}`);
    console.log(`        ${price}`);
    if (r.perNight.length) {
      console.log(`          ${r.perNight.map((n) => `${n.date.slice(5)} ${n.final.toLocaleString()}원${n.discount ? ` (원가 ${n.base.toLocaleString()} − ${n.discount.toLocaleString()})` : ''}`).join('\n          ')}`);
    }
  }
  if (detail.rooms.length > 8) console.log(`      … 외 ${detail.rooms.length - 8}종`);

  // ── 4. 동별 잔여 ───────────────────────────────────────────────────────
  if (node.parentId && adapter.getBuildingSummary) {
    const parent = await getNode(node.parentId);
    if (parent) {
      s = Date.now();
      const buildings = await adapter.getBuildingSummary!(ctx, parent as Node, CHECKIN, NIGHTS);
      console.log(`\n  [4] ${parent.name} 동별 잔여 (${NIGHTS}박 연박 기준) — ${took(s)}`);
      if (buildings.length === 0) console.log('      동이 하나뿐이라 표시하지 않습니다.');
      for (const b of buildings) console.log(`      ${b.name}: ${b.remaining}실`);
    }
  }

  console.log(`\n  ──────────────────────────────────────────────`);
  console.log(`  전체 ${since()}`);
  console.log(`  ──────────────────────────────────────────────\n`);
}

main()
  .catch((err) => {
    if (err instanceof AdapterError) {
      console.error(`\n  실패 [${err.code}] ${err.message}`);
      if (err.detail) console.error('  상세:', JSON.stringify(err.detail).slice(0, 300));
    } else {
      console.error('\n  실패:', (err as Error).message);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAll();
  });
