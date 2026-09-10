"""공개 객실안내 페이지의 객실 코드와 대표 갤러리를 조사한다. 로그인·예약 요청 없음."""
import json, re, time
from pathlib import Path
from urllib.request import urlopen
from urllib.parse import urljoin
from html import unescape

BASE = 'https://www.hanwharesort.co.kr'
PLACES = {'0101':'설악 쏘라노','0102':'설악 별관','0401':'용인','0701':'산정호수','0801':'해운대','0901':'대천','1001':'경주 에톤','1002':'경주 담톤','1101':'제주','1601':'평창','2101':'거제 벨버디어','2102':'거제 르 씨엘','2201':'여수 벨메르','2401':'브리드호텔 양양','2601':'마티에 오시리아','3901':'더플라자'}
rows=[]
for loc,name in PLACES.items():
    page=f'{BASE}/irsweb/resort3/resort/'+('plaza/rsa_room.do' if loc=='3901' else 'rs_room.do')+f'?bp_cd={loc}'
    row={'locCd':loc,'name':name,'sourcePage':page}
    try:
        with urlopen(page,timeout=20) as res:
            html=res.read().decode('utf-8',errors='replace')
            row['pageStatus']=res.status
        if re.search(r'비정상적인 접근|접근이 차단|자동입력 방지',html):
            raise RuntimeError('접근 제한 감지: 조사 중단')
        select=re.search(r'<select[^>]*id="sel_rm_cd"[^>]*>(.*?)</select>',html,re.S)
        row['rooms']=[{'code':c,'name':unescape(re.sub('<[^>]+>','',n)).strip()} for c,n in re.findall(r'<option[^>]*value="([^"]+)"[^>]*>(.*?)</option>',select.group(1) if select else '',re.S)]
        selected=re.search(r'domSelectBox\.val\(["\']([^"\']+)',html)
        row['selectedCode']=selected.group(1) if selected else None
        gallery=re.search(r'<!-- \(s\) \.rs_gallery.*?<!-- \(e\) \.rs_gallery',html,re.S)
        row['galleryImages']=list(dict.fromkeys(urljoin(page,unescape(u)) for u in re.findall(r'<img[^>]*src="([^"]+)"',gallery.group(0) if gallery else '')))
        if row['galleryImages']:
            with urlopen(row['galleryImages'][0],timeout=20) as image:
                row['imageStatus']=image.status;row['contentType']=image.headers.get('Content-Type');row['imageBytes']=len(image.read())
        row['externalRoomLinks']=list(dict.fromkeys(unescape(u) for u in re.findall(r'href="(https?://[^"]+)"',html) if any(word in u.lower() for word in ['room','accommodation'])))
        print(name, '객실 코드',len(row['rooms']), '선택',row['selectedCode'],'사진',len(row['galleryImages']),row.get('imageStatus'),flush=True)
    except RuntimeError:
        raise
    except Exception as error:
        row['error']=str(error);print(name,'오류',str(error),flush=True)
    rows.append(row)
    time.sleep(1.2)
out=Path(__file__).resolve().parent.parent/'docs'/'hanwha-images'
out.mkdir(exist_ok=True)
(out/'manifest.json').write_text(json.dumps({'checkedAt':'2026-09-10','places':rows},ensure_ascii=False,indent=2)+'\n')
