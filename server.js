const express    = require('express');
const axios      = require('axios');
const path       = require('path');
const fs         = require('fs');
const session    = require('express-session');
const FileStore  = require('session-file-store')(session);
const passport   = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const multer     = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ─── Cloudflare R2 ────────────────────────────────────────────────────────────
const R2_ACCOUNT_ID = process.env.CF_ACCOUNT_ID        || '';
const R2_ACCESS_KEY = process.env.CF_ACCESS_KEY_ID     || '';
const R2_SECRET_KEY = process.env.CF_SECRET_ACCESS_KEY || '';
const R2_BUCKET     = process.env.CF_BUCKET_NAME       || 'zhansaver';
const R2_PUBLIC_URL = (process.env.CF_PUBLIC_URL || '').replace(/\/$/, '');

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
});

async function uploadToR2(buffer, filename, contentType) {
  const key = `uploads/${filename}`;
  console.log(`[R2] Uploading: ${key} (${buffer.length} bytes)`);
  await r2.send(new PutObjectCommand({
    Bucket:       R2_BUCKET,
    Key:          key,
    Body:         buffer,
    ContentType:  contentType || 'image/jpeg',
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  const url = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${key}` : `/r2/${key}`;
  console.log(`[R2] OK: ${url}`);
  return url;
}

const upload       = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const uploadSingle = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ─── Данные ───────────────────────────────────────────────────────────────────
const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSIONS_DIR  = path.join(DATA_DIR, 'sessions');
const CONFIG_FILE   = path.join(DATA_DIR, 'config.json');
const RELEASES_FILE = path.join(DATA_DIR, 'releases.json');
const LINKS_FILE    = path.join(DATA_DIR, 'links.json');
const POSTS_FILE    = path.join(DATA_DIR, 'posts.json');
const IMG_CACHE_DIR = path.join(DATA_DIR, 'imgcache');

[DATA_DIR, SESSIONS_DIR, IMG_CACHE_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function initFile(p, def) { if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(def, null, 2)); }
initFile(CONFIG_FILE, {}); initFile(RELEASES_FILE, []); initFile(LINKS_FILE, []); initFile(POSTS_FILE, []);

function loadConfig()   { try { return JSON.parse(fs.readFileSync(CONFIG_FILE,   'utf8')); } catch { return {}; } }
function loadReleases() { try { return JSON.parse(fs.readFileSync(RELEASES_FILE, 'utf8')); } catch { return []; } }
function loadLinks()    { try { return JSON.parse(fs.readFileSync(LINKS_FILE,    'utf8')); } catch { return []; } }
function loadPosts()    { try { return JSON.parse(fs.readFileSync(POSTS_FILE,    'utf8')); } catch { return []; } }

function saveConfig(data)       { try { fs.writeFileSync(CONFIG_FILE,   JSON.stringify({ ...loadConfig(), ...data }, null, 2)); } catch(e) { console.error('[Config]',   e.message); } }
function saveReleases(releases) { try { fs.writeFileSync(RELEASES_FILE, JSON.stringify(releases, null, 2)); }                  catch(e) { console.error('[Releases]', e.message); } }
function saveLinks(links)       { try { fs.writeFileSync(LINKS_FILE,    JSON.stringify(links,    null, 2)); }                  catch(e) { console.error('[Links]',    e.message); } }
function savePosts(posts)       { try { fs.writeFileSync(POSTS_FILE,    JSON.stringify(posts,    null, 2)); }                  catch(e) { console.error('[Posts]',    e.message); } }

// ─── Session ──────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'zhansaver-secret-2024',
  resave: false,
  saveUninitialized: false,
  store: new FileStore({ path: SESSIONS_DIR, retries: 1, logFn: () => {} }),
  cookie: { maxAge: 14 * 24 * 60 * 60 * 1000 },
}));

// ─── Passport ─────────────────────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
}, (at, rt, profile, done) => done(null, {
  id:    profile.id,
  email: profile.emails?.[0]?.value,
  name:  profile.displayName,
  photo: profile.photos?.[0]?.value,
})));

passport.serializeUser((u, done)   => done(null, u));
passport.deserializeUser((u, done) => done(null, u));
app.use(passport.initialize());
app.use(passport.session());

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Не авторизован' });
  res.redirect('/login');
}

// ─── Login page ───────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>ZHANSAVER</title>
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@700;800&display=swap" rel="stylesheet">
  <style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;background:#000;font-family:'Space Mono',monospace;color:#fff;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:#111;border:1px solid #222;border-radius:20px;padding:52px 40px;width:100%;max-width:400px;text-align:center}.logo{font-family:'Syne',sans-serif;font-weight:800;font-size:2.2rem;letter-spacing:-.04em;margin-bottom:8px}.sub{color:#555;font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;margin-bottom:44px}.btn-google{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;padding:15px 20px;background:#fff;color:#000;border:none;border-radius:12px;font-family:'Syne',sans-serif;font-weight:800;font-size:.95rem;cursor:pointer;text-decoration:none;transition:opacity .15s,transform .1s}.btn-google:hover{opacity:.88}.btn-google:active{opacity:.75;transform:scale(.98)}.btn-google svg{flex-shrink:0;width:20px;height:20px}@media(max-width:480px){.card{padding:36px 24px}.logo{font-size:1.8rem}}</style></head>
  <body><div class="card"><div class="logo">ZHANSAVER</div><div class="sub">Войди чтобы продолжить</div>
  <a class="btn-google" href="/auth/google">
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>Войти через Google</a></div></body></html>`);
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login' }), (req, res) => {
  sseNotify({ type: 'login', user: req.user?.name || req.user?.email || 'Новый пользователь' });
  res.redirect('/');
});
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/login')));
app.get('/api/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user: req.user });
});

