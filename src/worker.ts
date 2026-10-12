interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
}

type Visibility = "public" | "unlisted" | "password" | "private";
type Variant = "thumb" | "preview" | "original";

const enc = new TextEncoder();
const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  folder_id TEXT,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  visibility TEXT NOT NULL DEFAULT 'unlisted' CHECK (visibility IN ('public','unlisted','password','private')),
  password_hash TEXT,
  cover_photo_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  thumb_key TEXT,
  preview_key TEXT,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

let schemaReady = false;
async function ensureColumn(env: Env, table: string, column: string, definition: string) {
  const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all<any>();
  if (!(info.results || []).some((r: any) => r.name === column)) {
    await env.DB.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}
async function ensureSchema(env: Env) {
  if (schemaReady) return;
  await env.DB.exec(BASE_SCHEMA);
  // Upgrade compatibility for the first V2 schema if it already exists.
  await ensureColumn(env, "albums", "folder_id", "folder_id TEXT");
  await ensureColumn(env, "photos", "thumb_key", "thumb_key TEXT");
  await ensureColumn(env, "photos", "preview_key", "preview_key TEXT");
  await ensureColumn(env, "photos", "width", "width INTEGER");
  await ensureColumn(env, "photos", "height", "height INTEGER");
  await env.DB.exec(`
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_albums_folder ON albums(folder_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_albums_visibility ON albums(visibility, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_photos_album ON photos(album_id, sort_order, created_at);
`);
  schemaReady = true;
}

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
function parseCookies(request: Request) {
  const out: Record<string, string> = {};
  for (const pair of (request.headers.get("cookie") || "").split(";")) {
    const i = pair.indexOf("=");
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}
function b64url(bytes: ArrayBuffer | Uint8Array) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decodeB64url(s: string) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const raw = atob(s);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
}
async function signedToken(secret: string, subject: string, ttlSeconds: number) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = `${subject}.${exp}`;
  return `${body}.${await hmac(secret, body)}`;
}
async function verifyToken(secret: string, token: string | undefined, subject: string) {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== subject) return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  return (await hmac(secret, `${parts[0]}.${parts[1]}`)) === parts[2];
}
function requireSecrets(env: Env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) throw new Error("Cloudflare secrets ADMIN_PASSWORD / SESSION_SECRET 尚未配置");
}
async function isAdmin(request: Request, env: Env) {
  if (!env.SESSION_SECRET) return false;
  return verifyToken(env.SESSION_SECRET, parseCookies(request).zhuzhu_admin, "admin");
}
async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 180000 }, key, 256);
  return `${b64url(salt)}:${b64url(bits)}`;
}
async function verifyPassword(password: string, stored: string | null) {
  if (!stored) return false;
  const [saltText, hashText] = stored.split(":");
  if (!saltText || !hashText) return false;
  const salt = decodeB64url(saltText);
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 180000 }, key, 256));
  const expected = decodeB64url(hashText);
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
  return diff === 0;
}
function safeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map(x => x.trim()).filter(Boolean).slice(0, 30);
}
function safeName(value: unknown, fallback = "未命名") {
  return String(value || fallback).trim().slice(0, 120) || fallback;
}
function safeExt(name: string, contentType: string) {
  const ext = (name.split(".").pop() || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (ext && ext.length <= 8) return ext;
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}
async function albumAccessAllowed(request: Request, env: Env, album: any) {
  if (await isAdmin(request, env)) return true;
  if (album.visibility === "public" || album.visibility === "unlisted") return true;
  if (album.visibility === "private") return false;
  if (album.visibility === "password" && env.SESSION_SECRET) {
    const cookie = parseCookies(request)[`album_${album.id}`];
    return verifyToken(env.SESSION_SECRET, cookie, `album:${album.id}`);
  }
  return false;
}
async function folderDepth(env: Env, id: string | null | undefined) {
  if (!id) return 0;
  let depth = 0;
  let current: string | null = id;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) throw new Error("文件夹层级异常");
    seen.add(current);
    const f = await env.DB.prepare("SELECT parent_id FROM folders WHERE id=?").bind(current).first<any>();
    if (!f) throw new Error("文件夹不存在");
    depth += 1;
    current = f.parent_id || null;
    if (depth > 2) throw new Error("当前版本最多支持两级文件夹");
  }
  return depth;
}
async function folderBreadcrumb(env: Env, folderId: string | null) {
  const result: any[] = [];
  let current = folderId;
  while (current) {
    const f = await env.DB.prepare("SELECT id,name,parent_id FROM folders WHERE id=?").bind(current).first<any>();
    if (!f) break;
    result.unshift({ id: f.id, name: f.name });
    current = f.parent_id || null;
  }
  return result;
}
async function findOrCreateFolder(env: Env, name: string, parentId: string | null) {
  const found = parentId
    ? await env.DB.prepare("SELECT id FROM folders WHERE parent_id=? AND name=? LIMIT 1").bind(parentId, name).first<any>()
    : await env.DB.prepare("SELECT id FROM folders WHERE parent_id IS NULL AND name=? LIMIT 1").bind(name).first<any>();
  if (found) return found.id as string;
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO folders (id,name,parent_id) VALUES (?,?,?)").bind(id, name, parentId).run();
  return id;
}
async function listPhotos(env: Env, albumId: string) {
  const r = await env.DB.prepare("SELECT id,original_name,content_type,size_bytes,width,height,sort_order,thumb_key,preview_key FROM photos WHERE album_id=? ORDER BY sort_order,created_at").bind(albumId).all<any>();
  return (r.results || []).map((p: any) => ({
    id: p.id,
    name: p.original_name,
    contentType: p.content_type,
    size: Number(p.size_bytes || 0),
    width: p.width,
    height: p.height,
    order: p.sort_order,
    thumbUrl: `/api/media/${p.id}?variant=thumb`,
    previewUrl: `/api/media/${p.id}?variant=preview`,
    originalUrl: `/api/media/${p.id}?variant=original`,
  }));
}
async function albumSummary(env: Env, a: any) {
  const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM photos WHERE album_id=?").bind(a.id).first<any>();
  return {
    ...a,
    tags: JSON.parse(a.tags || "[]"),
    photoCount: Number(count?.c || 0),
    coverUrl: a.cover_photo_id ? `/api/media/${a.cover_photo_id}?variant=thumb` : null,
  };
}

