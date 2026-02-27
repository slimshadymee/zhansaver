const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Пути к файлам ───────────────────────────────────────────────────────────
// Все данные в Railway Volume (/app/data) или локально рядом с кодом
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : __dirname;
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const RELEASES_FILE = path.join(DATA_DIR, 'releases.json');
const LINKS_FILE = path.join(DATA_DIR, 'links.json');
const NEWS_FILE = path.join(DATA_DIR, 'news.json');

// При первом запуске на Railway — копируем config.json из репо в volume
if (process.env.RAILWAY_ENVIRONMENT && !fs.existsSync(CONFIG_FILE)) {
  try {
    const src = path.join(__dirname, 'config.json');
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, CONFIG_FILE);
      console.log('[Config] Copied config.json to volume');
    }
  } catch (e) { console.error('[Config] Copy error:', e.message); }
}

// ─── Конфиг ──────────────────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}
function saveConfig(data) {
  try {
    const merged = { ...loadConfig(), ...data };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  } catch (e) { console.error('[Config] Save error:', e.message); }
}

// ─── Релизы ──────────────────────────────────────────────────────────────────
function loadReleases() {
  try { return JSON.parse(fs.readFileSync(RELEASES_FILE, 'utf8')); }
  catch { return []; }
}
function saveReleases(releases) {
  try {
    fs.writeFileSync(RELEASES_FILE, JSON.stringify(releases, null, 2));
    console.log(`[Releases] Saved ${releases.length} releases to ${RELEASES_FILE}`);
  } catch (e) {
    console.error(`[Releases] SAVE ERROR: ${e.message} (path: ${RELEASES_FILE})`);
  }
}

