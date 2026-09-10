/** 플라자 예약 응답의 객실 코드·이름만 확인한다. 인증정보·가격은 저장하지 않는다. */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { getContext, closeAll } from '../src/browser.ts';
import { getNode } from '../src/store.ts';
import { hanwhaAdapter } from '../src/adapters/hanwha.ts';
import type { Node } from '../src/adapters/types.ts';
let stage="준비";
async function main(){
 process.env.SESSION_KEY=execFileSync('gcloud',['secrets','versions','access','latest','--secret=session-key','--project=anc-resort'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 for (const [env,secret] of [['HANWHA_ID','hanwha-id'],['HANWHA_PW','hanwha-pw'],['HANWHA_MEMBER_PW','hanwha-member-pw']]) process.env[env]=execFileSync('gcloud',['secrets','versions','access','latest','--secret='+secret,'--project=anc-resort'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const ctx=await getContext('hanwha');
 stage='세션 확인';
 await hanwhaAdapter.ensureSession(ctx);
 const node=await getNode('hanwha-loc-3901');
 if(!node)throw Error('노드 없음');
 const date=new Date();date.setDate(date.getDate()+30);
 const checkin=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
 stage='객실 상세';
 const data=await hanwhaAdapter.getDetail(ctx,node as Node,checkin,1);
 const rooms=data.rooms.map(r=>({id:r.roomId,name:r.name,code:r.siteRef?.roomTypeCd}));
 await writeFile(new URL('../docs/hanwha-images/plaza-rooms.json',import.meta.url),JSON.stringify(rooms,null,2)+'\n');
 console.log(JSON.stringify(rooms));
}
main().catch((e)=>{console.error(`플라자 확인 실패: ${stage} / ${['auth_failed','parse_failed','blocked','maintenance','timeout'].includes(e.code)?e.code:e.name}`);process.exitCode=1;}).finally(closeAll);
