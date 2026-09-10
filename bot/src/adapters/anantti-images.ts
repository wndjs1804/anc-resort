/** 공식 예약 페이지의 객실 분기. 근거: docs/anantti-images/manifest.json. */
import sourceRules from './anantti-images.json';
type ImageRule = { property: string; group: string; title: string; image: string; exact: string[]; prefix: string[]; exclude: string[] };
const rules: ImageRule[] = sourceRules;
export const ananttiImageRules = rules;
export function ananttiImageGroup(property: string, code: string): string | null {
  if (!code) return null;
  const rule = rules.find(r => r.property === property && !r.exclude.includes(code)
    && (r.exact.includes(code) || r.prefix.some(prefix => code.startsWith(prefix))));
  return rule ? `anantti-photo-${property}-${rule.group}` : null;
}
