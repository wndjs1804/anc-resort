/**
 * 한화 기본정보 수집
 *
 *   npm run seed:hanwha -- --dry-run
 *   npm run seed:hanwha
 *
 * 숙소 목록을 사이트에서 직접 읽어 Firestore 에 넣는다.
 * 한 사업장(BRCH_CD)에 위치(LOC_CD)가 여럿인 곳이 있어 "숙소 > 동" 2단으로 만든다.
 * (객실 이름·정원은 조회할 때 응답에 함께 오므로 미리 저장하지 않는다)
 */

import { closeAll, getContext } from '../src/browser.ts';
import { hanwhaAdapter } from '../src/adapters/hanwha.ts';
import { PROJECT_ID, writeNodes, writeResort, type NodeDoc } from '../src/store.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const HEADED = process.argv.includes('--headed');
const RESORT_ID = 'hanwha';

const EXECUTE = 'https://booking.hanwharesort.co.kr/rst/cmn/doExecute.mvc';
const PLACES_INTF = 'TFO00HBSITSCTM0160';

type Place = { BRCH_CD?: string; LOC_CD?: string; LOC_NM?: string; BRCH_NM?: string; BRCH_ADDR?: string };

async function main(): Promise<void> {
  console.log('');
  console.log('  한화 기본정보 수집');
  console.log('  ──────────────────────────────────────────────');
  console.log(`  대상: Firestore 프로젝트 ${PROJECT_ID}${DRY_RUN ? ' (dry-run)' : ''}`);

  const ctx = await getContext(RESORT_ID, HEADED);
  await hanwhaAdapter.ensureSession(ctx);
  console.log('  로그인 확인됨');

  // 고객번호는 어댑터가 이미 알아냈다. 같은 방식으로 한 번 더 얻기 위해 예약 화면 요청을 그대로 흉내 낸다.
  const res = await ctx.request.fetch(EXECUTE, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      referer: 'https://booking.hanwharesort.co.kr/rst/rrs/0010/serviceM00.mvc',
    },
    data: `ds=${encodeURIComponent(JSON.stringify({
      ds_search: [{ CUST_NO: '', HOTEL_RESORT_DIV: '' }],
      serviceInfo: { INTF_ID: PLACES_INTF, RECV_SVC_CD: PLACES_INTF.replace(/^TFO00/, '') },
    }))}`,
  });
  const places = (((await res.json()) as { ds?: { Data?: { ds_result?: Place[] } } }).ds?.Data?.ds_result) ?? [];
  if (places.length === 0) throw new Error('숙소 목록이 비어 있습니다.');

  // 사업장(BRCH) 단위로 묶는다
  const byBrch = new Map<string, Place[]>();
  for (const p of places) {
    if (!p.BRCH_CD || !p.LOC_CD) continue;
    const list = byBrch.get(p.BRCH_CD) ?? [];
    list.push(p);
    byBrch.set(p.BRCH_CD, list);
  }

  const nodes: NodeDoc[] = [];
  let order = 0;
  for (const [brchCd, list] of byBrch) {
    const brchNm = (list[0].BRCH_NM || list[0].LOC_NM || brchCd).trim();
    const propertyId = `${RESORT_ID}-place-${brchCd}`;
    nodes.push({
      id: propertyId, resortId: RESORT_ID, parentId: null, level: 'property',
      name: brchNm, order: order++, bookable: false,
      siteRef: { brchCd, addr: (list[0].BRCH_ADDR || '').trim() }, active: true,
    });
    list.forEach((p, i) => {
      nodes.push({
        id: `${RESORT_ID}-loc-${p.LOC_CD}`, resortId: RESORT_ID, parentId: propertyId, level: 'building',
        name: (p.LOC_NM || brchNm).trim(), order: i, bookable: true,
        siteRef: { brchCd, locCd: p.LOC_CD }, active: true,
      });
    });
  }

  console.log(`\n  숙소 ${byBrch.size}곳 · 위치 ${places.length}곳`);
  for (const [brchCd, list] of byBrch) {
    console.log(`   · ${(list[0].BRCH_NM || list[0].LOC_NM || brchCd).trim()}`);
    for (const p of list) console.log(`       - ${p.LOC_NM} (LOC_CD=${p.LOC_CD})`);
  }

  if (DRY_RUN) {
    console.log('\n  dry-run 이라 저장하지 않았습니다.\n');
    return;
  }
  await writeResort(RESORT_ID, '한화');
  const n = await writeNodes(nodes);
  console.log('  ──────────────────────────────────────────────');
  console.log(`  저장 완료: 노드 ${n}개\n`);
}

main()
  .catch((e) => {
    console.error('\n  실패:', (e as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => { await closeAll(); });
