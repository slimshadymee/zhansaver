const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Пути к файлам ───────────────────────────────────────────────────────────
// config.json — всегда рядом с кодом (из GitHub)
const CONFIG_FILE = path.join(__dirname, 'config.json');

// releases.json — в Railway Volume (/app/data) или локально
const RELEASES_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : __dirname;
if (!fs.existsSync(RELEASES_DIR)) {
  try { fs.mkdirSync(RELEASES_DIR, { recursive: true }); } catch {}
}
const RELEASES_FILE = path.join(RELEASES_DIR, 'releases.json');

// ─── Конфиг ──────────────────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}
function saveConfig(data) {
  const merged = { ...loadConfig(), ...data };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
}

// ─── Релизы ──────────────────────────────────────────────────────────────────
function loadReleases() {
  try { return JSON.parse(fs.readFileSync(RELEASES_FILE, 'utf8')); }
  catch { return []; }
}
function saveReleases(releases) {
  fs.writeFileSync(RELEASES_FILE, JSON.stringify(releases, null, 2));
}

// ─── Telegram Bot ─────────────────────────────────────────────────────────────
const TG_TOKEN = process.env.TG_TOKEN || '8252644018:AAGOkyp67N0Myv0o-_LWfSpieGtYba6if0w';
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
let lastUpdateId = 0;
const awaitingCookie = new Set();
const awaitingMessage = new Set();

async function tgSend(chatId, text, opts = {}) {
  await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text, ...opts });
}

async function tgSendPhoto(chatId, url) {
  const response = await axios.get(url, { headers: { ...getHeaders(), 'Accept': 'image/*, */*' }, responseType: 'arraybuffer', timeout: 60000 });
  const FormData = require('form-data');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', Buffer.from(response.data), { filename: 'photo.jpg', contentType: 'image/jpeg' });
  await axios.post(`${TG_API}/sendPhoto`, form, { headers: form.getHeaders(), timeout: 60000 });
}

async function tgSendVideo(chatId, url) {
  const response = await axios.get(url, { headers: { ...getHeaders(), 'Accept': 'video/*, */*' }, responseType: 'arraybuffer', timeout: 120000 });
  const FormData = require('form-data');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('video', Buffer.from(response.data), { filename: 'video.mp4', contentType: 'video/mp4' });
  await axios.post(`${TG_API}/sendVideo`, form, { headers: form.getHeaders(), timeout: 120000 });
}

async function tgSendMediaGroup(chatId, mediaItems) {
  const FormData = require('form-data');
  const chunks = [];
  for (let i = 0; i < mediaItems.length; i += 10) chunks.push(mediaItems.slice(i, i + 10));
  for (const chunk of chunks) {
    const form = new FormData();
    const mediaJson = [];
    for (let i = 0; i < chunk.length; i++) {
      const item = chunk[i];
      const response = await axios.get(item.url, { headers: { ...getHeaders(), 'Accept': '*/*' }, responseType: 'arraybuffer', timeout: 120000 });
      const fieldName = `file${i}`;
      const ext = item.type === 'video' ? 'mp4' : 'jpg';
      const ct = item.type === 'video' ? 'video/mp4' : 'image/jpeg';
      form.append(fieldName, Buffer.from(response.data), { filename: `media_${i+1}.${ext}`, contentType: ct });
      mediaJson.push({ type: item.type === 'video' ? 'video' : 'photo', media: `attach://${fieldName}` });
    }
    form.append('chat_id', String(chatId));
    form.append('media', JSON.stringify(mediaJson));
    await axios.post(`${TG_API}/sendMediaGroup`, form, { headers: form.getHeaders(), timeout: 180000 });
  }
}

function isAdmin(username) {
  if (!username) return false;
  const config = loadConfig();
  const adminUser = (config.adminUsername || '').replace('@', '').toLowerCase();
  return adminUser && username.toLowerCase() === adminUser;
}

async function checkCookieValid() {
  try {
    const res = await axios.get('https://www.instagram.com/api/v1/accounts/current_user/?edit=true', { headers: getHeaders(), timeout: 10000 });
    return res.status === 200;
  } catch { return false; }
}