// ─── Auth guard ───────────────────────────────────────────────────────────────
app.use(requireAuth);

// ─── R2 прокси (если нет публичного URL) ─────────────────────────────────────
app.get('/r2/uploads/:filename', async (req, res) => {
  try {
    const r = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: `uploads/${req.params.filename}` }));
    res.setHeader('Content-Type',  r.ContentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    r.Body.pipe(res);
  } catch { res.status(404).send('Not found'); }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── SSE ──────────────────────────────────────────────────────────────────────
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 25000);
  sseClients.add(res);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

function sseNotify(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch {} });
}

// ─── Status ───────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const config = loadConfig();
  res.json({ hasCookie: !!getCookie(), siteEnabled: config.siteEnabled !== false, siteMessage: config.siteMessage || { active: false } });
});

// ─── Upload single ────────────────────────────────────────────────────────────
app.post('/api/upload-single', uploadSingle.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  try {
    const ext      = path.extname(req.file.originalname).toLowerCase() || '.jpg';
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    const url      = await uploadToR2(req.file.buffer, filename, req.file.mimetype);
    res.json({ success: true, url });
  } catch (e) { console.error('[Upload-single]', e.message); res.status(500).json({ error: e.message }); }
});

// ─── Upload multiple ──────────────────────────────────────────────────────────
app.post('/api/upload', upload.array('images', 20), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Нет файлов' });
  try {
    const urls = [];
    for (const file of req.files) {
      const ext      = path.extname(file.originalname).toLowerCase() || '.jpg';
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      urls.push(await uploadToR2(file.buffer, filename, file.mimetype));
    }
    res.json({ success: true, urls });
  } catch (e) { console.error('[Upload]', e.message); res.status(500).json({ error: e.message }); }
});

// ─── Proxy ────────────────────────────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const { url, dl } = req.query;
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return res.status(400).send('Invalid URL');
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*', 'Referer': 'https://www.instagram.com/' };
  if (req.headers.range) headers['Range'] = req.headers.range;
  try {
    const r  = await axios.get(url, { headers, responseType: 'stream', timeout: 60000, maxRedirects: 5 });
    const ct = r.headers['content-type'] || 'application/octet-stream';
    const ext = ct.includes('video') || url.includes('.mp4') ? 'mp4' : ct.includes('webp') ? 'webp' : 'jpg';
    res.status(r.status === 206 ? 206 : 200);
    res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', 'bytes');
    if (r.headers['content-length']) res.setHeader('Content-Length', r.headers['content-length']);
    if (r.headers['content-range'])  res.setHeader('Content-Range',  r.headers['content-range']);
    if (dl === '1') res.setHeader('Content-Disposition', `attachment; filename="media_${Date.now()}.${ext}"`);
    else { res.setHeader('Content-Disposition', 'inline'); if (ct.startsWith('image/')) res.setHeader('Cache-Control', 'public, max-age=604800, immutable'); }
    r.data.pipe(res);
  } catch (err) { console.error('[Proxy]', err.message); res.status(500).send(err.message); }
});

