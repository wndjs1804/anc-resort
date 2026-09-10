import assert from 'node:assert/strict';
import test from 'node:test';

import { koreanPublicHolidays } from '../src/holidays.ts';

test('2026 공식 월력요항과 선거일을 반영한다', () => {
  const days = koreanPublicHolidays(2026);
  assert.equal(days['2026-02-16'], '설날 연휴');
  assert.equal(days['2026-02-17'], '설날');
  assert.equal(days['2026-02-18'], '설날 연휴');
  assert.equal(days['2026-06-03'], '제9회 전국동시지방선거');
  assert.equal(days['2026-09-24'], '추석 연휴');
  assert.equal(days['2026-09-25'], '추석');
  assert.equal(days['2026-09-26'], '추석 연휴');
  assert.equal(days['2026-09-23'], undefined);
});

test('추석 연휴 시작일을 당일로 오인하지 않고 새 공휴일도 보완한다', () => {
  const days2027 = koreanPublicHolidays(2027);
  assert.equal(days2027['2027-05-01'], '노동절');
  assert.equal(days2027['2027-09-14'], '추석 연휴');
  assert.equal(days2027['2027-09-15'], '추석');
  assert.equal(days2027['2027-09-16'], '추석 연휴');

  const days2028 = koreanPublicHolidays(2028);
  assert.equal(days2028['2028-10-02'], '추석 연휴');
  assert.match(days2028['2028-10-03'], /추석/);
  assert.match(days2028['2028-10-04'], /추석/);
});
