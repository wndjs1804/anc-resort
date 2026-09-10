import Holidays from 'date-holidays';

/**
 * 대한민국 공휴일을 yyyy-mm-dd → 표시명으로 만든다.
 *
 * date-holidays의 KR 추석 규칙은 `음력 8월 14일 P3D`라서 반환된 date가
 * 추석 당일이 아니라 연휴 첫날이다. 설날은 반대로 당일을 반환하므로
 * 두 명절을 같은 ±1 방식으로 확장하면 추석이 하루 앞당겨진다.
 */
export function koreanPublicHolidays(year: number): Record<string, string> {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new Error('연도가 올바르지 않습니다.');
  const calendar = new Holidays('KR');
  const days = new Map<string, string>();
  const add = (date: string, name: string) => days.set(date, days.has(date) ? `${days.get(date)} · ${name}` : name);
  const move = (date: string, offset: number) => {
    const value = new Date(`${date}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() + offset);
    return value.toISOString().slice(0, 10);
  };

  for (const holiday of calendar.getHolidays(year).filter((item) => item.type === 'public')) {
    const date = holiday.date.slice(0, 10);
    if (holiday.name === '추석') {
      add(date, '추석 연휴');
      add(move(date, 1), '추석');
      add(move(date, 2), '추석 연휴');
    } else if (holiday.name === '설날') {
      add(move(date, -1), '설날 연휴');
      add(date, '설날');
      add(move(date, 1), '설날 연휴');
    } else add(date, holiday.name);
  }

  // 2026.5.11 시행된 관공서공휴일규정: 다음 해부터 노동절이 매년 도래한다.
  if (year >= 2027) add(`${year}-05-01`, '노동절');

  // 공직선거법 제34조의 임기만료 선거일. 확정된 선거만 명시한다.
  const electionDays: Record<number, Record<string, string>> = {
    2026: { '2026-06-03': '제9회 전국동시지방선거' },
  };
  for (const [date, name] of Object.entries(electionDays[year] ?? {})) add(date, name);

  return Object.fromEntries([...days].sort(([a], [b]) => a.localeCompare(b)));
}