// ─── Image cache ──────────────────────────────────────────────────────────────
app.get('/api/imgcache', async (req, res) => {
  const { url } = req.query;
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return res.status(400).send('bad url');
  const hash     = require('crypto').createHash('md5').update(url).digest('hex');
  const ext      = url.includes('.webp') ? '.webp' : url.includes('.png') ? '.png' : '.jpg';
  const filePath = path.join(IMG_CACHE_DIR, hash + ext);
  if (fs.existsSync(filePath)) { res.setHeader('Cache-Control', 'public, max-age=2592000, immutable'); return res.sendFile(filePath); }
  try {
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.instagram.com/' } });
    fs.writeFileSync(filePath, r.data);
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    res.setHeader('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.send(r.data);
  } catch { res.redirect(url); }
});

// ─── Download image → base64 ──────────────────────────────────────────────────
app.get('/api/download-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'No url' });
  try {
    const r    = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)', 'Referer': 'https://www.instagram.com/', 'Accept': 'image/*,*/*' } });
    const mime = r.headers['content-type'] || 'image/jpeg';
    res.json({ base64: `data:${mime};base64,${Buffer.from(r.data).toString('base64')}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Cookie ───────────────────────────────────────────────────────────────────
function getCookie() {
  const env = process.env.COOKIE || '';
  if (env.length > 10) return env;
  const cfg = loadConfig().cookie || '';
  return (cfg.length > 10 && cfg !== 'ВСТАВЬ_СЮДА_КУКИ_ИЗ_INSTAGRAM') ? cfg : null;
}

app.post('/api/cookie', (req, res) => {
  const { cookie } = req.body;
  if (!cookie || cookie.length < 10) return res.status(400).json({ error: 'Пустые куки' });
  saveConfig({ cookie });
  res.json({ success: true });
});

// ─── Instagram helpers ────────────────────────────────────────────────────────
function getHeaders() {
  const cookie = getCookie();
  const h = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36', 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br', 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://www.instagram.com/', 'Origin': 'https://www.instagram.com', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
  if (cookie) h['Cookie'] = cookie;
  return h;
}

function getShortcode(url) {
  const m = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function extractMedia(item) {
  const results = [];
  if (!item) return results;
  if (item.edge_sidecar_to_children) {
    for (const { node } of item.edge_sidecar_to_children.edges || []) {
      if (node.video_url) results.push({ url: node.video_url, type: 'video', thumb: node.display_url });
      else if (node.display_url) results.push({ url: node.display_url, type: 'image' });
    }
  } else if (item.video_url) { results.push({ url: item.video_url, type: 'video', thumb: item.display_url }); }
  else if (item.display_url) { results.push({ url: item.display_url, type: 'image' }); }
  if (item.image_versions2?.candidates?.length > 0 && !results.length)
    results.push({ url: item.image_versions2.candidates[0].url, type: 'image' });
  return results;
}

function extractInfo(item) {
  if (!item) return {};
  const owner = item.owner || item.user || {};
  let caption = '';
  if (typeof item.caption === 'string') caption = item.caption;
  else if (item.caption?.text) caption = item.caption.text;
  else if (item.edge_media_to_caption?.edges?.[0]?.node?.text) caption = item.edge_media_to_caption.edges[0].node.text;
  else if (item.accessibility_caption) caption = item.accessibility_caption;
  return {
    username:      owner.username || owner.login || '',
    fullName:      owner.full_name || owner.fullName || '',
    profilePicUrl: owner.profile_pic_url || owner.profile_picture || owner.hd_profile_pic_url_info?.url || '',
    caption,
  };
}

function findMediaInJson(obj, results, depth = 0) {
  if (depth > 20 || !obj || typeof obj !== 'object') return;
  if (typeof obj.video_url === 'string' && obj.video_url.startsWith('http')) {
    const u = obj.video_url;
    if (!results.find(r => r.url === u)) {
      results.push({ url: u, type: 'video', thumb: obj.display_url });
      const idx = results.findIndex(r => r.url === obj.display_url && r.type === 'image');
      if (idx !== -1) results.splice(idx, 1);
    }
  } else if (typeof obj.display_url === 'string' && obj.display_url.startsWith('http')) {
    const u = obj.display_url;
    if (!results.find(r => r.url === u) && !results.find(r => r.thumb === u)) results.push({ url: u, type: 'image' });
  }
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val)) val.forEach(i => findMediaInJson(i, results, depth + 1));
    else if (val && typeof val === 'object') findMediaInJson(val, results, depth + 1);
  }
}

async function tryApiA1(shortcode) {
  const r = await axios.get(`https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`, { headers: getHeaders(), timeout: 10000 });
  const item = r.data?.items?.[0] || r.data?.graphql?.shortcode_media;
  if (!item) throw new Error('Empty response');
  const media = extractMedia(item);
  if (!media.length) throw new Error('No media');
  return { media, info: extractInfo(item) };
}

async function tryGraphQL(shortcode) {
  const r = await axios.get(`https://www.instagram.com/graphql/query/?query_hash=b3055c01b4b222b8a47dc12b090e4e64&variables=${encodeURIComponent(JSON.stringify({ shortcode }))}`, { headers: getHeaders(), timeout: 10000 });
  const item = r.data?.data?.shortcode_media;
  if (!item) throw new Error('No shortcode_media');
  const media = extractMedia(item);
  if (!media.length) throw new Error('No media');
  return { media, info: extractInfo(item) };
}

async function tryGraphQL2(shortcode) {
  const cookie = getCookie() || '';
  const csrf   = (cookie.match(/csrftoken=([^;]+)/) || [])[1] || 'missing';
  const r      = await axios.post('https://www.instagram.com/graphql/query', new URLSearchParams({ doc_id: '8845758582119845', variables: JSON.stringify({ shortcode, fetch_comment_count: 0 }) }), { headers: { ...getHeaders(), 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': csrf }, timeout: 10000 });
  const media = [];
  findMediaInJson(r.data, media);
  if (!media.length) throw new Error('No media');
  let info = {};
  try { const d = r.data?.data; if (d) { const item = d.xdt_api__v1__media__shortcode__web_info?.items?.[0] || Object.values(d)[0]; info = extractInfo(item || {}); } } catch {}
  return { media, info };
}

async function tryHtmlParse(shortcode) {
  const r    = await axios.get(`https://www.instagram.com/p/${shortcode}/`, { headers: { ...getHeaders(), 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }, timeout: 12000 });
  const html = r.data;
  let username = '', caption = '';
  const titleMatch = html.match(/property="og:title"\s+content="([^"]+)"/);
  if (titleMatch) {
    const um = titleMatch[1].match(/@([\w.]+)/); if (um) username = um[1];
    const cm = titleMatch[1].match(/on Instagram:\s*"?(.+?)"?\s*$/); if (cm) caption = cm[1];
  }
  const videoUrls = new Set();
  for (const m of html.matchAll(/property="og:video(?::url)?"\s+content="([^"]+)"/g)) videoUrls.add(m[1].replace(/&amp;/g, '&'));
  const imageUrls = [];
  for (const m of html.matchAll(/property="og:image"\s+content="([^"]+)"/g)) { const u = m[1].replace(/&amp;/g, '&'); if (!videoUrls.size) imageUrls.push(u); }
  const media = [];
  for (const u of videoUrls) if (!media.find(r => r.url === u)) media.push({ url: u, type: 'video' });
  for (const u of imageUrls) if (!media.find(r => r.url === u)) media.push({ url: u, type: 'image' });
  for (const m of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) try { findMediaInJson(JSON.parse(m[1]), media); } catch {}
  const addData = html.match(/window\.__additionalDataLoaded\s*\([^,]+,\s*({.+?})\s*\);/s);
  if (addData) try { findMediaInJson(JSON.parse(addData[1]), media); } catch {}
  if (!media.length) throw new Error('No media in HTML');
  return { media, info: { username, caption, profilePicUrl: '' } };
}

// ─── Fetch Instagram ──────────────────────────────────────────────────────────
app.post('/api/fetch', async (req, res) => {
  const config = loadConfig();
  if (config.siteEnabled === false) return res.status(503).json({ error: '🔴 Сайт временно не работает.', siteDisabled: true });
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Укажи ссылку' });
  const shortcode = getShortcode(url);
  if (!shortcode) return res.status(400).json({ error: 'Неверная ссылка Instagram' });
  const urlUsernameMatch = url.match(/instagram\.com\/([^\/\?]+)\/p\//);
  const urlUsername      = urlUsernameMatch ? urlUsernameMatch[1] : '';
  const errors  = [];
  const methods = [
    { name: 'API ?__a=1',  fn: () => tryApiA1(shortcode)    },
    { name: 'GraphQL v2',  fn: () => tryGraphQL2(shortcode)  },
    { name: 'GraphQL v1',  fn: () => tryGraphQL(shortcode)   },
    { name: 'HTML Parser', fn: () => tryHtmlParse(shortcode) },
  ];
  for (const method of methods) {
    try {
      console.log(`[${shortcode}] Trying: ${method.name}`);
      const result = await method.fn();
      const media  = result.media || result;
      const info   = result.info  || {};
      if (media?.length > 0) {
        const finalUsername = info.username || urlUsername;
        console.log(`[${shortcode}] ✅ ${method.name}: ${media.length} items, user: ${finalUsername}`);
        return res.json({ success: true, media, shortcode, username: finalUsername, caption: info.caption || '', profilePicUrl: info.profilePicUrl || '' });
      }
    } catch (err) { console.log(`[${shortcode}] ❌ ${method.name}: ${err.message}`); errors.push(`${method.name}: ${err.message}`); }
  }
  res.status(404).json({ error: getCookie() ? 'Не удалось получить медиа. Пост приватный или куки устарели.' : 'Не удалось получить медиа. Добавь куки Instagram.', details: errors, hasCookie: !!getCookie() });
});

// ─── Posts ────────────────────────────────────────────────────────────────────
app.get('/api/posts', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(loadPosts().map(p => ({ ...p, images: (p.images || (p.image ? [p.image] : [])).map(img => img?.startsWith('data:') ? null : img).filter(Boolean), image: undefined })));
});

app.post('/api/posts', (req, res) => {
  const { text, images, overrideAuthor, overrideAuthorPhoto } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Текст поста обязателен' });
  const user      = req.user || {};
  const imageUrls = (Array.isArray(images) ? images : images ? [images] : []).filter(u => u && typeof u === 'string' && (u.startsWith('/r2/') || u.startsWith('/uploads/') || u.startsWith('https://')));
  const author    = overrideAuthor ? { name: overrideAuthor, photo: overrideAuthorPhoto || null, email: '' } : { name: user.name || 'ZHANSAVER', photo: user.photo || null, email: user.email || '' };
  const post      = { id: Date.now(), text: text.trim(), images: imageUrls, author, likes: 0, likedBy: [], comments: [], createdAt: new Date().toISOString() };
  const posts     = loadPosts();
  posts.unshift(post);
  savePosts(posts);
  sseNotify({ type: 'post', user: author.name });
  res.json({ success: true, post });
});

app.post('/api/posts/:id/like', (req, res) => {
  const id     = Number(req.params.id);
  const userId = req.user?.id || req.user?.email || req.ip;
  const posts  = loadPosts();
  const idx    = posts.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Не найден' });
  if (!posts[idx].likedBy) posts[idx].likedBy = [];
  const already = posts[idx].likedBy.includes(userId);
  if (already) { posts[idx].likedBy = posts[idx].likedBy.filter(u => u !== userId); posts[idx].likes = Math.max(0, (posts[idx].likes || 1) - 1); }
  else { posts[idx].likedBy.push(userId); posts[idx].likes = (posts[idx].likes || 0) + 1; }
  savePosts(posts);
  if (!already) sseNotify({ type: 'like', user: req.user?.name || 'Кто-то' });
  res.json({ success: true, likes: posts[idx].likes, liked: !already });
});

app.post('/api/posts/:id/comments', (req, res) => {
  const id    = Number(req.params.id);
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Пустой комментарий' });
  const user  = req.user || {};
  const posts = loadPosts();
  const idx   = posts.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Не найден' });
  if (!posts[idx].comments) posts[idx].comments = [];
  const comment = { id: Date.now(), text: text.trim(), author: { name: user.name || 'Аноним', photo: user.photo || null }, createdAt: new Date().toISOString() };
  posts[idx].comments.push(comment);
  savePosts(posts);
  sseNotify({ type: 'comment', user: user.name || 'Аноним', text: text.trim() });
  res.json({ success: true, comment });
});

app.delete('/api/posts/:id/comments/:cid', (req, res) => {
  const id    = Number(req.params.id);
  const cid   = Number(req.params.cid);
  const posts = loadPosts();
  const idx   = posts.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Не найден' });
  posts[idx].comments = (posts[idx].comments || []).filter(c => c.id !== cid);
  savePosts(posts);
  res.json({ success: true });
});

app.delete('/api/posts/:id', (req, res) => { savePosts(loadPosts().filter(p => p.id !== Number(req.params.id))); res.json({ success: true }); });

// ─── Releases ─────────────────────────────────────────────────────────────────
app.get('/api/releases', (req, res) => res.json(loadReleases()));

app.post('/api/releases', (req, res) => {
  const { artist, title, releaseDate, releaseTime, timezone, cover } = req.body;
  if (!artist || !title || !releaseDate) return res.status(400).json({ error: 'Заполни все поля' });
  const releases = loadReleases();
  releases.unshift({ id: Date.now(), artist, title, releaseDate, releaseTime: releaseTime || '00:00', timezone: timezone || 'UTC', cover: cover || null, notified: false, createdAt: new Date().toISOString() });
  saveReleases(releases);
  res.json({ success: true });
});

app.put('/api/releases/:id', (req, res) => {
  const id       = Number(req.params.id);
  const { artist, title, releaseDate, releaseTime, timezone, cover } = req.body;
  const releases = loadReleases();
  const idx      = releases.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Не найден' });
  releases[idx]  = { ...releases[idx], artist, title, releaseDate, releaseTime: releaseTime || '00:00', timezone: timezone || 'UTC', cover: (cover !== null && cover !== undefined) ? cover : releases[idx].cover, notified: false };
  saveReleases(releases);
  res.json({ success: true, release: releases[idx] });
});

app.delete('/api/releases/:id', (req, res) => { saveReleases(loadReleases().filter(r => r.id !== Number(req.params.id))); res.json({ success: true }); });

// ─── Links ────────────────────────────────────────────────────────────────────
app.get('/api/links', (req, res) => res.json(loadLinks()));

app.post('/api/links', (req, res) => {
  const { artist, instagram, tiktok, youtube, spotify, avatar } = req.body;
  if (!artist) return res.status(400).json({ error: 'Укажи имя артиста' });
  const links = loadLinks();
  links.unshift({ id: Date.now(), artist, instagram: instagram || '', tiktok: tiktok || '', youtube: youtube || '', spotify: spotify || '', avatar: avatar || null });
  saveLinks(links);
  res.json({ success: true });
});

app.put('/api/links/:id', (req, res) => {
  const id    = Number(req.params.id);
  const { artist, instagram, tiktok, youtube, spotify, avatar } = req.body;
  const links = loadLinks();
  const idx   = links.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Не найден' });
  links[idx]  = { ...links[idx], artist, instagram: instagram || '', tiktok: tiktok || '', youtube: youtube || '', spotify: spotify || '', avatar: (avatar !== null && avatar !== undefined) ? avatar : links[idx].avatar };
  saveLinks(links);
  res.json({ success: true, link: links[idx] });
});

app.post('/api/links/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
  const links = loadLinks();
  const map   = new Map(links.map(l => [l.id, l]));
  saveLinks(ids.map(id => map.get(Number(id))).filter(Boolean));
  res.json({ success: true });
});

app.delete('/api/links/:id', (req, res) => { saveLinks(loadLinks().filter(l => l.id !== Number(req.params.id))); res.json({ success: true }); });

// ─── Admin ────────────────────────────────────────────────────────────────────
app.get('/admin/releases', (req, res) => {
  const { key } = req.query;
  if (!key || key !== loadConfig().adminUsername) return res.status(403).send('Forbidden');
  try {
    const files = {};
    fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).forEach(f => {
      try { files[f] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { files[f] = null; }
    });
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Admin</title>
    <style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0a0a0a;color:#fff;font-family:monospace;padding:20px;font-size:13px}h2{color:#0f0;margin-bottom:20px}.fb{margin-bottom:30px}.ft{display:flex;align-items:center;gap:12px;margin-bottom:8px}.fn{color:#0f0;font-size:.9rem;font-weight:bold}textarea{width:100%;height:300px;background:#111;color:#0f0;border:1px solid #333;border-radius:8px;padding:12px;font-family:monospace;font-size:12px;resize:vertical;outline:none}textarea:focus{border-color:#0f0}.btn{padding:7px 18px;border-radius:6px;border:none;cursor:pointer;font-family:monospace;font-size:12px;font-weight:bold}.bs{background:#0f0;color:#000}.msg{margin-left:10px;font-size:12px}.ok{color:#0f0}.err{color:#f44}hr{border:none;border-top:1px solid #222;margin:20px 0}</style></head><body>
    <h2>📁 Admin</h2>
    ${Object.entries(files).map(([name, data]) => `<div class="fb"><div class="ft"><span class="fn">📄 ${name}</span><button class="btn bs" onclick="save('${name}')">💾 Сохранить</button><span class="msg" id="m_${name.replace('.','_')}"></span></div><textarea id="f_${name.replace('.','_')}">${JSON.stringify(data,null,2).replace(/</g,'&lt;')}</textarea></div><hr>`).join('')}
    <script>async function save(n){const k=new URLSearchParams(location.search).get('key');const id=n.replace('.','_');const v=document.getElementById('f_'+id).value;const m=document.getElementById('m_'+id);try{JSON.parse(v);const r=await fetch('/admin/save-file?key='+k,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:n,content:v})});const d=await r.json();m.textContent=d.success?'✓ Сохранено':'✗ '+d.error;m.className='msg '+(d.success?'ok':'err');}catch(e){m.textContent='✗ Невалидный JSON';m.className='msg err';}setTimeout(()=>m.textContent='',3000);}<\/script></body></html>`);
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

app.post('/admin/save-file', (req, res) => {
  const { key } = req.query;
  if (!key || key !== loadConfig().adminUsername) return res.status(403).json({ error: 'Forbidden' });
  const { filename, content } = req.body;
  if (!filename || !content) return res.status(400).json({ error: 'Missing fields' });
  try { JSON.parse(content); fs.writeFileSync(path.join(DATA_DIR, path.basename(filename)), content, 'utf8'); res.json({ success: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Release dates checker ────────────────────────────────────────────────────
const TIMEZONES = { KST: 9, MSK: 3, ALMT: 5, UTC: 0 };

function getReleaseUTCDate(r) {
  const [y, mo, d] = (r.releaseDate || '2000-01-01').split('-').map(Number);
  const [h, mi]    = (r.releaseTime || '00:00').split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - (TIMEZONES[r.timezone] ?? 0), mi, 0));
}

async function checkReleaseDates() {
  const now = new Date(), releases = loadReleases();
  if (!releases.length) return;
  let changed = false;
  const remaining = [];
  for (const release of releases) {
    const diff = now - getReleaseUTCDate(release);
    if (diff > 86400000) { changed = true; continue; }
    if (diff >= 0 && !release.notified) { release.notified = true; release.notifiedAt = now.toISOString(); changed = true; sseNotify({ type: 'release', title: release.title, artist: release.artist }); }
    remaining.push(release);
  }
  if (changed) saveReleases(remaining);
}

// ─── Start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n✅ ZHANSAVER: http://localhost:${PORT}`);
  console.log(getCookie() ? '🍪 Куки ОК' : '⚠️  Куки не настроены');
  console.log(R2_ACCOUNT_ID && R2_ACCESS_KEY
    ? `☁️  R2: ${R2_BUCKET} → ${R2_PUBLIC_URL || '/r2/... (proxy mode)'}`
    : '⚠️  R2 не настроен! Нужны: CF_ACCOUNT_ID, CF_ACCESS_KEY_ID, CF_SECRET_ACCESS_KEY, CF_BUCKET_NAME');
  const cfg = loadConfig();
  console.log(cfg.adminUsername ? `👤 Admin: @${cfg.adminUsername}` : '⚠️  adminUsername не задан');
});

server.on('listening', () => {
  setInterval(checkReleaseDates, 60 * 60 * 1000);
  setTimeout(checkReleaseDates, 10000);
});
