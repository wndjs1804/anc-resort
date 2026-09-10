import { notices as defaultNotices, faqs as defaultFaqs } from './portal-content.js';

const BOT_URL = 'https://anc-resort-bot-551643700321.asia-northeast3.run.app';
const boardToken = new URLSearchParams(location.search).get('t') ?? '';
const $ = (id) => document.getElementById(id);
let notices = [...defaultNotices];
let faqs = [...defaultFaqs];
let adminSession = sessionStorage.getItem('ancAdminSession') ?? '';
let editorInlineImages = [];
let editorAttachments = [];

const pages = {
  inquiry: { element: 'inquiryPage', title: '휴양시설 이용조회', description: '회사 휴양시설의 예약 가능 일정과 객실 정보를 확인하세요.' },
  notices: { element: 'noticesPage', title: '공지사항', description: '휴양시설 이용과 관련된 중요한 안내사항을 확인해 주세요.' },
  faq: { element: 'faqPage', title: '자주 묻는 질문', description: '휴양시설 이용 중 자주 문의하시는 내용을 확인해 보세요.' },
};
function route() {
  const key = location.hash.slice(1) in pages ? location.hash.slice(1) : 'inquiry';
  for (const [name, page] of Object.entries(pages)) $(page.element).hidden = name !== key;
  for (const link of document.querySelectorAll('.nav-item')) {
    const active = link.hash === `#${key}`; link.classList.toggle('active', active);
    active ? link.setAttribute('aria-current', 'page') : link.removeAttribute('aria-current');
  }
  $('pageTitle').textContent = pages[key].title;
  if (key === 'inquiry') $('pageTitle').innerHTML = '<span>휴양시설</span> 이용조회';
  $('pageSub').textContent = pages[key].description; document.title = `${pages[key].title} · ACE nanochem`;
}
window.addEventListener('hashchange', route); route();

