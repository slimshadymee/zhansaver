const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Telegram Bot ─────────────────────────────────────────────────────────────
const TG_TOKEN = process.env.TG_TOKEN || '8252644018:AAGOkyp67N0Myv0o-_LWfSpieGtYba6if0w';
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

let lastUpdateId = 0;

// Отправить текст в Telegram
async function tgSend(chatId, text) {
  await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text });
}

// Отправить фото в Telegram по URL
async function tgSendPhoto(chatId, url) {
  const response = await axios.get(url, {
    headers: { ...getHeaders(), 'Accept': 'image/*, */*' },
    responseType: 'arraybuffer',
    timeout: 60000,
  });
  const buffer = Buffer.from(response.data);
  const FormData = require('form-data');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', buffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });
  await axios.post(`${TG_API}/sendPhoto`, form, { headers: form.getHeaders(), timeout: 60000 });
}

// Отправить видео в Telegram по URL
async function tgSendVideo(chatId, url) {
  const response = await axios.get(url, {
    headers: { ...getHeaders(), 'Accept': 'video/*, */*' },
    responseType: 'arraybuffer',
    timeout: 120000,
  });
  const buffer = Buffer.from(response.data);
  const FormData = require('form-data');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('video', buffer, { filename: 'video.mp4', contentType: 'video/mp4' });
  await axios.post(`${TG_API}/sendVideo`, form, { headers: form.getHeaders(), timeout: 120000 });
}

