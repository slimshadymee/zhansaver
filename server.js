const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Загрузка куки из config.json ───────────────────────────────────────────
function getCookie() {
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

// ─── Метод 1: API ?__a=1 (работает с куками) ────────────────────────────────
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
  // Получаем csrftoken из куки
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

  // og:image
  for (const m of html.matchAll(/property="og:image"\s+content="([^"]+)"/g)) {
    const u = m[1].replace(/&amp;/g, '&');
    if (!media.find(r => r.url === u)) media.push({ url: u, type: 'image' });
  }
  // og:video
  for (const m of html.matchAll(/property="og:video(?::url)?"\s+content="([^"]+)"/g)) {
    const u = m[1].replace(/&amp;/g, '&');
    if (!media.find(r => r.url === u)) media.push({ url: u, type: 'video' });
  }

  // JSON в script тегах
  for (const m of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try { findMediaInJson(JSON.parse(m[1]), media); } catch {}
  }

  // window.__additionalDataLoaded
  const addDataMatch = html.match(/window\.__additionalDataLoaded\s*\([^,]+,\s*({.+?})\s*\);/s);
  if (addDataMatch) {
    try { findMediaInJson(JSON.parse(addDataMatch[1]), media); } catch {}
  }

  if (!media.length) throw new Error('No media in HTML');
  return media;
}

// ─── Прокси для скачивания (обходит CORS) ────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('No URL');
  try {
    const response = await axios.get(url, {
      headers: {
        ...getHeaders(),
        'Accept': 'image/*, video/*, */*',
      },
      responseType: 'stream',
      timeout: 60000,
    });
    const ct = response.headers['content-type'] || 'image/jpeg';
    const ext = ct.includes('video') ? 'mp4' : 'jpg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `attachment; filename="instagram_${Date.now()}.${ext}"`);
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }
    response.data.pipe(res);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ─── Статус куки ──────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const cookie = getCookie();
  res.json({ hasCookie: !!cookie });
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

app.listen(PORT, () => {
  const hasCookie = !!getCookie();
  console.log(`\n✅ InstaLoader запущен: http://localhost:${PORT}`);
  if (!hasCookie) {
    console.log(`⚠️  Куки не настроены. Открой http://localhost:${PORT} и вставь куки в настройках.\n`);
  } else {
    console.log(`🍪 Куки загружены — работаем с авторизацией!\n`);
  }
});