// ─── Links ───────────────────────────────────────────────────────────────────
function loadLinks() {
  try { return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')); }
  catch { return []; }
}
function saveLinks(links) {
  try {
    fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
  } catch (e) { console.error('[Links] Save error:', e.message); }
}

// ─── News ────────────────────────────────────────────────────────────────────
function loadNews() {
  try { return JSON.parse(fs.readFileSync(NEWS_FILE, 'utf8')); }
  catch { return []; }
}
function saveNews(news) {
  try { fs.writeFileSync(NEWS_FILE, JSON.stringify(news, null, 2)); }
  catch (e) { console.error('[News] Save error:', e.message); }
}
function cleanExpiredNews() {
  const news = loadNews();
  const now = Date.now();
  const filtered = news.filter(n => !n.deleteAt || n.deleteAt > now);
  if (filtered.length !== news.length) saveNews(filtered);
}

// ─── Telegram Bot ─────────────────────────────────────────────────────────────
const TG_TOKEN = process.env.TG_TOKEN || '8252644018:AAGOkyp67N0Myv0o-_LWfSpieGtYba6if0w';
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
let lastUpdateId = 0;
const awaitingCookie = new Set();
const awaitingMessage = new Set();
const awaitingNews = new Map(); // chatId -> { step, data }

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
const TIMEZONES = { 'KST': 9, 'MSK': 3, 'ALMT': 5, 'UTC': 0 };

function getReleaseUTCDate(release) {
  const date = release.releaseDate || '2000-01-01';
  const time = release.releaseTime || '00:00';
  const tz = release.timezone || 'UTC';
  const offsetHours = TIMEZONES[tz] !== undefined ? TIMEZONES[tz] : 0;
  // Парсим дату и время как локальное время зоны, конвертируем в UTC
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  // UTC = локальное - смещение
  return new Date(Date.UTC(y, mo - 1, d, h - offsetHours, mi, 0));
}

async function checkReleaseDates() {
  const config = loadConfig();
  const adminChatId = config.adminChatId;
  const now = new Date();
  console.log(`[Releases] Checking at ${now.toISOString()}, adminChatId=${adminChatId}`);

  const releases = loadReleases();
  if (!releases.length) { console.log('[Releases] Нет релизов'); return; }

  let changed = false;
  const remaining = [];

  for (const release of releases) {
    const releaseUTC = getReleaseUTCDate(release);
    const msSinceRelease = now - releaseUTC;
    console.log(`[Releases] "${release.title}": releaseUTC=${releaseUTC.toISOString()}, msSince=${Math.round(msSinceRelease/1000)}s, notified=${release.notified}`);

    // Удаляем через сутки после выхода
    if (msSinceRelease > 24 * 60 * 60 * 1000) {
      console.log(`[Releases] Удаляем "${release.title}"`);
      changed = true;
      continue;
    }

    // Уведомляем если вышел и ещё не уведомляли
    if (msSinceRelease >= 0 && !release.notified) {
      release.notified = true;
      release.notifiedAt = now.toISOString();
      changed = true;
      console.log(`[Releases] Ставим notified=true для "${release.title}"`);

      // Отправляем уведомление только если прошло меньше 2 часов (не перезапуск)
      const hoursSince = msSinceRelease / (1000 * 60 * 60);
      if (adminChatId && hoursSince < 2) {
        const tz = release.timezone || 'UTC';
        const timeStr = (release.releaseTime && release.releaseTime !== '00:00') ? ` в ${release.releaseTime} (${tz})` : '';
        try {
          const lines = ['\u{1F3B5} \u0420\u0435\u043B\u0438\u0437 \u0432\u044B\u0448\u0435\u043B!', `\u{1F464} \u0410\u0440\u0442\u0438\u0441\u0442: ${release.artist}`, `\u{1F4BF} \u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435: ${release.title}`, `\u{1F4C5} \u0414\u0430\u0442\u0430: ${release.releaseDate}${timeStr}`, '', '\u0422\u0440\u0435\u043A \u0443\u0436\u0435 \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043D\u0430 \u043F\u043B\u043E\u0449\u0430\u0434\u043A\u0430\u0445!'];
          await tgSend(adminChatId, lines.join('\n'));
          console.log(`[Releases] ✅ Уведомление отправлено: ${release.title}`);
        } catch (e) {
          console.error('[TG] Notify error:', e.message);
        }
      } else if (!adminChatId) {
        console.log('[Releases] ⚠️ adminChatId не задан');
      } else {
        console.log(`[Releases] Пропуск уведомления — ${hoursSince.toFixed(1)}ч (перезапуск)`);
      }
    }

    remaining.push(release);
  }

  if (changed) {
    saveReleases(remaining);
    console.log(`[Releases] ✅ Сохранено. Релизов: ${remaining.length}`);
  }
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

  // /cancel — сброс любого ожидания
  if (text === '/cancel') {
    awaitingNews.delete(chatId);
    awaitingCookie.delete(chatId);
    awaitingMessage.delete(chatId);
    await tgSend(chatId, '❌ Отменено.');
    return;
  }

  // /news flow
  if (awaitingNews.has(chatId)) {
    const state = awaitingNews.get(chatId);

    if (state.step === 'photo') {
      const photo = msg.photo;
      if (!photo) {
        await tgSend(chatId, '❌ Нужно фото! Отправь изображение постера.\n\n/cancel — отменить');
        return;
      }
      const fileId = photo[photo.length - 1].file_id;
      try {
        const fileRes = await axios.get(`${TG_API}/getFile?file_id=${fileId}`);
        const filePath = fileRes.data.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`;
        const imgRes = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 });
        const base64 = 'data:image/jpeg;base64,' + Buffer.from(imgRes.data).toString('base64');
        state.data.image = base64;
        state.step = 'title';
        awaitingNews.set(chatId, state);
        await tgSend(chatId, '✅ Фото получено!\n\n✏️ Шаг 2/4: Отправь заголовок новости:\n\n/cancel — отменить');
      } catch (e) {
        awaitingNews.delete(chatId);
        await tgSend(chatId, '❌ Ошибка загрузки фото. Попробуй снова /news');
      }
      return;
    }

    if (state.step === 'title') {
      if (!msg.text) { await tgSend(chatId, '❌ Отправь текст заголовка'); return; }
      state.data.title = text;
      state.step = 'spotify';
      awaitingNews.set(chatId, state);
      await tgSend(chatId, '✅ Заголовок сохранён!\n\n🎵 Шаг 3/4: Отправь ссылку на Spotify:\n\n/cancel — отменить');
      return;
    }

    if (state.step === 'spotify') {
      if (!msg.text) { await tgSend(chatId, '❌ Отправь ссылку текстом'); return; }
      state.data.spotify = text;
      state.step = 'days';
      awaitingNews.set(chatId, state);
      await tgSend(chatId, '✅ Ссылка сохранена!\n\n⏳ Шаг 4/4: Через сколько дней удалить?\n\nОтправь число (1, 2, 3, 7...)\n\n/cancel — отменить');
      return;
    }

    if (state.step === 'days') {
      if (!msg.text) { await tgSend(chatId, '❌ Отправь число'); return; }
      const days = parseInt(text);
      if (isNaN(days) || days < 1 || days > 30) {
        await tgSend(chatId, '❌ Введи число от 1 до 30');
        return;
      }
      const deleteAt = Date.now() + days * 24 * 60 * 60 * 1000;
      const newsItem = { id: Date.now(), ...state.data, deleteAt, createdAt: new Date().toISOString() };
      const news = loadNews();
      news.unshift(newsItem);
      saveNews(news);
      awaitingNews.delete(chatId);
      await tgSend(chatId, `✅ Новость опубликована!\n\n📰 ${newsItem.title}\n🗓 Удалится через ${days} дн.`);
      return;
    }
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
      `/cookie — обновить куки\n` +
      `/news — добавить новость`
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

  if (text === '/news') {
    awaitingNews.set(chatId, { step: 'photo', data: {} });
    await tgSend(chatId, '📰 Создаём новость!\n\n📸 Шаг 1/4: Отправь фото постера трека:');
    return;
  }

  if (text === '/delnews') {
    const news = loadNews();
    if (!news.length) { await tgSend(chatId, 'Нет новостей'); return; }
    const list = news.map((n, i) => `${i+1}. ${n.title} (ID: ${n.id})`).join('\n');
    await tgSend(chatId, `📰 Новости:\n\n${list}\n\nОтправь /delnews_ID для удаления`);
    return;
  }

  if (text.startsWith('/delnews_')) {
    const id = Number(text.replace('/delnews_', ''));
    const news = loadNews().filter(n => n.id !== id);
    saveNews(news);
    await tgSend(chatId, '✅ Новость удалена');
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
        if (!msg) continue;
        if (!msg.text && !msg.photo) continue;
        handleTgMessage(msg).catch(e => console.error('[TG] Error:', e.message));
      }
    } catch (err) {
      if (!err.message.includes('timeout')) console.error('[TG] Poll error:', err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

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

// ─── Debug endpoint ──────────────────────────────────────────────────────────
app.get('/admin/releases', (req, res) => {
  const { key } = req.query;
  const config = loadConfig();
  if (!key || key !== config.adminUsername) return res.status(403).send('Forbidden');
  try {
    let files = {};
    const fileList = fs.readdirSync(DATA_DIR);
    for (const f of fileList) {
      try { files[f] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); }
      catch { files[f] = null; }
    }
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Admin</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{background:#0a0a0a;color:#fff;font-family:monospace;padding:20px;font-size:13px}
      h2{color:#0f0;margin-bottom:20px;font-size:1.1rem}
      .file-block{margin-bottom:30px}
      .file-title{display:flex;align-items:center;gap:12px;margin-bottom:8px}
      .file-name{color:#0f0;font-size:0.9rem;font-weight:bold}
      textarea{width:100%;height:300px;background:#111;color:#0f0;border:1px solid #333;border-radius:8px;padding:12px;font-family:monospace;font-size:12px;resize:vertical;outline:none}
      textarea:focus{border-color:#0f0}
      .btn{padding:7px 18px;border-radius:6px;border:none;cursor:pointer;font-family:monospace;font-size:12px;font-weight:bold}
      .btn-save{background:#0f0;color:#000}
      .btn-save:hover{background:#0d0}
      .msg{margin-left:10px;font-size:12px}
      .msg.ok{color:#0f0} .msg.err{color:#f44}
      hr{border:none;border-top:1px solid #222;margin:20px 0}
    </style></head><body>
    <h2>📁 ${DATA_DIR}</h2>
    ${Object.entries(files).map(([name, data]) => `
      <div class="file-block">
        <div class="file-title">
          <span class="file-name">📄 ${name}</span>
          <button class="btn btn-save" onclick="saveFile('${name}')">💾 Сохранить</button>
          <span class="msg" id="msg_${name.replace('.','_')}"></span>
        </div>
        <textarea id="file_${name.replace('.','_')}">${JSON.stringify(data, null, 2).replace(/</g,'&lt;')}</textarea>
      </div><hr>
    `).join('')}
    <script>
    async function saveFile(name) {
      const key = new URLSearchParams(location.search).get('key');
      const id = name.replace('.','_');
      const val = document.getElementById('file_' + id).value;
      const msg = document.getElementById('msg_' + id);
      try {
        JSON.parse(val); // validate
        const res = await fetch('/admin/save-file?key=' + key, {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ filename: name, content: val })
        });
        const d = await res.json();
        msg.textContent = d.success ? '✓ Сохранено' : '✗ ' + d.error;
        msg.className = 'msg ' + (d.success ? 'ok' : 'err');
      } catch(e) {
        msg.textContent = '✗ Невалидный JSON';
        msg.className = 'msg err';
      }
      setTimeout(() => msg.textContent = '', 3000);
    }
    <\/script>
    </body></html>`;
    res.send(html);
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

app.post('/admin/save-file', (req, res) => {
  const { key } = req.query;
  const config = loadConfig();
  if (!key || key !== config.adminUsername) return res.status(403).json({ error: 'Forbidden' });
  const { filename, content } = req.body;
  if (!filename || !content) return res.status(400).json({ error: 'Missing fields' });
  // Только файлы из DATA_DIR, без path traversal
  const safeName = path.basename(filename);
  const filePath = path.join(DATA_DIR, safeName);
  try {
    JSON.parse(content); // валидируем JSON
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// Скачивает картинку и возвращает base64 (для аватарок по URL)
app.get('/api/download-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'No url' });
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://www.instagram.com/',
        'Accept': 'image/*,*/*'
      }
    });
    const mime = r.headers['content-type'] || 'image/jpeg';
    const base64 = Buffer.from(r.data).toString('base64');
    res.json({ base64: `data:${mime};base64,${base64}` });
  } catch (e) {
    console.error('[DownloadImage]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Links API ───────────────────────────────────────────────────────────────
app.get('/api/links', (req, res) => res.json(loadLinks()));

app.post('/api/links', (req, res) => {
  const { artist, instagram, tiktok, youtube, spotify, avatar } = req.body;
  if (!artist) return res.status(400).json({ error: 'Укажи имя артиста' });
  const links = loadLinks();
  const link = { id: Date.now(), artist, instagram: instagram || '', tiktok: tiktok || '', youtube: youtube || '', spotify: spotify || '', avatar: avatar || null };
  links.unshift(link);
  saveLinks(links);
  res.json({ success: true, link });
});

app.put('/api/links/:id', (req, res) => {
  const id = Number(req.params.id);
  const { artist, instagram, tiktok, youtube, spotify, avatar } = req.body;
  const links = loadLinks();
  const idx = links.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Не найден' });
  const newAvatar = (avatar !== null && avatar !== undefined) ? avatar : links[idx].avatar;
  links[idx] = { ...links[idx], artist, instagram: instagram || '', tiktok: tiktok || '', youtube: youtube || '', spotify: spotify || '', avatar: newAvatar };
  saveLinks(links);
  res.json({ success: true, link: links[idx] });
});

app.post('/api/links/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
  const links = loadLinks();
  const map = new Map(links.map(l => [l.id, l]));
  const reordered = ids.map(id => map.get(Number(id))).filter(Boolean);
  saveLinks(reordered);
  res.json({ success: true });
});

app.delete('/api/links/:id', (req, res) => {
  const id = Number(req.params.id);
  saveLinks(loadLinks().filter(l => l.id !== id));
  res.json({ success: true });
});

// ─── News API ────────────────────────────────────────────────────────────────
app.get('/api/news', (req, res) => {
  cleanExpiredNews();
  res.json(loadNews());
});

app.post('/api/news', (req, res) => {
  const { title, spotify, image, deleteAt } = req.body;
  if (!image) return res.status(400).json({ error: 'Нет изображения' });
  const news = loadNews();
  const item = { id: Date.now(), title: title || 'NEW MUSIC', spotify: spotify || '', image, deleteAt: deleteAt || null, createdAt: new Date().toISOString() };
  news.unshift(item);
  saveNews(news);
  res.json({ success: true, item });
});

app.delete('/api/news/:id', (req, res) => {
  const id = Number(req.params.id);
  saveNews(loadNews().filter(n => n.id !== id));
  res.json({ success: true });
});

// ─── Releases API// Релизы
app.get('/api/releases', (req, res) => res.json(loadReleases()));

app.post('/api/releases', (req, res) => {
  const { artist, title, releaseDate, releaseTime, timezone, cover } = req.body;
  if (!artist || !title || !releaseDate) return res.status(400).json({ error: 'Заполни все поля' });
  const releases = loadReleases();
  const release = { id: Date.now(), artist, title, releaseDate, releaseTime: releaseTime || '00:00', timezone: timezone || 'UTC', cover: cover || null, notified: false, createdAt: new Date().toISOString() };
  releases.unshift(release);
  saveReleases(releases);
  res.json({ success: true, release });
});

// Редактирование релиза
app.put('/api/releases/:id', (req, res) => {
  const id = Number(req.params.id);
  const { artist, title, releaseDate, releaseTime, timezone, cover } = req.body;
  const releases = loadReleases();
  const idx = releases.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Не найден' });
  // cover: null = не менять, строка = обновить
  const newCover = (cover !== null && cover !== undefined) ? cover : releases[idx].cover;
  releases[idx] = { ...releases[idx], artist, title, releaseDate, releaseTime: releaseTime || '00:00', timezone: timezone || 'UTC', cover: newCover, notified: false };
  saveReleases(releases);
  res.json({ success: true, release: releases[idx] });
});

app.delete('/api/releases/:id', (req, res) => {
  const id = Number(req.params.id);
  saveReleases(loadReleases().filter(r => r.id !== id));
  res.json({ success: true });
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n✅ ZHANSAVER запущен: http://localhost:${PORT}`);
  console.log(getCookie() ? '🍪 Куки загружены!' : '⚠️  Куки не настроены.');
  const config = loadConfig();
  console.log(config.adminUsername ? `👤 Admin: @${config.adminUsername}` : '⚠️  adminUsername не задан.');
  if (!fs.existsSync(RELEASES_FILE)) saveReleases([]);
  if (!fs.existsSync(LINKS_FILE)) saveLinks([]);
  if (!fs.existsSync(NEWS_FILE)) saveNews([]);
});

// Запускаем фоновые задачи через setImmediate — только после того как listen завершился
server.on('listening', () => {
  // Telegram polling в отдельном "потоке" — не блокирует HTTP
  setImmediate(() => pollTelegram().catch(console.error));
  console.log('🤖 Telegram бот запущен!');

  // Проверяем релизы каждый час
  setInterval(checkReleaseDates, 60 * 60 * 1000);
  setInterval(cleanExpiredNews, 60 * 60 * 1000);
  // Первая проверка через 10 секунд после старта
  setTimeout(checkReleaseDates, 10000);
});
