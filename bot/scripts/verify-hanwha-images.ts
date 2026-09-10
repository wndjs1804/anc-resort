/** 한화 객실 문서 및 실제 Storage 이미지 응답을 읽기 전용 검증한다. 토큰은 출력하지 않는다. */
import { readFile } from 'node:fs/promises';
import { getDb } from '../src/store.ts';
const manifest=JSON.parse(await readFile(new URL('../docs/hanwha-images/manifest.json',import.meta.url),'utf8'));
const plaza=JSON.parse(await readFile(new URL('../docs/hanwha-images/plaza-mapping.json',import.meta.url),'utf8'));
const expected=manifest.places.flatMap((p:{locCd:string;rooms:Array<{code:string}>})=>p.rooms.map(r=>({id:`hanwha-${p.locCd}-${r.code}`,nodeId:`hanwha-loc-${p.locCd}`})));
for(const m of plaza.mappings)expected.push({id:`hanwha-3901-${m.code}`,nodeId:'hanwha-loc-3901'});
const db=getDb();const urls=new Set<string>();
for(const target of expected){
 const data=(await db.collection('rooms').doc(target.id).get()).data();
 if(data?.nodeId!==target.nodeId||!data?.images?.length)throw Error(`사진 연결 누락: ${target.id}`);
 for(const url of data.images)urls.add(url);
}
let next=0;const list=[...urls];
await Promise.all(Array.from({length:4},async()=>{
 while(next<list.length){
  const index=next++;
  const response=await fetch(list[index],{method:'HEAD',signal:AbortSignal.timeout(25000)});
  if(!response.ok||!response.headers.get('content-type')?.startsWith('image/')) throw Error(`Storage 이미지 검증 실패: ${index}`);
 }
}));
console.log(`PASS: 한화 ${expected.length}개 객실 연결, 이미지 ${list.length}개 응답 정상`);