// Отправить медиагруппу (несколько фото/видео)
async function tgSendMediaGroup(chatId, mediaItems) {
  const FormData = require('form-data');

  // Telegram mediaGroup поддерживает до 10 файлов
  const chunks = [];
  for (let i = 0; i < mediaItems.length; i += 10) {
    chunks.push(mediaItems.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    const form = new FormData();
    const mediaJson = [];

    for (let i = 0; i < chunk.length; i++) {
      const item = chunk[i];
      const response = await axios.get(item.url, {
        headers: { ...getHeaders(), 'Accept': '*/*' },
        responseType: 'arraybuffer',
        timeout: 120000,
      });
      const buffer = Buffer.from(response.data);
      const fieldName = `file${i}`;
      const ext = item.type === 'video' ? 'mp4' : 'jpg';
      const ct = item.type === 'video' ? 'video/mp4' : 'image/jpeg';
      form.append(fieldName, buffer, { filename: `media_${i+1}.${ext}`, contentType: ct });
      mediaJson.push({ type: item.type === 'video' ? 'video' : 'photo', media: `attach://${fieldName}` });
    }

    form.append('chat_id', String(chatId));
    form.append('media', JSON.stringify(mediaJson));
    await axios.post(`${TG_API}/sendMediaGroup`, form, { headers: form.getHeaders(), timeout: 180000 });
  }
}

// Получить медиа из Instagram и отправить в Telegram
async function handleTgMessage(chatId, text) {
  const shortcode = getShortcode(text);
  if (!shortcode) {
    await tgSend(chatId, '❌ Не вижу ссылку на Instagram. Отправь ссылку вида:\nhttps://www.instagram.com/p/ABC123/');
    return;
  }

  await tgSend(chatId, '⏳ Скачиваю...');

  const errors = [];
  const methods = [
    { name: 'API ?__a=1', fn: () => tryApiA1(shortcode) },
    { name: 'GraphQL v2', fn: () => tryGraphQL2(shortcode) },
    { name: 'GraphQL v1', fn: () => tryGraphQL(shortcode) },
    { name: 'HTML Parser', fn: () => tryHtmlParse(shortcode) },
  ];

  let media = null;
  for (const method of methods) {
    try {
      const result = await method.fn();
      if (result?.length > 0) { media = result; break; }
    } catch (err) {
      errors.push(`${method.name}: ${err.message}`);
    }
  }

  if (!media) {
    await tgSend(chatId, '❌ Не удалось получить медиа. Возможно пост приватный или куки устарели.');
    return;
  }

  try {
    if (media.length === 1) {
      if (media[0].type === 'video') {
        await tgSendVideo(chatId, media[0].url);
      } else {
        await tgSendPhoto(chatId, media[0].url);
      }
    } else {
      await tgSendMediaGroup(chatId, media);
    }
    await tgSend(chatId, `✅ Готово! Отправил ${media.length} файл(ов).`);
  } catch (err) {
    await tgSend(chatId, '❌ Ошибка при отправке файлов: ' + err.message);
  }
}

// Long polling — получаем обновления от Telegram
async function pollTelegram() {
  while (true) {
    try {
      const res = await axios.get(`${TG_API}/getUpdates`, {
        params: { offset: lastUpdateId + 1, timeout: 30, allowed_updates: ['message'] },
        timeout: 35000,
      });
      const updates = res.data.result || [];
      for (const update of updates) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg || !msg.text) continue;
        const chatId = msg.chat.id;
        const text = msg.text.trim();

        // Обрабатываем в фоне чтобы не блокировать polling
        handleTgMessage(chatId, text).catch(e => console.error('[TG] Error:', e.message));
      }
    } catch (err) {
      if (!err.message.includes('timeout')) {
        console.error('[TG] Poll error:', err.message);
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Загрузка куки из config.json ───────────────────────────────────────────
function getCookie() {
  try {
    const cookie = process.env.COOKIE || '';
    if (cookie.length > 10) return cookie;
  } catch {}
  try {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    const cookie = config.cookie || '';
    if (cookie === 'ВСТАВЬ_СЮДА_КУКИ_ИЗ_INSTAGRAM' || cookie.length < 10) return null;
    return cookie;
  } catch {
    return null;
  }
}

function getHeaders() {
  const cookie = getCookie();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'X-IG-App-ID': '936619743392459',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://www.instagram.com/',
    'Origin': 'https://www.instagram.com',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  };
  if (cookie) headers['Cookie'] = cookie;
  return headers;
}

function getShortcode(url) {
  const m = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

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

  if (item.image_versions2?.candidates?.length > 0 && results.length === 0) {
    results.push({ url: item.image_versions2.candidates[0].url, type: 'image' });
  }

  return results;
}

function findMediaInJson(obj, results, depth = 0) {
  if (depth > 20 || !obj || typeof obj !== 'object') return;

  if (typeof obj.display_url === 'string' && obj.display_url.startsWith('http')) {
    const u = obj.display_url;
    if (!results.find(r => r.url === u)) results.push({ url: u, type: 'image' });
  }
  if (typeof obj.video_url === 'string' && obj.video_url.startsWith('http')) {
    const u = obj.video_url;
    if (!results.find(r => r.url === u)) results.push({ url: u, type: 'video', thumb: obj.display_url });
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val)) val.forEach(i => findMediaInJson(i, results, depth + 1));
    else if (val && typeof val === 'object') findMediaInJson(val, results, depth + 1);
  }
}

// ─── Метод 1: API ?__a=1 ────────────────────────────────────────────────────
async function tryApiA1(shortcode) {
  const url = `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`;
  const res = await axios.get(url, { headers: getHeaders(), timeout: 10000 });
  const item = res.data?.items?.[0] || res.data?.graphql?.shortcode_media;
  if (!item) throw new Error('Empty response');
  const media = extractMedia(item);
  if (!media.length) throw new Error('No media extracted');
  return media;
}

// ─── Метод 2: GraphQL query ──────────────────────────────────────────────────
async function tryGraphQL(shortcode) {
  const variables = JSON.stringify({ shortcode });
  const url = `https://www.instagram.com/graphql/query/?query_hash=b3055c01b4b222b8a47dc12b090e4e64&variables=${encodeURIComponent(variables)}`;
  const res = await axios.get(url, { headers: getHeaders(), timeout: 10000 });
  const item = res.data?.data?.shortcode_media;
  if (!item) throw new Error('No shortcode_media');
  const media = extractMedia(item);
  if (!media.length) throw new Error('No media');
  return media;
}

