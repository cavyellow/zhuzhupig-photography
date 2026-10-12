const app = document.querySelector('#app');
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v = '') => String(v).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

const state = {
  configured: true,
  admin: false,
  publicAlbums: [],
  library: { folders: [], albums: [] },
  query: '',
  tag: '全部',
  libraryView: localStorage.getItem('libraryView') || 'cards',
  galleryView: localStorage.getItem('galleryView') || (matchMedia('(max-width: 640px)').matches ? 'thumb' : 'masonry'),
};

async function api(path, options = {}) {
  const r = await fetch(path, options);
  const contentType = r.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await r.json() : await r.text();
  if (!r.ok) {
    const err = new Error(body?.error || body || `请求失败 (${r.status})`);
    err.data = body;
    throw err;
  }
  return body;
}

async function init() {
  try {
    const status = await api('/api/system/status');
    state.configured = status.configured;
    state.admin = status.admin;
  } catch {}
  route();
}

window.addEventListener('popstate', route);
function go(path) {
  history.pushState({}, '', path);
  route();
}

async function route() {
  const path = location.pathname;
  const album = path.match(/^\/album\/([^/]+)$/);
  const folder = path.match(/^\/folder\/([^/]+)$/);
  if (album) return renderAlbum(decodeURIComponent(album[1]));
  if (folder) return renderManage(decodeURIComponent(folder[1]));
  if (path === '/manage') return renderManage(null);
  return renderHome();
}

async function loadPublicAlbums() {
  const r = await api('/api/albums?scope=public');
  state.publicAlbums = r.albums || [];
  state.admin = Boolean(r.admin);
}
async function loadLibrary() {
  const r = await api('/api/library');
  state.library = { folders: r.folders || [], albums: r.albums || [] };
}

function topbar({ management = false } = {}) {
  return `<header class="topbar">
    <button class="brand brand-button" data-home>
      <span class="avatar">Z</span><span><b>ZhuzhuPig · Photography</b><small>${management ? '私人云图库 · 管理后台' : '私人摄影档案馆'}</small></span>
    </button>
    <div class="top-actions">
      ${state.admin ? `<button class="pill" data-manage>${management ? '公开主页' : '管理云图库'}</button><button class="pill compact" data-logout>退出</button>` : `<button class="pill" data-login>创作者登录</button>`}
      ${management ? '' : `<button class="primary" data-create>＋ 新建图册</button>`}
    </div>
  </header>`;
}
function bindTopbar(root = document) {
  $$('[data-home]', root).forEach(x => x.onclick = () => go('/'));
  $$('[data-manage]', root).forEach(x => x.onclick = () => location.pathname.startsWith('/manage') || location.pathname.startsWith('/folder/') ? go('/') : go('/manage'));
  $$('[data-login]', root).forEach(x => x.onclick = showLogin);
  $$('[data-logout]', root).forEach(x => x.onclick = logout);
  $$('[data-create]', root).forEach(x => x.onclick = () => state.admin ? showCreateAlbum(null) : showLogin());
}

