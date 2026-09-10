/** 공개 객실안내에서 요청한 객실의 갤러리만 추출한다. */
export function parseHanwhaGallery(html: string, pageUrl: string, roomCode: string): string[] {
  const selected = /domSelectBox\.val\(["']([^"']+)["']\)/.exec(html)?.[1];
  if (selected !== roomCode) throw Error('요청한 객실과 페이지 선택 코드 불일치');
  const gallery = /<!-- \(s\) \.rs_gallery[\s\S]*?<!-- \(e\) \.rs_gallery/.exec(html)?.[0];
  if (!gallery) throw Error('객실 갤러리 없음');
  const urls = [...gallery.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(m=>new URL(m[1].replaceAll('&amp;','&'),pageUrl).href);
  if (!urls.length) throw Error('객실 사진 없음');
  if (urls.some(url=> !url.startsWith('https://18db057190b78dc7.kinxzone.com/upfiles/resort/room/'))) throw Error('미확인 사진 출처');
  return [...new Set(urls)];
}