// ─── Метод 3: Новый GraphQL endpoint ─────────────────────────────────────────
async function tryGraphQL2(shortcode) {
  const headers = getHeaders();
  const cookie = getCookie() || '';
  const csrfMatch = cookie.match(/csrftoken=([^;]+)/);
  const csrf = csrfMatch ? csrfMatch[1] : 'missing';

  const res = await axios.post(
    'https://www.instagram.com/graphql/query',
    new URLSearchParams({
      doc_id: '8845758582119845',
      variables: JSON.stringify({ shortcode, fetch_comment_count: 0 })
    }),
    {
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRFToken': csrf,
      },
      timeout: 10000,
    }
  );

  const media = [];
  findMediaInJson(res.data, media);
  if (!media.length) throw new Error('No media found');
  return media;
}

// ─── Метод 4: HTML парсинг ───────────────────────────────────────────────────
async function tryHtmlParse(shortcode) {
  const headers = {
    ...getHeaders(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document',
  };
  const res = await axios.get(`https://www.instagram.com/p/${shortcode}/`, { headers, timeout: 12000 });
  const html = res.data;
  const media = [];

  for (const m of html.matchAll(/property="og:image"\s+content="([^"]+)"/g)) {
    const u = m[1].replace(/&amp;/g, '&');
    if (!media.find(r => r.url === u)) media.push({ url: u, type: 'image' });
  }
  for (const m of html.matchAll(/property="og:video(?::url)?"\s+content="([^"]+)"/g)) {
    const u = m[1].replace(/&amp;/g, '&');
    if (!media.find(r => r.url === u)) media.push({ url: u, type: 'video' });
  }
  for (const m of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try { findMediaInJson(JSON.parse(m[1]), media); } catch {}
  }
  const addDataMatch = html.match(/window\.__additionalDataLoaded\s*\([^,]+,\s*({.+?})\s*\);/s);
  if (addDataMatch) {
    try { findMediaInJson(JSON.parse(addDataMatch[1]), media); } catch {}
  }

  if (!media.length) throw new Error('No media in HTML');
  return media;
}

// ─── Прокси для скачивания ────────────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('No URL');
  try {
    const response = await axios.get(url, {
      headers: { ...getHeaders(), 'Accept': 'image/*, video/*, */*' },
      responseType: 'stream',
      timeout: 60000,
    });
    const ct = response.headers['content-type'] || 'image/jpeg';
    const ext = ct.includes('video') ? 'mp4' : 'jpg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `attachment; filename="instagram_${Date.now()}.${ext}"`);
    if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
    response.data.pipe(res);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ─── Статус куки ──────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ hasCookie: !!getCookie() });
});

// ─── Сохранить куки ───────────────────────────────────────────────────────────
app.post('/api/cookie', (req, res) => {
  const { cookie } = req.body;
  if (!cookie || cookie.length < 10) return res.status(400).json({ error: 'Пустые куки' });
  try {
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify({ cookie }, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Главный endpoint ─────────────────────────────────────────────────────────
app.post('/api/fetch', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Укажи ссылку' });

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
      if (media?.length > 0) {
        console.log(`[${shortcode}] ✅ Success via ${method.name}: ${media.length} items`);
        return res.json({ success: true, media, shortcode });
      }
    } catch (err) {
      console.log(`[${shortcode}] ❌ ${method.name}: ${err.message}`);
      errors.push(`${method.name}: ${err.message}`);
    }
  }

  res.status(404).json({
    error: hasCookie
      ? 'Не удалось получить медиа. Возможно пост приватный или куки устарели.'
      : 'Не удалось получить медиа. Добавь куки Instagram для стабильной работы.',
    details: errors,
    hasCookie,
  });
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ InstaLoader запущен: http://localhost:${PORT}`);
  if (!getCookie()) {
    console.log(`⚠️  Куки не настроены.\n`);
  } else {
    console.log(`🍪 Куки загружены!\n`);
  }
});

// Запускаем Telegram бота
pollTelegram().then(() => {}).catch(console.error);
console.log(`🤖 Telegram бот запущен!`);