const api = async (path, options = {}) => {
  const response = await fetch(`${BOT_URL}${path}`, { ...options, headers: { authorization: `Bearer ${boardToken}`, 'content-type': 'application/json', ...(adminSession ? { 'x-admin-session': adminSession } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || data.error || '요청을 처리하지 못했습니다.'), { status: response.status });
  return data;
};
const mergeContent = (defaults, changes, kind) => {
  const map = new Map(defaults.map((item) => [item.id, item]));
  for (const item of changes.filter((entry) => entry.kind === kind)) item.deleted ? map.delete(item.id) : map.set(item.id, item);
  return [...map.values()];
};
async function loadContent() {
  try {
    const { items = [] } = await api('/content');
    notices = mergeContent(defaultNotices, items, 'notice'); faqs = mergeContent(defaultFaqs, items, 'faq');
  } catch { notices = [...defaultNotices]; faqs = [...defaultFaqs]; }
  renderFaq(); renderNotices();
}

const categoryClass = { '결제': 'payment', '이용': 'usage', '기타': 'etc', '중요': 'important', '이벤트': 'payment' };
const badge = (category) => { const span = document.createElement('span'); span.className = `category-badge ${categoryClass[category] ?? ''}`; span.textContent = category; return span; };
function pagination(element, count, current, change) {
  element.replaceChildren(); if (count <= 1) return;
  for (let i = 1; i <= count; i++) { const button = document.createElement('button'); button.type = 'button'; button.className = 'page-button'; button.textContent = i; button.setAttribute('aria-label', `${i}페이지`); if (i === current) button.setAttribute('aria-current', 'page'); button.addEventListener('click', () => change(i)); element.append(button); }
}
const adminButtons = (item, kind) => {
  const box = document.createElement('span'); box.className = 'item-admin';
  const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '수정'; edit.addEventListener('click', (event) => { event.preventDefault(); openEditor(kind, item); });
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger'; remove.textContent = '삭제'; remove.addEventListener('click', async (event) => { event.preventDefault(); if (!confirm('정말 삭제할까요?')) return; await saveContent({ action: 'delete', kind, id: item.id }); });
  box.append(edit, remove); return box;
};
function renderFaq(page = 1) {
  const category = $('faqCategory').value; const keyword = $('faqQuery').value.trim().toLocaleLowerCase('ko');
  const items = faqs.filter((item) => (!category || category === item.category) && `${item.title} ${item.body}`.toLocaleLowerCase('ko').includes(keyword)); $('faqList').replaceChildren();
  for (const [index, item] of items.slice((page - 1) * 8, page * 8).entries()) {
    const details = document.createElement('details'); details.className = 'faq-item'; details.open = page === 1 && index < 2;
    const summary = document.createElement('summary'); summary.append(badge(item.category), document.createTextNode(item.title)); if (adminSession) summary.append(adminButtons(item, 'faq'));
    const answer = document.createElement('p'); answer.className = 'faq-answer'; answer.textContent = item.body; details.append(summary, answer); $('faqList').append(details);
  }
  if (!items.length) { const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '검색 결과가 없습니다. 다른 검색어를 입력해 주세요.'; $('faqList').append(empty); }
  $('faqCount').textContent = `총 ${items.length}건`; pagination($('faqPages'), Math.ceil(items.length / 8), page, renderFaq);
}
function renderNotices(page = 1) {
  const category = $('noticeCategory').value; const keyword = $('noticeQuery').value.trim().toLocaleLowerCase('ko');
  const items = notices.filter((item) => (!category || category === item.category) && `${item.title} ${item.body}`.toLocaleLowerCase('ko').includes(keyword)).sort((a, b) => b.date.localeCompare(a.date)); $('noticeRows').replaceChildren();
  for (const [index, item] of items.slice((page - 1) * 10, page * 10).entries()) {
    const row = document.createElement('tr'); const number = document.createElement('td'); number.textContent = items.length - ((page - 1) * 10 + index); const categoryCell = document.createElement('td'); categoryCell.append(badge(item.category));
    const title = document.createElement('td'); const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = item.title; if (adminSession) summary.append(adminButtons(item, 'notice')); const body = document.createElement('p'); body.textContent = item.body; details.append(summary, body); const inlineImages = item.inlineImages?.length ? item.inlineImages : item.imageUrl ? [{ url: item.imageUrl, name: '첨부 이미지' }] : []; for (const [imageIndex, file] of inlineImages.entries()) { const image = document.createElement('img'); image.className = 'notice-image'; image.src = file.url; image.alt = `${item.title} 내용 이미지 ${imageIndex + 1}`; image.loading = 'lazy'; details.append(image); } if (item.attachments?.length) { const files = document.createElement('ul'); files.className = 'notice-attachments'; for (const file of item.attachments) { const li = document.createElement('li'); const link = document.createElement('a'); link.href = file.url; link.textContent = file.name; link.target = '_blank'; link.rel = 'noopener'; link.setAttribute('download', file.name); li.append(link); files.append(li); } details.append(files); } title.append(details);
    const date = document.createElement('td'); date.textContent = item.date.replaceAll('-', '.'); row.append(number, categoryCell, title, date); $('noticeRows').append(row);
  }
  $('noticeEmpty').hidden = items.length > 0; if (notices.length && !items.length) $('noticeEmpty').textContent = '검색 결과가 없습니다.'; $('noticeCount').textContent = `총 ${items.length}건`; pagination($('noticePages'), Math.ceil(items.length / 10), page, renderNotices);
}

function setAdmin(active) {
  adminSession = active ? adminSession : '';
  if (!active) sessionStorage.removeItem('ancAdminSession');
  document.querySelectorAll('.admin-only').forEach((node) => { node.hidden = !active; });
  $('adminTrigger').title = active ? '더블클릭하면 관리자 모드에서 나갑니다.' : '';
  $('adminTrigger').setAttribute('aria-label', active ? 'ACE nanochem, 관리자 모드 로그아웃' : 'ACE nanochem');
  renderFaq(); renderNotices();
}
$('adminTrigger').addEventListener('dblclick', () => {
  if (adminSession) { setAdmin(false); return; }
  $('adminPassword').value = ''; $('adminLoginError').textContent = ''; $('adminLogin').showModal(); $('adminPassword').focus();
});
$('adminLoginForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const result = await api('/admin/login', { method: 'POST', body: JSON.stringify({ password: $('adminPassword').value }) }); adminSession = result.session; sessionStorage.setItem('ancAdminSession', adminSession); $('adminLogin').close(); setAdmin(true); } catch { $('adminLoginError').textContent = '비밀번호가 맞지 않습니다.'; } });
function openEditor(kind, item = null) {
  $('contentForm').reset(); $('contentKind').value = kind; $('contentId').value = item?.id ?? `${kind}-${Date.now()}`; $('contentEditorTitle').textContent = item ? '내용 수정' : kind === 'notice' ? '공지사항 등록' : '자주 묻는 질문 추가';
  editorInlineImages = item?.inlineImages?.length ? [...item.inlineImages] : item?.imageUrl ? [{ url: item.imageUrl, path: item.imagePath, name: '기존 이미지' }] : []; editorAttachments = [...(item?.attachments ?? [])]; renderEditorFiles();
  const categories = kind === 'notice' ? ['안내', '중요', '이벤트'] : ['예약', '결제', '이용', '기타']; $('contentCategory').replaceChildren(...categories.map((value) => new Option(value, value))); $('contentDateLabel').hidden = kind !== 'notice'; $('contentDate').required = kind === 'notice'; $('contentDate').value = item?.date ?? new Date().toISOString().slice(0, 10); $('contentCategory').value = item?.category ?? categories[0]; $('contentTitle').value = item?.title ?? ''; $('contentBody').value = item?.body ?? ''; $('contentImageField').hidden = kind !== 'notice'; $('contentPasteHint').hidden = kind !== 'notice'; $('contentError').textContent = ''; $('contentEditor').showModal(); $('contentTitle').focus();
}
async function saveContent(payload) { try { await api('/admin/content', { method: 'POST', body: JSON.stringify(payload) }); $('contentEditor').close(); await loadContent(); } catch (error) { if (error.status === 401) { setAdmin(false); $('contentEditor').close(); $('adminLogin').showModal(); } else $('contentError').textContent = error.message; } }
$('addNotice').addEventListener('click', () => openEditor('notice')); $('addFaq').addEventListener('click', () => openEditor('faq')); $('contentCancel').addEventListener('click', () => $('contentEditor').close()); $('contentCancelX').addEventListener('click', () => $('contentEditor').close());
const readFileBase64 = (file) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.')); reader.readAsDataURL(file); });
function renderEditorFiles() { $('contentImageList').replaceChildren(...editorInlineImages.map((file, index) => { const box = document.createElement('div'); box.className = 'content-image-preview'; const image = document.createElement('img'); image.src = file.url || URL.createObjectURL(file.file); image.alt = `내용 이미지 ${index + 1}`; const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '삭제'; remove.addEventListener('click', () => { editorInlineImages.splice(index, 1); renderEditorFiles(); }); box.append(image, remove); return box; })); $('contentAttachmentList').replaceChildren(...editorAttachments.map((file, index) => { const li = document.createElement('li'); li.append(document.createTextNode(file.name)); const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '삭제'; remove.addEventListener('click', () => { editorAttachments.splice(index, 1); renderEditorFiles(); }); li.append(remove); return li; })); }
function addContentImage(file) { if (!file.type.match(/^image\/(png|jpeg|webp)$/)) { $('contentError').textContent = '붙여넣기는 PNG, JPG, WebP 이미지만 지원합니다.'; return false; } if (file.size > 4 * 1024 * 1024) { $('contentError').textContent = '붙여넣는 이미지는 각각 4MB 이하로 등록해 주세요.'; return false; } editorInlineImages.push({ file, name: file.name || `붙여넣은 이미지 ${editorInlineImages.length + 1}.png` }); $('contentError').textContent = ''; renderEditorFiles(); return true; }
$('contentBody').addEventListener('paste', (event) => { if ($('contentKind').value !== 'notice') return; const files = [...event.clipboardData.items].filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean); if (!files.length) return; event.preventDefault(); for (const file of files) addContentImage(file); $('contentImageList').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
$('contentAttachment').addEventListener('change', () => { for (const file of $('contentAttachment').files) { if (file.size > 10 * 1024 * 1024) { $('contentError').textContent = `${file.name}: 파일은 각각 10MB 이하로 등록해 주세요.`; continue; } editorAttachments.push({ file, name: file.name }); } $('contentAttachment').value = ''; renderEditorFiles(); });
async function uploadEditorFile(item, usage) { if (!item.file) return item; const result = await api('/admin/upload', { method: 'POST', body: JSON.stringify({ id: $('contentId').value, usage, name: item.name, contentType: item.file.type || 'application/octet-stream', data: await readFileBase64(item.file) }) }); return result; }
$('contentForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const inlineImages = []; for (const file of editorInlineImages) inlineImages.push(await uploadEditorFile(file, 'inline')); const attachments = []; for (const file of editorAttachments) attachments.push(await uploadEditorFile(file, 'attachment')); await saveContent({ action: 'save', id: $('contentId').value, kind: $('contentKind').value, category: $('contentCategory').value, title: $('contentTitle').value, date: $('contentDate').value, body: $('contentBody').value, inlineImages, attachments }); } catch (error) { $('contentError').textContent = error.message; } });
$('faqSearch').addEventListener('submit', (e) => { e.preventDefault(); renderFaq(); }); $('faqCategory').addEventListener('change', () => renderFaq()); $('noticeSearch').addEventListener('submit', (e) => { e.preventDefault(); renderNotices(); }); $('noticeCategory').addEventListener('change', () => renderNotices());
setAdmin(Boolean(adminSession)); loadContent();
