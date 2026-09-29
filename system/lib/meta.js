// Posts to the user's own Facebook Page and Instagram Business account via the Meta Graph API.
// Uses their own tokens from .env. Read the honest limits at the bottom of this file.
const https = require('https');
const { loadEnv } = require('./telegram');

const GRAPH = 'graph.facebook.com';
const VERSION = 'v21.0';

function graphPost(path, params) {
  const body = new URLSearchParams(params).toString();
  const options = {
    hostname: GRAPH,
    path: `/${VERSION}/${path}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        const ok = res.statusCode === 200 && json && !json.error;
        resolve({ ok, status: res.statusCode, data: json, error: json && json.error && json.error.message });
      });
    });
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    req.write(body);
    req.end();
  });
}

function metaConfigured(env) {
  const e = env || loadEnv();
  return Boolean(e.META_PAGE_ID && e.META_PAGE_TOKEN);
}

// Facebook: simple text/link post to the Page feed.
async function postFacebookText({ message, link }, env) {
  const e = env || loadEnv();
  const params = { message: message || '', access_token: e.META_PAGE_TOKEN };
  if (link) params.link = link;
  return graphPost(`${e.META_PAGE_ID}/feed`, params);
}

// Facebook: photo post (needs a publicly reachable image URL).
async function postFacebookPhoto({ imageUrl, caption }, env) {
  const e = env || loadEnv();
  return graphPost(`${e.META_PAGE_ID}/photos`, { url: imageUrl, caption: caption || '', access_token: e.META_PAGE_TOKEN });
}

// Instagram: two-step publish. Requires a PUBLIC image URL (the API can't take a local file).
async function postInstagramPhoto({ imageUrl, caption }, env) {
  const e = env || loadEnv();
  if (!e.IG_USER_ID) return { ok: false, error: 'No IG_USER_ID set.' };
  if (!imageUrl) return { ok: false, error: 'Instagram needs a public image URL.' };
  const create = await graphPost(`${e.IG_USER_ID}/media`, { image_url: imageUrl, caption: caption || '', access_token: e.META_PAGE_TOKEN });
  if (!create.ok) return create;
  const creationId = create.data.id;
  return graphPost(`${e.IG_USER_ID}/media_publish`, { creation_id: creationId, access_token: e.META_PAGE_TOKEN });
}

// ── Carousels & video (multi-step / multipart) ─────────────────────────────
const fs = require('fs');

function graphGet(path, env) {
  const e = env || loadEnv();
  return new Promise((resolve) => {
    const req = https.request({ hostname: GRAPH, path: `/${VERSION}/${path}`, method: 'GET' }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ ok: res.statusCode === 200 && j && !j.error, data: j, error: j && j.error && j.error.message }); });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

// multipart/form-data POST (for uploading local photos/videos to Facebook).
function graphMultipart(pathName, fields, file) {
  const boundary = '----aibBoundary' + Date.now();
  const head = [];
  for (const [k, v] of Object.entries(fields)) {
    head.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  const fileBuf = fs.readFileSync(file.path);
  head.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([...head, fileBuf, tail]);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: GRAPH, path: `/${VERSION}/${pathName}`, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ ok: res.statusCode === 200 && j && !j.error, data: j, error: j && j.error && j.error.message }); });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write(body); req.end();
  });
}

// Facebook multi-photo post: upload each photo unpublished, then attach to one feed post.
async function postFacebookMultiPhoto({ imagePaths, caption }, env) {
  const e = env || loadEnv();
  const ids = [];
  for (const p of imagePaths) {
    const up = await graphMultipart(`${e.META_PAGE_ID}/photos`, { published: 'false', access_token: e.META_PAGE_TOKEN }, { field: 'source', path: p, filename: 'img.png', contentType: 'image/png' });
    if (!up.ok) return up;
    ids.push(up.data.id);
  }
  const params = { message: caption || '', access_token: e.META_PAGE_TOKEN };
  ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
  return graphPost(`${e.META_PAGE_ID}/feed`, params);
}

// Facebook video (reel/clip): direct multipart upload of the local MP4.
async function postFacebookVideo({ videoPath, caption }, env) {
  const e = env || loadEnv();
  return graphMultipart(`${e.META_PAGE_ID}/videos`, { description: caption || '', access_token: e.META_PAGE_TOKEN }, { field: 'source', path: videoPath, filename: 'reel.mp4', contentType: 'video/mp4' });
}

// Instagram carousel: each image must already be a PUBLIC URL (host them first).
async function postInstagramCarousel({ imageUrls, caption }, env) {
  const e = env || loadEnv();
  if (!e.IG_USER_ID) return { ok: false, error: 'No IG_USER_ID set.' };
  const children = [];
  for (const url of imageUrls) {
    const child = await graphPost(`${e.IG_USER_ID}/media`, { image_url: url, is_carousel_item: 'true', access_token: e.META_PAGE_TOKEN });
    if (!child.ok) return child;
    children.push(child.data.id);
  }
  const container = await graphPost(`${e.IG_USER_ID}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: caption || '', access_token: e.META_PAGE_TOKEN });
  if (!container.ok) return container;
  return graphPost(`${e.IG_USER_ID}/media_publish`, { creation_id: container.data.id, access_token: e.META_PAGE_TOKEN });
}

// Instagram reel: needs a PUBLIC video URL (IG can't take a local file). Polls until processed.
async function postInstagramReel({ videoUrl, caption }, env) {
  const e = env || loadEnv();
  if (!e.IG_USER_ID) return { ok: false, error: 'No IG_USER_ID set.' };
  if (!videoUrl) return { ok: false, error: 'Instagram reels need a public video URL (video hosting).' };
  const container = await graphPost(`${e.IG_USER_ID}/media`, { media_type: 'REELS', video_url: videoUrl, caption: caption || '', access_token: e.META_PAGE_TOKEN });
  if (!container.ok) return container;
  // Poll container status (IG must finish processing the video before publish).
  for (let i = 0; i < 20; i++) {
    const st = await graphGet(`${container.data.id}?fields=status_code&access_token=${e.META_PAGE_TOKEN}`, e);
    if (st.ok && st.data && st.data.status_code === 'FINISHED') break;
    if (st.ok && st.data && st.data.status_code === 'ERROR') return { ok: false, error: 'IG video processing failed.' };
    await new Promise((r) => setTimeout(r, 6000));
  }
  return graphPost(`${e.IG_USER_ID}/media_publish`, { creation_id: container.data.id, access_token: e.META_PAGE_TOKEN });
}

module.exports = {
  metaConfigured, postFacebookText, postFacebookPhoto, postInstagramPhoto,
  postFacebookMultiPhoto, postFacebookVideo, postInstagramCarousel, postInstagramReel,
};

// ── Honest limits (surface these to the user, don't hide them) ──────────────
// - Instagram (and FB photo) posts need a PUBLIC image URL. A local image file on the user's
//   computer won't work until it's hosted somewhere public. Text/link FB posts work directly.
// - Reels / video with TRENDING AUDIO cannot be posted via the API (platform restriction) —
//   those stay manual. This system handles image/text/carousel-style posts.
