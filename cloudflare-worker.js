/**
 * W4TCH US — Cloudflare Worker Proxy
 * 
 * KURULUM (2 dakika, ücretsiz):
 * 1. https://workers.cloudflare.com → Kayıt ol (ücretsiz)
 * 2. "Create Worker" → Bu kodu yapıştır → Deploy
 * 3. Sana bir URL verir: https://w4tch-proxy.KULLANICIN.workers.dev
 * 4. room.html içindeki PROXY_URL değişkenine bu adresi yaz
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    });
  }

  // Hedef URL al
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return new Response(JSON.stringify({ error: 'url parametresi gerekli' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  // Health check
  if (targetUrl === 'ping') {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  try {
    const target = new URL(targetUrl);

    // Fetch modu: html veya detect
    const mode = url.searchParams.get('mode') || 'proxy';

    if (mode === 'detect') {
      // Sadece HTML'i çek, video URL'lerini bul, JSON döndür
      return await detectVideos(target.toString(), request);
    }

    // Proxy modu: tam sayfayı çek
    const response = await fetch(target.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
        'Referer': 'https://www.google.com/',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
    });

    // Response headers'ı temizle (iframe engellerini kaldır)
    const newHeaders = new Headers();
    const contentType = response.headers.get('content-type') || 'text/html';
    newHeaders.set('Content-Type', contentType);
    newHeaders.set('Access-Control-Allow-Origin', '*');
    // Kritik: X-Frame-Options ve CSP'yi SİL → iframe açılsın
    // (Silinen headerlar: X-Frame-Options, Content-Security-Policy, 
    //  X-Content-Type-Options, Strict-Transport-Security)

    let body = response.body;

    // HTML ise linkleri düzenle (relative → absolute)
    if (contentType.includes('text/html')) {
      let html = await response.text();
      html = rewriteHtml(html, target.toString());
      body = html;
      newHeaders.set('Content-Type', 'text/html; charset=utf-8');
    }

    return new Response(body, {
      status: response.status,
      headers: newHeaders,
    });

  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Proxy hatası: ' + err.message,
      url: targetUrl
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

// HTML'deki relative URL'leri absolute yap
function rewriteHtml(html, baseUrl) {
  const base = new URL(baseUrl);
  const origin = base.origin;

  // <base> tag ekle → relative linkler çalışsın
  if (!html.includes('<base')) {
    html = html.replace('<head>', `<head><base href="${baseUrl}">`);
    if (!html.includes('<base')) {
      html = `<base href="${baseUrl}">` + html;
    }
  }

  return html;
}

// Video tespiti modu
async function detectVideos(url, request) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,*/*',
        'Referer': 'https://www.google.com/',
      },
      redirect: 'follow',
    });

    const html = await response.text();
    const videos = parseVideosFromHtml(html, url);

    return new Response(JSON.stringify({
      ok: true,
      url,
      videos,
      title: extractTitle(html),
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message, videos: [] }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

function parseVideosFromHtml(html, baseUrl) {
  const videos = [];
  const seen = new Set();

  function add(url, type, src) {
    if (!url || seen.has(url)) return;
    if (url.length > 2000) return;
    if (/\.(jpg|jpeg|png|gif|webp|svg|css|woff)(\?|$)/i.test(url)) return;
    seen.add(url);
    videos.push({ url, type, src, quality: guessQuality(url) });
  }

  function abs(u) {
    try {
      return new URL(u, baseUrl).toString();
    } catch { return u; }
  }

  // video src
  for (const m of html.matchAll(/video[^>]+src=["']([^"']+)["']/gi))
    add(abs(m[1]), guessType(m[1]), 'video-tag');

  // source src
  for (const m of html.matchAll(/source[^>]+src=["']([^"']+)["']/gi))
    add(abs(m[1]), guessType(m[1]), 'source-tag');

  // iframe YouTube/Vimeo
  for (const m of html.matchAll(/iframe[^>]+src=["']([^"']+)["']/gi)) {
    const s = m[1];
    if (/youtube\.com|youtu\.be/.test(s)) add(abs(s), 'youtube', 'iframe');
    if (/vimeo\.com/.test(s)) add(abs(s), 'vimeo', 'iframe');
    if (/dailymotion\.com/.test(s)) add(abs(s), 'dailymotion', 'iframe');
  }

  // M3U8 manifest
  for (const m of html.matchAll(/["'`]([^"'`]*\.m3u8[^"'`]{0,80})["'`]/gi))
    add(m[1].startsWith('http') ? m[1] : abs(m[1]), 'hls', 'm3u8');

  // MPD manifest
  for (const m of html.matchAll(/["'`]([^"'`]*\.mpd[^"'`]{0,80})["'`]/gi))
    add(m[1].startsWith('http') ? m[1] : abs(m[1]), 'dash', 'mpd');

  // MP4/WebM direkt
  for (const m of html.matchAll(/["'`]([^"'`]*\.(mp4|webm|mkv)[^"'`]{0,60})["'`]/gi))
    add(m[1].startsWith('http') ? m[1] : abs(m[1]), 'mp4', 'direct');

  // JS değişkenler
  for (const m of html.matchAll(/(?:file|src|url|videoUrl|hls_url)\s*[:=]\s*["'`]([^"'`]{15,500})["'`]/gi)) {
    const u = m[1];
    if (/\.(m3u8|mpd|mp4|webm)/.test(u))
      add(u.startsWith('http') ? u : abs(u), guessType(u), 'js-var');
  }

  // og:video meta
  for (const m of html.matchAll(/og:video[^>]+content=["']([^"']+)["']/gi))
    add(m[1], guessType(m[1]), 'og-meta');

  return videos;
}

function guessType(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('.m3u8')) return 'hls';
  if (u.includes('.mpd'))  return 'dash';
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (u.includes('vimeo.com')) return 'vimeo';
  if (u.includes('dailymotion')) return 'dailymotion';
  return 'mp4';
}

function guessQuality(url) {
  for (const [p, q] of [['2160','4K'],['1440','2K'],['1080','1080p'],['720','720p'],['480','480p'],['360','360p']])
    if (url.includes(p)) return q;
  return 'HD';
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : '';
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
