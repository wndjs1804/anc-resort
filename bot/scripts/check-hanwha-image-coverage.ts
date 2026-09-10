/** 기존 저장 조회 결과의 객실 코드와 공개 안내 페이지 코드를 비교한다. 읽기 전용. */
import { readFile, writeFile } from 'node:fs/promises';
import { getDb } from '../src/store.ts';
const source = new URL('../docs/hanwha-images/manifest.json', import.meta.url);
const manifest=JSON.parse(await readFile(source,'utf8'));
const rows=await getDb().collection('details').where('nodeId','>=','hanwha-').where('nodeId','<','hanwha.').select('nodeId','rooms').get();
const output=[];
for(const place of manifest.places) {
 const found=new Map<string,string>();
 for(const doc of rows.docs) {
  const data=doc.data();
  if(data.nodeId!==`hanwha-loc-${place.locCd}`) continue;
  for(const room of data.rooms??[]) {
   const code=room.siteRef?.roomTypeCd;
   if(code) found.set(code,room.name??room.path?.join(' · ')??'');
  }
 }
 const publicCodes=new Set(place.rooms.map((r:{code:string})=>r.code));
 const matched=[...found.keys()].filter(code=>publicCodes.has(code));
 const missing=[...found.entries()].filter(([code])=>!publicCodes.has(code)).map(([code,name])=>({code,name}));
 output.push({locCd:place.locCd,name:place.name,cachedRooms:found.size,matched:matched.length,missing});
 console.log(`${place.name}: 저장 객실 ${found.size}종 / 공식 코드 일치 ${matched.length}종`);
}
await writeFile(new URL('../docs/hanwha-images/coverage.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