// ─── Проверка дат релизов и уведомление в TG ─────────────────────────────────
async function checkReleaseDates() {
  const config = loadConfig();
  const adminChatId = config.adminChatId;

  const releases = loadReleases();
  const today = new Date().toISOString().split('T')[0];

  // Дата "вчера" — через 1 день после релиза удаляем
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  let changed = false;
  const remaining = [];

  for (const release of releases) {
    // Удаляем если прошёл 1 день после релиза
    if (release.releaseDate <= yesterdayStr) {
      console.log(`[Releases] Удаляем "${release.title}" (${release.releaseDate})`);
      changed = true;
      continue;
    }

    // Уведомляем когда наступило время релиза (с точностью до часа)
    const releaseTime = release.releaseTime || '00:00';
    const releaseDateTime = new Date(release.releaseDate + 'T' + releaseTime + ':00');
    const nowTime = new Date();
    const isReleaseTime = releaseDateTime <= nowTime;

    if (isReleaseTime && !release.notified && adminChatId) {
      release.notified = true;
      changed = true;
      try {
        const timeStr = release.releaseTime && release.releaseTime !== '00:00' ? ` в ${release.releaseTime}` : '';
        await tgSend(adminChatId,
          `🎵 Релиз вышел сегодня!\n\n` +
          `👤 Артист: ${release.artist}\n` +
          `💿 Название: ${release.title}\n` +
          `📅 Дата: ${release.releaseDate}${timeStr}\n\n` +
          `Трек уже должен быть на площадках!`
        );
      } catch (e) { console.error('[TG] Release notify error:', e.message); }
    }

    remaining.push(release);
  }

  if (changed) saveReleases(remaining);
}

// ─── Обработчик сообщений Telegram ───────────────────────────────────────────
async function handleTgMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const username = (msg.from?.username || '').toLowerCase();

  // Сохраняем chatId админа для уведомлений
  if (isAdmin(username)) {
    const config = loadConfig();
    if (config.adminChatId !== chatId) saveConfig({ adminChatId: chatId });
  }

  // Ожидание куки
  if (awaitingCookie.has(chatId)) {
    awaitingCookie.delete(chatId);
    if (text.length < 20) { await tgSend(chatId, '❌ Не похоже на куки. Отправь /start и попробуй снова.'); return; }
    saveConfig({ cookie: text });
    await tgSend(chatId, '✅ Куки сохранены! Проверяю...');
    const valid = await checkCookieValid();
    await tgSend(chatId, valid
      ? '✅ Куки рабочие!\n\n/onsite — включить сайт\n/offsite — выключить сайт\n/message — сообщение\n/unmessage — убрать'
      : '⚠️ Куки сохранены, но Instagram не принял. Возможно устарели.'
    );
    return;
  }

  // Ожидание текста /message
  if (awaitingMessage.has(chatId)) {
    awaitingMessage.delete(chatId);
    const parts = text.split('|');
    const title = parts[0]?.trim() || 'Внимание';
    const body = parts[1]?.trim() || text;
    saveConfig({ siteMessage: { active: true, title, body } });
    await tgSend(chatId, `✅ Сообщение установлено!\n\n📌 ${title}\n📝 ${body}\n\nУбрать — /unmessage`);
    return;
  }

  // /start
  if (text === '/start') {
    if (!isAdmin(username)) return;
    await tgSend(chatId, '🔐 Добро пожаловать! Проверяю куки...');
    const hasCookie = !!getCookie();
    if (!hasCookie) {
      await tgSend(chatId, '⚠️ Куки не найдены! Отправь строку куки от Instagram:');
      awaitingCookie.add(chatId);
      return;
    }
    const valid = await checkCookieValid();
    const config = loadConfig();
    const releases = loadReleases();
    await tgSend(chatId,
      `✅ Панель управления ZHANSAVER\n\n` +
      `🍪 Куки: ${valid ? '✅ Рабочие' : '❌ Не работают'}\n` +
      `🌐 Сайт: ${config.siteEnabled !== false ? '✅ Включён' : '🔴 Выключен'}\n` +
      `📢 Сообщение: ${config.siteMessage?.active ? '✅ Активно' : '—'}\n` +
      `🎵 Релизов: ${releases.length}\n\n` +
      `/onsite — включить сайт\n` +
      `/offsite — выключить сайт\n` +
      `/message — показать сообщение\n` +
      `/unmessage — убрать сообщение\n` +
      `/cookie — обновить куки`
    );
    return;
  }

  // Не админ — игнорируем
  if (!isAdmin(username)) return;

  if (text === '/onsite') {
    if (loadConfig().siteEnabled !== false) { await tgSend(chatId, 'ℹ️ Сайт уже включён.'); return; }
    saveConfig({ siteEnabled: true });
    await tgSend(chatId, '✅ Сайт включён!');
    return;
  }

  if (text === '/offsite') {
    if (loadConfig().siteEnabled === false) { await tgSend(chatId, 'ℹ️ Сайт уже выключен.'); return; }
    saveConfig({ siteEnabled: false });
    await tgSend(chatId, '🔴 Сайт выключен.');
    return;
  }

  if (text === '/message') {
    await tgSend(chatId, '📢 Введи заголовок и текст через |\n\nПример:\nВнимание!|Сайт на техобслуживании.\n\nОтправь:');
    awaitingMessage.add(chatId);
    return;
  }

  if (text === '/unmessage') {
    if (!loadConfig().siteMessage?.active) { await tgSend(chatId, 'ℹ️ Сообщение и так не активно.'); return; }
    saveConfig({ siteMessage: { active: false, title: '', body: '' } });
    await tgSend(chatId, '✅ Сообщение убрано.');
    return;
  }

  if (text === '/cookie') {
    await tgSend(chatId, '🍪 Отправь новую строку куки от Instagram:');
    awaitingCookie.add(chatId);
    return;
  }
}