async function api(request: Request, env: Env, url: URL) {
  await ensureSchema(env);
  const path = url.pathname;
  const admin = await isAdmin(request, env);

  if (path === "/api/system/status" && request.method === "GET") {
    return json({ configured: Boolean(env.ADMIN_PASSWORD && env.SESSION_SECRET), admin });
  }
  if (path === "/api/admin/login" && request.method === "POST") {
    requireSecrets(env);
    const body = await request.json() as any;
    if (typeof body.password !== "string" || body.password !== env.ADMIN_PASSWORD) return json({ error: "管理员密码不正确" }, 401);
    const token = await signedToken(env.SESSION_SECRET!, "admin", 60 * 60 * 24 * 14);
    return json({ ok: true }, 200, { "set-cookie": `zhuzhu_admin=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1209600` });
  }
  if (path === "/api/admin/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": "zhuzhu_admin=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" });
  }

  if (path === "/api/albums" && request.method === "GET") {
    const scope = url.searchParams.get("scope");
    const rows = scope === "public" || !admin
      ? await env.DB.prepare("SELECT * FROM albums WHERE visibility='public' ORDER BY created_at DESC").all<any>()
      : await env.DB.prepare("SELECT * FROM albums ORDER BY created_at DESC").all<any>();
    const albums = [];
    for (const a of rows.results || []) albums.push(await albumSummary(env, a));
    return json({ albums, admin });
  }

  if (path === "/api/library" && request.method === "GET") {
    if (!admin) return json({ error: "请先登录管理员" }, 401);
    const fr = await env.DB.prepare("SELECT * FROM folders ORDER BY sort_order,name,created_at").all<any>();
    const ar = await env.DB.prepare("SELECT * FROM albums ORDER BY created_at DESC").all<any>();
    const albums = [];
    for (const a of ar.results || []) albums.push(await albumSummary(env, a));
    return json({ folders: fr.results || [], albums });
  }

  if (path === "/api/folders" && request.method === "POST") {
    if (!admin) return json({ error: "请先登录管理员" }, 401);
    const b = await request.json() as any;
    const name = safeName(b.name, "新建文件夹");
    const parentId = b.parentId ? String(b.parentId) : null;
    const parentDepth = await folderDepth(env, parentId);
    if (parentDepth >= 2) return json({ error: "当前版本最多支持两级文件夹" }, 400);
    const id = await findOrCreateFolder(env, name, parentId);
    return json({ id });
  }

  if (path === "/api/import/structure" && request.method === "POST") {
    if (!admin) return json({ error: "请先登录管理员" }, 401);
    const b = await request.json() as any;
    const baseFolderId = b.baseFolderId ? String(b.baseFolderId) : null;
    const baseDepth = await folderDepth(env, baseFolderId);
    const items = Array.isArray(b.items) ? b.items.slice(0, 1000) : [];
    const map: Record<string, string> = {};
    for (const raw of items) {
      const key = String(raw.key || "");
      if (!key) continue;
      const folderNames = (Array.isArray(raw.folderNames) ? raw.folderNames : []).map((x: unknown) => safeName(x)).slice(0, 2 - baseDepth);
      let parentId = baseFolderId;
      for (const n of folderNames) parentId = await findOrCreateFolder(env, n, parentId);
      const albumTitle = safeName(raw.albumTitle, "导入图册");
      const existing = parentId
        ? await env.DB.prepare("SELECT id FROM albums WHERE folder_id=? AND title=? LIMIT 1").bind(parentId, albumTitle).first<any>()
        : await env.DB.prepare("SELECT id FROM albums WHERE folder_id IS NULL AND title=? LIMIT 1").bind(albumTitle).first<any>();
      let albumId = existing?.id as string | undefined;
      if (!albumId) {
        albumId = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO albums (id,folder_id,title,visibility) VALUES (?,?,?,'unlisted')").bind(albumId, parentId, albumTitle).run();
      }
      map[key] = albumId;
    }
    return json({ map });
  }

  if (path === "/api/albums" && request.method === "POST") {
    if (!admin) return json({ error: "请先登录管理员" }, 401);
    const b = await request.json() as any;
    const title = safeName(b.title, "");
    if (!title) return json({ error: "请输入图册名称" }, 400);
    const folderId = b.folderId ? String(b.folderId) : null;
    if (folderId) await folderDepth(env, folderId);
    const visibility: Visibility = ["public", "unlisted", "password", "private"].includes(b.visibility) ? b.visibility : "unlisted";
    const pwd = visibility === "password" && b.password ? await hashPassword(String(b.password)) : null;
    if (visibility === "password" && !pwd) return json({ error: "口令图册必须设置访问口令" }, 400);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO albums (id,folder_id,title,subtitle,description,tags,visibility,password_hash) VALUES (?,?,?,?,?,?,?,?)")
      .bind(id, folderId, title, String(b.subtitle || "").slice(0, 180), String(b.description || "").slice(0, 5000), JSON.stringify(safeTags(b.tags)), visibility, pwd).run();
    return json({ id });
  }

  const albumMatch = path.match(/^\/api\/albums\/([^/]+)$/);
  if (albumMatch && request.method === "GET") {
    const id = decodeURIComponent(albumMatch[1]);
    const album = await env.DB.prepare("SELECT * FROM albums WHERE id=?").bind(id).first<any>();
    if (!album) return json({ error: "图册不存在" }, 404);
    if (!(await albumAccessAllowed(request, env, album))) {
      if (album.visibility === "password") return json({ error: "PASSWORD_REQUIRED", title: album.title }, 401);
      return json({ error: "该图册为私密内容" }, 403);
    }
    const breadcrumb = admin ? await folderBreadcrumb(env, album.folder_id || null) : [];
    return json({ album: { ...album, tags: JSON.parse(album.tags || "[]"), photos: await listPhotos(env, id), breadcrumb }, admin });
  }

  const accessMatch = path.match(/^\/api\/albums\/([^/]+)\/access$/);
  if (accessMatch && request.method === "POST") {
    requireSecrets(env);
    const id = decodeURIComponent(accessMatch[1]);
    const album = await env.DB.prepare("SELECT id,title,visibility,password_hash FROM albums WHERE id=?").bind(id).first<any>();
    if (!album || album.visibility !== "password") return json({ error: "图册不存在" }, 404);
    const b = await request.json() as any;
    if (!(await verifyPassword(String(b.password || ""), album.password_hash))) return json({ error: "访问口令不正确" }, 403);
    const token = await signedToken(env.SESSION_SECRET!, `album:${id}`, 60 * 60 * 24 * 7);
    return json({ ok: true }, 200, { "set-cookie": `album_${id}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800` });
  }

  const visibilityMatch = path.match(/^\/api\/albums\/([^/]+)\/visibility$/);
  if (visibilityMatch && request.method === "POST") {
    if (!admin) return json({ error: "请先登录管理员" }, 401);
    const id = decodeURIComponent(visibilityMatch[1]);
    const album = await env.DB.prepare("SELECT id,password_hash FROM albums WHERE id=?").bind(id).first<any>();
    if (!album) return json({ error: "图册不存在" }, 404);
    const b = await request.json() as any;
    const visibility: Visibility = ["public", "unlisted", "password", "private"].includes(b.visibility) ? b.visibility : "unlisted";
    let pwd: string | null = null;
    if (visibility === "password") {
      if (b.password) pwd = await hashPassword(String(b.password));
      else if (album.password_hash) pwd = album.password_hash;
      else return json({ error: "请设置访问口令" }, 400);
    }
    await env.DB.prepare("UPDATE albums SET visibility=?,password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(visibility, pwd, id).run();
    return json({ ok: true });
  }

  const coverMatch = path.match(/^\/api\/albums\/([^/]+)\/cover$/);
  if (coverMatch && request.method === "POST") {
    if (!admin) return json({ error: "请先登录管理员" }, 401);
    const id = decodeURIComponent(coverMatch[1]);
    const b = await request.json() as any;
    const photoId = String(b.photoId || "");
    const p = await env.DB.prepare("SELECT id FROM photos WHERE id=? AND album_id=?").bind(photoId, id).first<any>();
    if (!p) return json({ error: "照片不属于该图册" }, 400);
    await env.DB.prepare("UPDATE albums SET cover_photo_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(photoId, id).run();
    return json({ ok: true });
  }

  const uploadMatch = path.match(/^\/api\/albums\/([^/]+)\/photos$/);
  if (uploadMatch && request.method === "POST") {
    if (!admin) return json({ error: "请先登录管理员" }, 401);
    const albumId = decodeURIComponent(uploadMatch[1]);
    const album = await env.DB.prepare("SELECT id,cover_photo_id FROM albums WHERE id=?").bind(albumId).first<any>();
    if (!album) return json({ error: "图册不存在" }, 404);
    const contentType = request.headers.get("content-type") || "application/octet-stream";
    if (!contentType.startsWith("image/")) return json({ error: "当前仅支持图片文件" }, 400);
    const size = Number(request.headers.get("content-length") || 0);
    if (size > 100 * 1024 * 1024) return json({ error: "单张图片不能超过 100MB" }, 413);
    const originalName = decodeURIComponent(request.headers.get("x-file-name") || "photo.jpg").slice(0, 240);
    const width = Number(request.headers.get("x-width") || 0) || null;
    const height = Number(request.headers.get("x-height") || 0) || null;
    const id = crypto.randomUUID();
    const key = `original/${albumId}/${id}.${safeExt(originalName, contentType)}`;
    await env.PHOTOS.put(key, request.body, { httpMetadata: { contentType } });
    const ord = await env.DB.prepare("SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM photos WHERE album_id=?").bind(albumId).first<any>();
    await env.DB.prepare("INSERT INTO photos (id,album_id,storage_key,original_name,content_type,size_bytes,width,height,sort_order) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(id, albumId, key, originalName, contentType, size, width, height, Number(ord?.n || 0)).run();
    if (!album.cover_photo_id) await env.DB.prepare("UPDATE albums SET cover_photo_id=? WHERE id=?").bind(id, albumId).run();
    return json({ id });
  }

  const variantMatch = path.match(/^\/api\/photos\/([^/]+)\/variant\/(thumb|preview)$/);
  if (variantMatch && request.method === "POST") {
    if (!admin) return json({ error: "请先登录管理员" }, 401);
    const id = decodeURIComponent(variantMatch[1]);
    const variant = variantMatch[2] as "thumb" | "preview";
    const photo = await env.DB.prepare("SELECT id,album_id FROM photos WHERE id=?").bind(id).first<any>();
    if (!photo) return json({ error: "照片不存在" }, 404);
    const contentType = request.headers.get("content-type") || "image/webp";
    if (!contentType.startsWith("image/")) return json({ error: "缩略图格式错误" }, 400);
    const ext = contentType === "image/png" ? "png" : contentType === "image/jpeg" ? "jpg" : "webp";
    const key = `derived/${photo.album_id}/${id}-${variant}.${ext}`;
    await env.PHOTOS.put(key, request.body, { httpMetadata: { contentType } });
    const col = variant === "thumb" ? "thumb_key" : "preview_key";
    await env.DB.prepare(`UPDATE photos SET ${col}=? WHERE id=?`).bind(key, id).run();
    return json({ ok: true });
  }

  if (path === "/api/photos/bulk-delete" && request.method === "POST") {
    if (!admin) return json({ error: "请先登录管理员" }, 401);
    const b = await request.json() as any;
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).slice(0, 200);
    let deleted = 0;
    for (const id of ids) {
      const p = await env.DB.prepare("SELECT id,album_id,storage_key,thumb_key,preview_key FROM photos WHERE id=?").bind(id).first<any>();
      if (!p) continue;
      for (const key of [p.storage_key, p.thumb_key, p.preview_key].filter(Boolean)) await env.PHOTOS.delete(key);
      await env.DB.prepare("DELETE FROM photos WHERE id=?").bind(id).run();
      const a = await env.DB.prepare("SELECT cover_photo_id FROM albums WHERE id=?").bind(p.album_id).first<any>();
      if (a?.cover_photo_id === id) {
        const next = await env.DB.prepare("SELECT id FROM photos WHERE album_id=? ORDER BY sort_order,created_at LIMIT 1").bind(p.album_id).first<any>();
        await env.DB.prepare("UPDATE albums SET cover_photo_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(next?.id || null, p.album_id).run();
      }
      deleted += 1;
    }
    return json({ ok: true, deleted });
  }

  const mediaMatch = path.match(/^\/api\/media\/([^/]+)$/);
  if (mediaMatch && request.method === "GET") {
    const id = decodeURIComponent(mediaMatch[1]);
    const variant = (url.searchParams.get("variant") || "preview") as Variant;
    const p = await env.DB.prepare(`SELECT p.storage_key,p.thumb_key,p.preview_key,p.content_type,a.id AS id,a.visibility,a.password_hash FROM photos p JOIN albums a ON a.id=p.album_id WHERE p.id=?`).bind(id).first<any>();
    if (!p) return new Response("Not found", { status: 404 });
    if (!(await albumAccessAllowed(request, env, p))) return new Response("Forbidden", { status: 403 });
    const key = variant === "thumb" ? (p.thumb_key || p.preview_key || p.storage_key) : variant === "original" ? p.storage_key : (p.preview_key || p.storage_key);
    const object = await env.PHOTOS.get(key);
    if (!object) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "private, max-age=86400");
    headers.set("vary", "Cookie");
    return new Response(object.body, { headers });
  }

  return json({ error: "API not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (error: any) {
      console.error(error);
      return url.pathname.startsWith("/api/")
        ? json({ error: error?.message || "服务器错误" }, 500)
        : new Response("Server error", { status: 500 });
    }
  },
};