async function renderHome() {
  app.innerHTML = `<div class="shell">${topbar()}<div class="page-loading">正在读取作品…</div></div>`;
  bindTopbar(app);
  try { await loadPublicAlbums(); } catch (e) { return renderError(e.message); }
  const albums = state.publicAlbums;
  const tags = new Map([['全部', albums.length]]);
  albums.forEach(a => (a.tags || []).forEach(t => tags.set(t, (tags.get(t) || 0) + 1)));
  const filtered = albums.filter(a => (state.tag === '全部' || (a.tags || []).includes(state.tag)) && `${a.title}${a.subtitle}${(a.tags || []).join('')}`.toLowerCase().includes(state.query.toLowerCase()));
  const total = albums.reduce((n, a) => n + Number(a.photoCount || 0), 0);

  app.innerHTML = `<div class="shell">
    ${topbar()}
    ${state.configured ? '' : `<div class="setup">Cloudflare 管理员 Secret 尚未配置：需要 <b>ADMIN_PASSWORD</b> 与 <b>SESSION_SECRET</b>。</div>`}
    <section class="hero">
      <div><span class="eyebrow">ZHUZHUPIG / PHOTO ARCHIVE</span><h1>把照片收好，<br>把作品分享出去。</h1></div>
      <div class="hero-side"><p>这是 ZhuzhuPig 的公开摄影展厅。只有明确设为“公开展示”的图册会出现在这里；仅链接、口令与私密图册不会在公开主页暴露。</p><div class="meta"><span>${albums.length} 个公开图册</span><span>${total} 张作品</span><span>${state.admin ? '管理员已登录' : '访客模式'}</span></div></div>
    </section>
    <section class="section">
      <div class="section-head"><div><span>PUBLIC ALBUMS</span><h2>公开作品</h2></div><div class="toolbar"><input class="search" id="search" placeholder="搜索公开作品" value="${esc(state.query)}"></div></div>
      <div class="tags">${[...tags].map(([t, n]) => `<button class="tag ${state.tag === t ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}<i>${n}</i></button>`).join('')}</div>
      ${filtered.length ? `<div class="album-grid public-grid">${filtered.map(a => publicAlbumCard(a)).join('')}</div>` : `<div class="empty">暂时没有符合条件的公开图册。</div>`}
    </section>
    <footer class="public-footer"><b>ZhuzhuPig</b><span>Private archive · Public portfolio</span></footer>
  </div>`;
  bindTopbar(app);
  $('#search').oninput = e => { state.query = e.target.value; renderHome(); };
  $$('[data-tag]').forEach(b => b.onclick = () => { state.tag = b.dataset.tag; renderHome(); });
  $$('[data-open-album]').forEach(x => x.onclick = () => go('/album/' + x.dataset.openAlbum));
  $$('[data-share-album]').forEach(x => x.onclick = e => { e.stopPropagation(); shareAlbum(x.dataset.shareAlbum); });
}

function publicAlbumCard(a) {
  return `<article class="album-card" data-open-album="${a.id}">
    <div class="album-cover">${a.coverUrl ? `<img src="${a.coverUrl}" alt="${esc(a.title)}" loading="lazy">` : `<div class="cover-placeholder"></div>`}<div class="cover-shade"></div><div class="cover-copy"><b>${esc(a.title)}</b><small>${a.photoCount || 0} 张照片</small></div><button class="cover-share" data-share-album="${a.id}" aria-label="分享">↗</button></div>
    <div class="album-info"><div><h3>${esc(a.title)}</h3><p>${esc(a.subtitle || 'Photography series')}</p></div><span class="arrow">→</span></div>
  </article>`;
}

async function renderManage(folderId = null) {
  if (!state.admin) {
    app.innerHTML = `<div class="shell">${topbar({ management: true })}<div class="empty standalone"><h2>这是私人云图库</h2><p>登录后才能管理文件夹、图册和原始照片。</p><button class="primary" id="manageLogin">创作者登录</button></div></div>`;
    bindTopbar(app);
    $('#manageLogin').onclick = showLogin;
    return;
  }
  app.innerHTML = `<div class="shell">${topbar({ management: true })}<div class="page-loading">正在读取云图库…</div></div>`;
  bindTopbar(app);
  try { await loadLibrary(); } catch (e) { if (e.data?.error) state.admin = false; return renderManage(folderId); }

  const folders = state.library.folders;
  const albums = state.library.albums;
  const current = folderId ? folders.find(f => f.id === folderId) : null;
  if (folderId && !current) return renderError('文件夹不存在');
  const depth = current ? folderDepthLocal(current.id) : 0;
  const children = folders.filter(f => (f.parent_id || null) === (folderId || null));
  const directAlbums = albums.filter(a => (a.folder_id || null) === (folderId || null));
  const q = state.query.toLowerCase();
  const visibleFolders = children.filter(f => f.name.toLowerCase().includes(q));
  const visibleAlbums = directAlbums.filter(a => `${a.title}${a.subtitle}${(a.tags || []).join('')}`.toLowerCase().includes(q));
  const breadcrumb = folderBreadcrumbLocal(folderId);

  app.innerHTML = `<div class="shell manage-shell">
    ${topbar({ management: true })}
    <div class="manage-layout">
      <aside class="sidebar">
        <div class="sidebar-title"><span>LIBRARY</span><b>云图库</b></div>
        <button class="side-root ${!folderId ? 'active' : ''}" data-folder-root>全部文件</button>
        <div class="folder-tree">${folderTreeHtml()}</div>
        <div class="sidebar-note">最多两级文件夹。图册放在任意层级下，照片只属于图册。</div>
      </aside>
      <main class="library-main">
        <div class="library-head">
          <div><div class="breadcrumbs"><button data-folder-root>云图库</button>${breadcrumb.map(f => `<span>/</span><button data-folder="${f.id}">${esc(f.name)}</button>`).join('')}</div><h1>${current ? esc(current.name) : '全部文件'}</h1><p>${children.length} 个子文件夹 · ${directAlbums.length} 个图册</p></div>
          <div class="library-actions">
            ${depth < 2 ? `<button class="pill" id="newFolder">＋ 文件夹</button>` : ''}
            <button class="pill" id="importFolder">⇧ 导入文件夹</button>
            <button class="primary" id="newAlbum">＋ 图册</button>
          </div>
        </div>
        <div class="library-toolbar">
          <input class="search wide" id="librarySearch" placeholder="搜索当前目录" value="${esc(state.query)}">
          <div class="segmented"><button data-library-view="cards" class="${state.libraryView === 'cards' ? 'active' : ''}">缩略图</button><button data-library-view="list" class="${state.libraryView === 'list' ? 'active' : ''}">列表</button></div>
        </div>
        ${visibleFolders.length ? `<section class="library-section"><div class="mini-head">文件夹</div><div class="folder-grid ${state.libraryView === 'list' ? 'list-view' : ''}">${visibleFolders.map(folderCard).join('')}</div></section>` : ''}
        <section class="library-section"><div class="mini-head">图册</div>${visibleAlbums.length ? `<div class="album-grid manage-grid ${state.libraryView === 'list' ? 'list-view' : ''}">${visibleAlbums.map(manageAlbumCard).join('')}</div>` : `<div class="empty compact-empty">当前目录没有图册。</div>`}</section>
      </main>
    </div>
  </div>`;

  bindTopbar(app);
  $$('[data-folder-root]').forEach(b => b.onclick = () => { state.query = ''; go('/manage'); });
  $$('[data-folder]').forEach(b => b.onclick = () => { state.query = ''; go('/folder/' + b.dataset.folder); });
  $$('[data-open-album]').forEach(b => b.onclick = () => go('/album/' + b.dataset.openAlbum));
  $$('[data-share-album]').forEach(b => b.onclick = e => { e.stopPropagation(); shareAlbum(b.dataset.shareAlbum); });
  $$('[data-perm]').forEach(s => { s.onclick = e => e.stopPropagation(); s.onchange = e => { e.stopPropagation(); changePermission(s.dataset.perm, s.value, () => renderManage(folderId)); }; });
  $('#librarySearch').oninput = e => { state.query = e.target.value; renderManage(folderId); };
  $$('[data-library-view]').forEach(b => b.onclick = () => { state.libraryView = b.dataset.libraryView; localStorage.setItem('libraryView', state.libraryView); renderManage(folderId); });
  $('#newFolder')?.addEventListener('click', () => showCreateFolder(folderId, () => renderManage(folderId)));
  $('#newAlbum').onclick = () => showCreateAlbum(folderId, () => renderManage(folderId));
  $('#importFolder').onclick = () => showFolderImport(folderId, () => renderManage(folderId));
}

function folderDepthLocal(id) {
  let depth = 0, cur = id;
  while (cur) { const f = state.library.folders.find(x => x.id === cur); if (!f) break; depth++; cur = f.parent_id || null; if (depth > 5) break; }
  return depth;
}
function folderBreadcrumbLocal(id) {
  const out = []; let cur = id;
  while (cur) { const f = state.library.folders.find(x => x.id === cur); if (!f) break; out.unshift(f); cur = f.parent_id || null; }
  return out;
}
function folderTreeHtml(parent = null, level = 0) {
  return state.library.folders.filter(f => (f.parent_id || null) === parent).map(f => `<div class="tree-node level-${level}"><button data-folder="${f.id}" class="${location.pathname === '/folder/' + f.id ? 'active' : ''}"><span>⌁</span>${esc(f.name)}</button>${level < 1 ? folderTreeHtml(f.id, level + 1) : ''}</div>`).join('');
}
function descendantAlbumCovers(folderId) {
  const ids = new Set([folderId]);
  let changed = true;
  while (changed) { changed = false; state.library.folders.forEach(f => { if (f.parent_id && ids.has(f.parent_id) && !ids.has(f.id)) { ids.add(f.id); changed = true; } }); }
  return state.library.albums.filter(a => a.folder_id && ids.has(a.folder_id) && a.coverUrl).slice(0, 4).map(a => a.coverUrl);
}
function folderCard(f) {
  const covers = descendantAlbumCovers(f.id);
  const directChildren = state.library.folders.filter(x => x.parent_id === f.id).length;
  const albumCount = state.library.albums.filter(a => a.folder_id === f.id).length;
  return `<article class="folder-card" data-folder="${f.id}"><div class="folder-preview">${covers.length ? covers.map(u => `<img src="${u}" loading="lazy" alt="">`).join('') : `<div class="folder-empty-icon">⌁</div>`}</div><div class="folder-info"><div><h3>${esc(f.name)}</h3><p>${directChildren ? `${directChildren} 个子文件夹 · ` : ''}${albumCount} 个图册</p></div><span>→</span></div></article>`;
}
function manageAlbumCard(a) {
  return `<article class="album-card manage-card" data-open-album="${a.id}">
    <div class="album-cover">${a.coverUrl ? `<img src="${a.coverUrl}" alt="${esc(a.title)}" loading="lazy">` : `<div class="cover-placeholder"></div>`}<div class="cover-shade"></div><div class="cover-copy"><b>${esc(a.title)}</b><small>${a.photoCount || 0} 张照片</small></div><span class="status">${visibilityLabel(a.visibility)}</span></div>
    <div class="album-info"><div><h3>${esc(a.title)}</h3><p>${esc(a.subtitle || '摄影图册')}</p><select class="permission" data-perm="${a.id}"><option value="private" ${a.visibility === 'private' ? 'selected' : ''}>完全私密</option><option value="unlisted" ${a.visibility === 'unlisted' ? 'selected' : ''}>仅链接</option><option value="password" ${a.visibility === 'password' ? 'selected' : ''}>访问口令</option><option value="public" ${a.visibility === 'public' ? 'selected' : ''}>公开展示</option></select></div><button class="iconbtn" data-share-album="${a.id}">分享</button></div>
  </article>`;
}
function visibilityLabel(v) { return ({ public: '公开', unlisted: '仅链接', password: '口令', private: '私密' })[v] || v; }

function overlay(content, small = false, extra = '') {
  const d = document.createElement('div');
  d.className = 'overlay';
  d.innerHTML = `<div class="modal ${small ? 'small' : ''} ${extra}">${content}</div>`;
  d.addEventListener('mousedown', e => { if (e.target === d) d.remove(); });
  document.body.appendChild(d);
  return d;
}
function showLogin() {
  const d = overlay(`<div class="modal-head"><div><span class="eyebrow">CREATOR ACCESS</span><h2>ZhuzhuPig 管理登录</h2></div><button class="close">×</button></div><div class="modal-body"><div class="form"><label>管理员密码<input id="adminPwd" type="password" autocomplete="current-password" placeholder="ADMIN_PASSWORD"></label><div class="message" id="loginMsg"></div><button class="action" id="doLogin">进入私人云图库</button></div></div>`, true);
  $('.close', d).onclick = () => d.remove();
  $('#doLogin', d).onclick = async () => { const msg = $('#loginMsg', d); msg.textContent = '正在登录…'; try { await api('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('#adminPwd', d).value }) }); state.admin = true; d.remove(); go('/manage'); } catch (e) { msg.textContent = e.message; } };
}
async function logout() { await api('/api/admin/logout', { method: 'POST' }); state.admin = false; state.library = { folders: [], albums: [] }; go('/'); }

function showCreateFolder(parentId, done) {
  const d = overlay(`<div class="modal-head"><div><span class="eyebrow">NEW FOLDER</span><h2>新建文件夹</h2></div><button class="close">×</button></div><div class="modal-body"><div class="form"><label>文件夹名称<input id="folderName" placeholder="例如：2026 / 客户项目 / 旅行"></label><div class="message" id="folderMsg"></div><button class="action" id="saveFolder">创建文件夹</button></div></div>`, true);
  $('.close', d).onclick = () => d.remove();
  $('#saveFolder', d).onclick = async () => { const msg = $('#folderMsg', d); try { msg.textContent = '正在创建…'; await api('/api/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('#folderName', d).value, parentId }) }); d.remove(); await done?.(); } catch (e) { msg.textContent = e.message; } };
}
function showCreateAlbum(folderId, done) {
  const d = overlay(`<div class="modal-head"><div><span class="eyebrow">NEW ALBUM</span><h2>新建图册</h2></div><button class="close">×</button></div><div class="modal-body"><div class="form two-col-form"><label>图册名称<input id="title" placeholder="例如：东京夜行"></label><label>拍摄信息<input id="subtitle" placeholder="Tokyo · 2026 / Leica Q3"></label><label class="span-2">标签<input id="tags" placeholder="街头, 夜景, 城市"></label><label>访问权限<select id="visibility"><option value="unlisted" selected>仅链接可见（推荐）</option><option value="password">访问口令</option><option value="private">完全私密</option><option value="public">公开展示</option></select></label><label id="pwdLabel" class="hidden">访问口令<input id="albumPwd" type="password" placeholder="设置图册口令"></label><label class="span-2">作品说明<textarea id="desc" rows="4" placeholder="这组照片的故事……"></textarea></label><div class="message span-2" id="createMsg"></div><button class="action span-2" id="create">创建空图册</button></div></div>`);
  $('.close', d).onclick = () => d.remove();
  $('#visibility', d).onchange = e => $('#pwdLabel', d).classList.toggle('hidden', e.target.value !== 'password');
  $('#create', d).onclick = async () => { const msg = $('#createMsg', d); try { msg.textContent = '正在创建…'; const body = { folderId, title: $('#title', d).value, subtitle: $('#subtitle', d).value, description: $('#desc', d).value, tags: $('#tags', d).value.split(/[,，]/).map(x => x.trim()).filter(Boolean), visibility: $('#visibility', d).value, password: $('#albumPwd', d)?.value }; const r = await api('/api/albums', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); d.remove(); if (done) await done(); else go('/album/' + r.id); } catch (e) { msg.textContent = e.message; } };
}

function showFolderImport(baseFolderId, done) {
  let selected = [];
  const d = overlay(`<div class="modal-head"><div><span class="eyebrow">FOLDER IMPORT</span><h2>批量导入电脑文件夹</h2></div><button class="close">×</button></div><div class="modal-body import-body"><button class="folder-drop" id="pickFolder"><b>选择整个文件夹</b><span>自动读取目录结构，最多保留两级管理文件夹，叶子目录生成图册。</span><small id="importSummary">建议在电脑 Chrome / Edge / Safari 中使用</small></button><input class="hidden" id="folderInput" type="file" webkitdirectory directory multiple accept="image/*"><div id="importPlan"></div><div class="message" id="importMsg"></div><button class="action" id="startImport" disabled>开始批量导入</button></div>`);
  $('.close', d).onclick = () => d.remove();
  $('#pickFolder', d).onclick = () => $('#folderInput', d).click();
  $('#folderInput', d).onchange = e => {
    selected = [...e.target.files].filter(f => f.type.startsWith('image/'));
    const plan = buildImportPlan(selected, baseFolderId);
    $('#importSummary', d).textContent = `识别到 ${selected.length} 张图片 · ${plan.groups.length} 个图册`;
    $('#importPlan', d).innerHTML = plan.groups.length ? `<div class="plan-list">${plan.groups.slice(0, 30).map(g => `<div><b>${esc([...g.folderNames, g.albumTitle].join(' / '))}</b><span>${g.files.length} 张</span></div>`).join('')}${plan.groups.length > 30 ? `<small>另有 ${plan.groups.length - 30} 个图册…</small>` : ''}</div>` : '';
    $('#startImport', d).disabled = !selected.length;
  };
  $('#startImport', d).onclick = async () => {
    const btn = $('#startImport', d), msg = $('#importMsg', d); btn.disabled = true;
    try {
      const plan = buildImportPlan(selected, baseFolderId);
      msg.textContent = '正在建立文件夹和图册…';
      const structure = await api('/api/import/structure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseFolderId, items: plan.groups.map(g => ({ key: g.key, folderNames: g.folderNames, albumTitle: g.albumTitle })) }) });
      let doneCount = 0;
      for (const group of plan.groups) {
        const albumId = structure.map[group.key];
        for (const file of group.files) {
          msg.textContent = `正在导入 ${doneCount + 1}/${selected.length} · ${file.name}`;
          await uploadPhoto(file, albumId);
          doneCount++;
        }
      }
      msg.textContent = `完成：已导入 ${doneCount} 张照片`;
      setTimeout(async () => { d.remove(); await done?.(); }, 500);
    } catch (e) { msg.textContent = e.message; btn.disabled = false; }
  };
}

function buildImportPlan(files, baseFolderId) {
  if (!files.length) return { groups: [] };
  const baseDepth = baseFolderId ? folderDepthLocal(baseFolderId) : 0;
  const availableFolderLevels = Math.max(0, 2 - baseDepth);
  const map = new Map();
  for (const file of files) {
    const rawPath = file.webkitRelativePath || file.name;
    const parts = rawPath.split('/').filter(Boolean);
    const rootName = parts.length > 1 ? parts[0] : '导入图册';
    const dirs = parts.slice(1, -1);
    let folderNames = [], albumTitle;
    if (!dirs.length) {
      albumTitle = rootName;
    } else {
      const folderCount = Math.min(Math.max(0, dirs.length - 1), availableFolderLevels);
      folderNames = dirs.slice(0, folderCount);
      albumTitle = dirs.slice(folderCount).join(' / ') || rootName;
    }
    const key = `${folderNames.join('>')}::${albumTitle}`;
    if (!map.has(key)) map.set(key, { key, folderNames, albumTitle, files: [] });
    map.get(key).files.push(file);
  }
  return { groups: [...map.values()] };
}

async function uploadPhoto(file, albumId, progress) {
  const variants = await makeVariants(file).catch(() => null);
  const width = variants?.width || 0, height = variants?.height || 0;
  progress?.('正在上传原图');
  const r = await api(`/api/albums/${albumId}/photos`, { method: 'POST', headers: { 'content-type': file.type || 'image/jpeg', 'x-file-name': encodeURIComponent(file.name), 'x-width': String(width), 'x-height': String(height) }, body: file });
  if (variants?.preview) {
    progress?.('正在生成预览图');
    await api(`/api/photos/${r.id}/variant/preview`, { method: 'POST', headers: { 'content-type': variants.preview.type || 'image/webp' }, body: variants.preview });
  }
  if (variants?.thumb) {
    progress?.('正在生成缩略图');
    await api(`/api/photos/${r.id}/variant/thumb`, { method: 'POST', headers: { 'content-type': variants.thumb.type || 'image/webp' }, body: variants.thumb });
  }
  return r.id;
}
async function makeVariants(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const render = (maxSide, quality) => new Promise((resolve, reject) => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d', { alpha: true });
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法生成预览图')), 'image/webp', quality);
    });
    const [thumb, preview] = await Promise.all([render(640, .78), render(2200, .86)]);
    return { thumb, preview, width: img.naturalWidth, height: img.naturalHeight };
  } finally { URL.revokeObjectURL(url); }
}

async function changePermission(id, visibility, done) {
  let password;
  if (visibility === 'password') { password = prompt('请设置新的访问口令'); if (!password) return done?.(); }
  try { await api(`/api/albums/${id}/visibility`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visibility, password }) }); await done?.(); } catch (e) { alert(e.message); await done?.(); }
}
async function shareAlbum(id) {
  const url = location.origin + '/album/' + id;
  try { if (navigator.share) await navigator.share({ title: 'ZhuzhuPig Photography', url }); else { await navigator.clipboard.writeText(url); toast('分享链接已复制'); } } catch {}
}
function toast(text) {
  const n = document.createElement('div'); n.className = 'toast'; n.textContent = text; document.body.appendChild(n); setTimeout(() => n.classList.add('show'), 20); setTimeout(() => { n.classList.remove('show'); setTimeout(() => n.remove(), 250); }, 1800);
}

async function renderAlbum(id) {
  app.innerHTML = `<div class="album-page"><div class="lockbox">正在打开图册…</div></div>`;
  try { const r = await api('/api/albums/' + encodeURIComponent(id)); state.admin = Boolean(r.admin); showAlbum(r.album); }
  catch (e) {
    if (e.data?.error === 'PASSWORD_REQUIRED' || e.message === 'PASSWORD_REQUIRED') return showPassword(id, e.data?.title || '私密图册');
    app.innerHTML = `<div class="album-page"><div class="lockbox"><h1>无法打开图册</h1><p>${esc(e.message)}</p><button class="action" id="back">返回主页</button></div></div>`;
    $('#back').onclick = () => go('/');
  }
}
function showPassword(id, title) {
  app.innerHTML = `<div class="album-page"><div class="lockbox"><span class="eyebrow">PRIVATE ALBUM</span><h1>${esc(title)}</h1><p>这组作品需要访问口令。</p><input id="accessPwd" type="password" placeholder="访问口令"><div class="message" id="accessMsg"></div><button class="action" id="unlock">进入图册</button><p><button class="pill" id="back">返回主页</button></p></div></div>`;
  $('#back').onclick = () => go('/');
  $('#unlock').onclick = async () => { try { await api(`/api/albums/${id}/access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('#accessPwd').value }) }); renderAlbum(id); } catch (e) { $('#accessMsg').textContent = e.message; } };
}
function showAlbum(a) {
  let photos = [...a.photos];
  let selected = new Set();
  let selectMode = false;
  const galleryMode = state.galleryView;
  app.innerHTML = `<main class="album-page">
    <header class="album-top"><button id="back">← 返回</button><div class="album-top-actions">${state.admin ? `<button id="manageHome">云图库</button>` : ''}<button id="share">分享图册</button></div></header>
    <section class="album-intro"><div><span class="eyebrow">${esc(a.subtitle || 'PHOTOGRAPHY SERIES')}</span><h1>${esc(a.title)}</h1></div><div><p>${esc(a.description || 'ZhuzhuPig Photography')}</p><div class="album-tags">${(a.tags || []).map(t => `<b>#${esc(t)}</b>`).join('')}</div></div></section>
    <div class="gallery-bar"><div class="gallery-count">${photos.length} 张照片</div><div class="gallery-tools">
      <div class="segmented dark-segment"><button data-gallery-view="masonry" class="${galleryMode === 'masonry' ? 'active' : ''}">流式</button><button data-gallery-view="thumb" class="${galleryMode === 'thumb' ? 'active' : ''}">缩略图</button><button data-gallery-view="full" class="${galleryMode === 'full' ? 'active' : ''}">大图</button></div>
      <select id="photoSort" class="dark-select"><option value="manual">默认顺序</option><option value="name">文件名</option><option value="newest">倒序</option></select>
      ${state.admin ? `<button class="dark-pill" id="addPhotos">＋ 上传照片</button><button class="dark-pill" id="selectPhotos">选择</button><button class="danger-pill hidden" id="deletePhotos">删除 <span id="selectedCount">0</span></button><input class="hidden" id="albumFiles" type="file" multiple accept="image/*">` : ''}
    </div></div>
    <section class="photos ${galleryMode}" id="photoGrid">${photoGridHtml(photos, a, galleryMode, selectMode, selected)}</section>
  </main>`;
  $('#back').onclick = () => history.length > 1 ? history.back() : go('/');
  $('#share').onclick = () => shareAlbum(a.id);
  $('#manageHome')?.addEventListener('click', () => a.breadcrumb?.length ? go('/folder/' + a.breadcrumb[a.breadcrumb.length - 1].id) : go('/manage'));
  bindGalleryHandlers();

  function bindGalleryHandlers() {
    $$('[data-gallery-view]').forEach(b => b.onclick = () => { state.galleryView = b.dataset.galleryView; localStorage.setItem('galleryView', state.galleryView); applyGalleryView(); });
    $('#photoSort').onchange = e => { const v = e.target.value; if (v === 'name') photos.sort((x, y) => x.name.localeCompare(y.name, 'zh')); else if (v === 'newest') photos.reverse(); else photos = [...a.photos]; refreshGrid(); };
    $$('#photoGrid [data-photo]').forEach((fig, index) => fig.onclick = e => {
      if (selectMode) { e.preventDefault(); togglePhoto(fig.dataset.photo); return; }
      openLightbox(a, photos, index);
    });
    if ($('#addPhotos')) $('#addPhotos').onclick = () => $('#albumFiles').click();
    if ($('#albumFiles')) $('#albumFiles').onchange = async e => {
      const files = [...e.target.files].filter(f => f.type.startsWith('image/'));
      if (!files.length) return;
      const modal = overlay(`<div class="modal-head"><div><span class="eyebrow">UPLOAD</span><h2>正在上传照片</h2></div></div><div class="modal-body"><div class="upload-progress"><div class="progress-track"><i id="progressBar"></i></div><b id="uploadStatus">准备上传…</b></div></div>`, true);
      try { for (let i = 0; i < files.length; i++) { $('#progressBar', modal).style.width = `${Math.round((i / files.length) * 100)}%`; $('#uploadStatus', modal).textContent = `${i + 1}/${files.length} · ${files[i].name}`; await uploadPhoto(files[i], a.id); } $('#progressBar', modal).style.width = '100%'; modal.remove(); renderAlbum(a.id); } catch (err) { $('#uploadStatus', modal).textContent = err.message; }
    };
    if ($('#selectPhotos')) $('#selectPhotos').onclick = () => { selectMode = !selectMode; selected.clear(); $('#selectPhotos').textContent = selectMode ? '取消选择' : '选择'; $('#deletePhotos').classList.toggle('hidden', !selectMode); refreshGrid(); };
    if ($('#deletePhotos')) $('#deletePhotos').onclick = async () => { if (!selected.size) return; if (!confirm(`确定删除选中的 ${selected.size} 张照片吗？原图与缩略图都会从 R2 删除。`)) return; await api('/api/photos/bulk-delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [...selected] }) }); renderAlbum(a.id); };
  }
  function togglePhoto(id) { selected.has(id) ? selected.delete(id) : selected.add(id); const el = $(`[data-photo="${CSS.escape(id)}"]`); el?.classList.toggle('selected', selected.has(id)); $('#selectedCount').textContent = selected.size; }
  function refreshGrid() { const g = $('#photoGrid'); g.innerHTML = photoGridHtml(photos, a, state.galleryView, selectMode, selected); bindGalleryHandlers(); }
  function applyGalleryView() {
    const g = $('#photoGrid'); g.className = `photos ${state.galleryView}`;
    $$('[data-gallery-view]').forEach(b => b.classList.toggle('active', b.dataset.galleryView === state.galleryView));
    $$('img[data-thumb]', g).forEach(img => { img.src = state.galleryView === 'thumb' ? img.dataset.thumb : img.dataset.preview; });
  }
}
function photoGridHtml(photos, album, mode, selectMode, selected) {
  if (!photos.length) return `<div class="empty dark-empty">这个图册还没有照片。${state.admin ? ' 点击“上传照片”开始添加。' : ''}</div>`;
  return photos.map((p, i) => `<figure class="photo-item ${selected.has(p.id) ? 'selected' : ''}" data-photo="${p.id}" data-index="${i}"><div class="photo-frame">${selectMode ? `<span class="photo-check">${selected.has(p.id) ? '✓' : ''}</span>` : ''}<img src="${mode === 'thumb' ? p.thumbUrl : p.previewUrl}" data-thumb="${p.thumbUrl}" data-preview="${p.previewUrl}" alt="${esc(album.title)} ${i + 1}" loading="lazy" style="${mode !== 'thumb' && p.width && p.height ? `aspect-ratio:${p.width}/${p.height}` : ''}"></div>${state.admin ? `<figcaption>${esc(p.name)}</figcaption>` : ''}</figure>`).join('');
}
function openLightbox(album, photos, startIndex) {
  let index = startIndex;
  const d = document.createElement('div'); d.className = 'lightbox'; document.body.appendChild(d);
  const render = () => { const p = photos[index]; d.innerHTML = `<div class="lightbox-top"><span>${index + 1} / ${photos.length}</span><div>${state.admin ? `<button id="setCover">设为封面</button>` : ''}<button id="closeLightbox">关闭</button></div></div><button class="light-nav prev" id="prev">‹</button><div class="light-image"><img src="${p.originalUrl}" alt="${esc(p.name)}"><small>${esc(p.name)}</small></div><button class="light-nav next" id="next">›</button>`; $('#closeLightbox', d).onclick = close; $('#prev', d).onclick = () => { index = (index - 1 + photos.length) % photos.length; render(); }; $('#next', d).onclick = () => { index = (index + 1) % photos.length; render(); }; $('#setCover', d)?.addEventListener('click', async () => { await api(`/api/albums/${album.id}/cover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ photoId: p.id }) }); toast('已设为图册封面'); }); };
  const key = e => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') $('#prev', d)?.click(); if (e.key === 'ArrowRight') $('#next', d)?.click(); };
  function close() { window.removeEventListener('keydown', key); d.remove(); }
  window.addEventListener('keydown', key); render();
}

function renderError(message) { app.innerHTML = `<div class="shell">${topbar()}<div class="empty standalone"><h2>加载失败</h2><p>${esc(message)}</p><button class="primary" id="retry">重试</button></div></div>`; bindTopbar(app); $('#retry').onclick = route; }

init();