async function pollTelegram() {
  while (true) {
    try {
      const res = await axios.get(`${TG_API}/getUpdates`, {
        params: { offset: lastUpdateId + 1, timeout: 30, allowed_updates: ['message'] },
        timeout: 35000,
      });
      for (const update of (res.data.result || [])) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg || !msg.text) continue;
        handleTgMessage(msg).catch(e => console.error('[TG] Error:', e.message));
      }
    } catch (err) {
      if (!err.message.includes('timeout')) console.error('[TG] Poll error:', err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Куки / заголовки ────────────────────────────────────────────────────────
function getCookie() {
  try { const c = process.env.COOKIE || ''; if (c.length > 10) return c; } catch {}
  try {
    const c = loadConfig().cookie || '';
    if (c === 'ВСТАВЬ_СЮДА_КУКИ_ИЗ_INSTAGRAM' || c.length < 10) return null;
    return c;
  } catch { return null; }
}

function getHeaders() {
  const cookie = getCookie();
  const h = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br',
    'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://www.instagram.com/', 'Origin': 'https://www.instagram.com',
    'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
  };
  if (cookie) h['Cookie'] = cookie;
  return h;
}

function getShortcode(url) {
  const m = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// ─── Instagram ────────────────────────────────────────────────────────────────
function extractMedia(item) {
  const results = [];
  if (!item) return results;
  if (item.edge_sidecar_to_children) {
    for (const edge of item.edge_sidecar_to_children.edges || []) {
      const node = edge.node;
      if (node.video_url) results.push({ url: node.video_url, type: 'video', thumb: node.display_url });
      else if (node.display_url) results.push({ url: node.display_url, type: 'image' });
    }
  } else if (item.video_url) {
    results.push({ url: item.video_url, type: 'video', thumb: item.display_url });
  } else if (item.display_url) {
    results.push({ url: item.display_url, type: 'image' });
  }
  if (item.image_versions2?.candidates?.length > 0 && results.length === 0)
    results.push({ url: item.image_versions2.candidates[0].url, type: 'image' });
  return results;
}

function findMediaInJson(obj, results, depth = 0) {
  if (depth > 20 || !obj || typeof obj !== 'object') return;
  if (typeof obj.video_url === 'string' && obj.video_url.startsWith('http')) {
    const u = obj.video_url;
    if (!results.find(r => r.url === u)) {
      results.push({ url: u, type: 'video', thumb: obj.display_url });
      if (obj.display_url) { const idx = results.findIndex(r => r.url === obj.display_url && r.type === 'image'); if (idx !== -1) results.splice(idx, 1); }
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
  const res = await axios.get(`https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`, { headers: getHeaders(), timeout: 10000 });
  const item = res.data?.items?.[0] || res.data?.graphql?.shortcode_media;
  if (!item) throw new Error('Empty response');
  const media = extractMedia(item);
  if (!media.length) throw new Error('No media extracted');
  return media;
}

async function tryGraphQL(shortcode) {
  const variables = JSON.stringify({ shortcode });
  const res = await axios.get(`https://www.instagram.com/graphql/query/?query_hash=b3055c01b4b222b8a47dc12b090e4e64&variables=${encodeURIComponent(variables)}`, { headers: getHeaders(), timeout: 10000 });
  const item = res.data?.data?.shortcode_media;
  if (!item) throw new Error('No shortcode_media');
  const media = extractMedia(item);
  if (!media.length) throw new Error('No media');
  return media;
}

async function tryGraphQL2(shortcode) {
  const cookie = getCookie() || '';
  const csrf = (cookie.match(/csrftoken=([^;]+)/) || [])[1] || 'missing';
  const res = await axios.post('https://www.instagram.com/graphql/query',
    new URLSearchParams({ doc_id: '8845758582119845', variables: JSON.stringify({ shortcode, fetch_comment_count: 0 }) }),
    { headers: { ...getHeaders(), 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': csrf }, timeout: 10000 }
  );
  const media = [];
  findMediaInJson(res.data, media);
  if (!media.length) throw new Error('No media found');
  return media;
}

async function tryHtmlParse(shortcode) {
  const res = await axios.get(`https://www.instagram.com/p/${shortcode}/`, {
    headers: { ...getHeaders(), 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
    timeout: 12000,
  });
  const html = res.data;
  const videoUrls = new Set();
  for (const m of html.matchAll(/property="og:video(?::url)?"\s+content="([^"]+)"/g)) videoUrls.add(m[1].replace(/&amp;/g, '&'));
  const imageUrls = [];
  for (const m of html.matchAll(/property="og:image"\s+content="([^"]+)"/g)) {
    const u = m[1].replace(/&amp;/g, '&');
    if (videoUrls.size === 0) imageUrls.push(u);
  }
  const media = [];
  for (const u of videoUrls) if (!media.find(r => r.url === u)) media.push({ url: u, type: 'video' });
  for (const u of imageUrls) if (!media.find(r => r.url === u)) media.push({ url: u, type: 'image' });
  for (const m of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) { try { findMediaInJson(JSON.parse(m[1]), media); } catch {} }
  const addData = html.match(/window\.__additionalDataLoaded\s*\([^,]+,\s*({.+?})\s*\);/s);
  if (addData) { try { findMediaInJson(JSON.parse(addData[1]), media); } catch {} }
  if (!media.length) throw new Error('No media in HTML');
  return media;
}

// ─── API Routes ───────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const config = loadConfig();
  res.json({ hasCookie: !!getCookie(), siteEnabled: config.siteEnabled !== false, siteMessage: config.siteMessage || { active: false } });
});

app.get('/proxy', async (req, res) => {
  const { url, dl } = req.query;
  if (!url) return res.status(400).send('No URL');
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return res.status(400).send('Invalid URL');
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Referer': 'https://www.instagram.com/',
  };

  if (req.headers.range) headers['Range'] = req.headers.range;

  try {
    const response = await axios.get(url, {
      headers,
      responseType: 'stream',
      timeout: 60000,
      maxRedirects: 5,
    });

    const ct = response.headers['content-type'] || 'application/octet-stream';
    const isVideo = ct.includes('video') || url.includes('.mp4');
    const ext = isVideo ? 'mp4' : (ct.includes('webp') ? 'webp' : 'jpg');

    res.status(response.status === 206 ? 206 : 200);
    res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', 'bytes');
    if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
    if (response.headers['content-range']) res.setHeader('Content-Range', response.headers['content-range']);
    if (dl === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="media_${Date.now()}.${ext}"`);
    } else {
      res.setHeader('Content-Disposition', 'inline');
    }
    response.data.pipe(res);
  } catch (err) {
    console.error('[Proxy] Error for URL:', url.substring(0, 80), '-', err.message);
    res.status(500).send(err.message);
  }
});


app.post('/api/cookie', (req, res) => {
  const { cookie } = req.body;
  if (!cookie || cookie.length < 10) return res.status(400).json({ error: 'Пустые куки' });
  try { saveConfig({ cookie }); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fetch', async (req, res) => {
  const config = loadConfig();
  if (config.siteEnabled === false) return res.status(503).json({ error: '🔴 Сайт временно не работает.', siteDisabled: true });

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Укажи ссылку' });

  // Instagram
  const shortcode = getShortcode(url);
  if (!shortcode) return res.status(400).json({ error: 'Неверная ссылка Instagram' });

  const hasCookie = !!getCookie();
  const errors = [];
  const methods = [
    { name: 'API ?__a=1', fn: () => tryApiA1(shortcode) },
    { name: 'GraphQL v2', fn: () => tryGraphQL2(shortcode) },
    { name: 'GraphQL v1', fn: () => tryGraphQL(shortcode) },
    { name: 'HTML Parser', fn: () => tryHtmlParse(shortcode) },
  ];
  for (const method of methods) {
    try {
      console.log(`[${shortcode}] Trying: ${method.name}`);
      const media = await method.fn();
      if (media?.length > 0) { console.log(`[${shortcode}] ✅ ${method.name}: ${media.length} items`); return res.json({ success: true, media, shortcode }); }
    } catch (err) { console.log(`[${shortcode}] ❌ ${method.name}: ${err.message}`); errors.push(`${method.name}: ${err.message}`); }
  }
  res.status(404).json({ error: hasCookie ? 'Не удалось получить медиа. Пост приватный или куки устарели.' : 'Не удалось получить медиа. Добавь куки Instagram.', details: errors, hasCookie });
});

// ─── Debug endpoint (только для админа) ─────────────────────────────────────
app.get('/admin/releases', (req, res) => {
  const { key } = req.query;
  const config = loadConfig();
  if (!key || key !== config.adminUsername) return res.status(403).send('Forbidden');
  try {
    const raw = fs.readFileSync(RELEASES_FILE, 'utf8');
    const releases = JSON.parse(raw);
    let html = `<h2>📄 releases.json (${releases.length} записей)</h2><hr>`;
    html += `<pre style="background:#111;color:#0f0;padding:12px;border-radius:8px;overflow:auto;font-size:12px">${JSON.stringify(releases, null, 2).replace(/</g,'&lt;')}</pre>`;
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Releases</title><style>body{background:#000;color:#fff;font-family:monospace;padding:20px}hr{border-color:#333}</style></head><body>${html}</body></html>`);
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});
// Релизы
app.get('/api/releases', (req, res) => res.json(loadReleases()));

app.post('/api/releases', (req, res) => {
  const { artist, title, releaseDate, releaseTime, cover } = req.body;
  if (!artist || !title || !releaseDate) return res.status(400).json({ error: 'Заполни все поля' });
  const releases = loadReleases();
  const release = { id: Date.now(), artist, title, releaseDate, releaseTime: releaseTime || '00:00', cover: cover || null, notified: false, createdAt: new Date().toISOString() };
  releases.unshift(release);
  saveReleases(releases);
  res.json({ success: true, release });
});

app.delete('/api/releases/:id', (req, res) => {
  const id = Number(req.params.id);
  saveReleases(loadReleases().filter(r => r.id !== id));
  res.json({ success: true });
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ ZHANSAVER запущен: http://localhost:${PORT}`);
  console.log(getCookie() ? '🍪 Куки загружены!' : '⚠️  Куки не настроены.');
  const config = loadConfig();
  console.log(config.adminUsername ? `👤 Admin: @${config.adminUsername}` : '⚠️  adminUsername не задан.');
  if (!fs.existsSync(RELEASES_FILE)) saveReleases([]);
});

pollTelegram().catch(console.error);
console.log('🤖 Telegram бот запущен!');

// Проверяем релизы каждый час
setInterval(checkReleaseDates, 60 * 60 * 1000);
setTimeout(checkReleaseDates, 5000);
