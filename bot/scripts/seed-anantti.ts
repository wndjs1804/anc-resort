/**
 * 아난티 기본정보 수집
 *
 *   npm run seed:anantti -- --dry-run
 *   npm run seed:anantti
 *
 * 아난티는 숙소 아래 '동' 이 없고, 객실의 정원·이름이 조회할 때마다 응답에 함께 오므로
 * 미리 저장해 둘 것은 **숙소 목록뿐**이다. 로그인도 필요 없다.
 * (사진 경로는 별도로 확인됨. 현재 이 스크립트는 사진을 수집하지 않는다 — docs/anantti-images/README.md)
 */

import { PROPERTIES } from '../src/adapters/anantti.ts';
import { PROJECT_ID, writeNodes, writeResort, type NodeDoc } from '../src/store.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const RESORT_ID = 'anantti';

async function main(): Promise<void> {
  const nodes: NodeDoc[] = Object.values(PROPERTIES).map((p, i) => ({
    id: `${RESORT_ID}-place-${p.path}`,
    resortId: RESORT_ID,
    parentId: null,
    level: 'property',
    name: p.name,
    order: i,
    bookable: true,          // 아난티는 숙소가 곧 조회 단위다
    siteRef: { property: p.path, bsns: p.bsns, roomApi: p.roomApi, shape: p.shape },
    active: true,
  }));

  console.log('');
  console.log('  아난티 기본정보 수집');
  console.log('  ──────────────────────────────────────────────');
  console.log(`  대상: Firestore 프로젝트 ${PROJECT_ID}${DRY_RUN ? ' (dry-run)' : ''}`);
  for (const n of nodes) console.log(`   · ${n.name}  (bsns=${(n.siteRef as { bsns: string }).bsns})`);

  if (DRY_RUN) {
    console.log('  dry-run 이라 저장하지 않았습니다.\n');
    return;
  }
  await writeResort(RESORT_ID, '아난티');
  const n = await writeNodes(nodes);
  console.log('  ──────────────────────────────────────────────');
  console.log(`  저장 완료: 숙소 ${n}곳\n`);
}

main().catch((e) => {
  console.error('\n  실패:', (e as Error).message);
  process.exit(1);
});
