import assert from 'node:assert/strict';
import { ananttiImageGroup, ananttiImageRules } from '../src/adapters/anantti-images.ts';
assert.equal(ananttiImageRules.length,39);
for (const rule of ananttiImageRules) {
  for (const code of [...rule.exact,...rule.prefix.map(p=>p+'TEST')]) {
    if (!rule.exclude.includes(code)) assert.equal(ananttiImageGroup(rule.property,code),`anantti-photo-${rule.property}-${rule.group}`);
  }
}
assert.equal(ananttiImageGroup('cove','SSS'),'anantti-photo-cove-royalDiv');
assert.equal(ananttiImageGroup('cove','SSA'),'anantti-photo-cove-seaSideDiv');
assert.equal(ananttiImageGroup('village','CDH'),'anantti-photo-village-dupDiv');
assert.equal(ananttiImageGroup('ganm','5010010041'),'anantti-photo-ganm-SDiv');
assert.equal(ananttiImageGroup('jeju','CDH'),null);
assert.equal(ananttiImageGroup('village',''),null);
assert.equal(ananttiImageGroup('village','NEW_ROOM'),null);
console.log('PASS: 39개 그룹, 숙소 분리, 코드 접두사 및 제외 조건, 미확인 코드');
