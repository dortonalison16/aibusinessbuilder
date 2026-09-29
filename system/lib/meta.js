// Posts to the user's own Facebook Page and Instagram Business account via the Meta Graph API.
// Uses their own tokens from .env. Read the honest limits at the bottom of this file.
const https = require('https');
const { loadEnv } = require('./telegram');

const GRAPH = 'graph.facebook.com';
const GRAPH_VIDEO = 'graph-video.facebook.com'; // Meta's host for video uploads
// Meta retires each Graph API version ~2 years after release (v21 dies Jan 2027). Default to a
// long-lived version; META_GRAPH_VERSION in .env overrides it without a code change.
const DEFAULT_VERSION = 'v24.0';
const VERSION = (loadEnv().META_GRAPH_VERSION || DEFAULT_VERSION).replace(/^(?!v)/, 'v');

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
    req.setTimeout(120000, () => req.destroy(new Error('timed out after 120s'))); // a stalled connection must not hang a scheduled job
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
  const ready = await waitForContainer(creationId, e, 10);
  if (!ready.ok) return ready;
  return graphPost(`${e.IG_USER_ID}/media_publish`, { creation_id: creationId, access_token: e.META_PAGE_TOKEN });
}

// Instagram story (image). Stories take no caption.
async function postInstagramStory({ imageUrl }, env) {
  const e = env || loadEnv();
  if (!e.IG_USER_ID) return { ok: false, error: 'No IG_USER_ID set.' };
  if (!imageUrl) return { ok: false, error: 'Instagram needs a public image URL.' };
  const create = await graphPost(`${e.IG_USER_ID}/media`, { media_type: 'STORIES', image_url: imageUrl, access_token: e.META_PAGE_TOKEN });
  if (!create.ok) return create;
  const ready = await waitForContainer(create.data.id, e, 10);
  if (!ready.ok) return ready;
  return graphPost(`${e.IG_USER_ID}/media_publish`, { creation_id: create.data.id, access_token: e.META_PAGE_TOKEN });
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
    req.setTimeout(60000, () => req.destroy(new Error('timed out after 60s'))); // a stalled connection must not hang a scheduled job
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

// multipart/form-data POST (for uploading local photos/videos to Facebook).
function graphMultipart(pathName, fields, file, host = GRAPH) {
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
      hostname: host, path: `/${VERSION}/${pathName}`, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ ok: res.statusCode === 200 && j && !j.error, data: j, error: j && j.error && j.error.message }); });
    });
    req.setTimeout(600000, () => req.destroy(new Error('timed out after 600s'))); // a stalled connection must not hang a scheduled job
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

// Facebook single photo straight from a local file (no image hosting needed).
async function postFacebookLocalPhoto({ imagePath, caption }, env) {
  const e = env || loadEnv();
  const isJpg = /.jpe?g$/i.test(imagePath);
  return graphMultipart(`${e.META_PAGE_ID}/photos`, { caption: caption || '', access_token: e.META_PAGE_TOKEN }, { field: 'source', path: imagePath, filename: isJpg ? 'img.jpg' : 'img.png', contentType: isJpg ? 'image/jpeg' : 'image/png' });
}

// Facebook video (reel/clip): direct multipart upload of the local MP4.
async function postFacebookVideo({ videoPath, caption }, env) {
  const e = env || loadEnv();
  return graphMultipart(`${e.META_PAGE_ID}/videos`, { description: caption || '', access_token: e.META_PAGE_TOKEN }, { field: 'source', path: videoPath, filename: 'reel.mp4', contentType: 'video/mp4' }, GRAPH_VIDEO);
}

// Instagram must finish processing a media container before it can be published; publishing too
// early fails with "media is not ready". Polls status_code until FINISHED (or gives up cleanly).
async function waitForContainer(id, e, tries = 20, everyMs = 6000) {
  for (let i = 0; i < tries; i++) {
    const st = await graphGet(`${id}?fields=status_code&access_token=${encodeURIComponent(e.META_PAGE_TOKEN)}`, e);
    const code = st.ok && st.data && st.data.status_code;
    if (code === 'FINISHED') return { ok: true };
    if (code === 'ERROR' || code === 'EXPIRED') return { ok: false, error: `Instagram couldn't process this media (${code}).` };
    await new Promise((r) => setTimeout(r, i === 0 ? 2000 : everyMs));
  }
  return { ok: false, error: 'Instagram was still processing the media after several minutes — it will be retried next run.' };
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
  const ready = await waitForContainer(container.data.id, e, 10);
  if (!ready.ok) return ready;
  return graphPost(`${e.IG_USER_ID}/media_publish`, { creation_id: container.data.id, access_token: e.META_PAGE_TOKEN });
}

// Instagram reel: needs a PUBLIC video URL (IG can't take a local file). Polls until processed.
async function postInstagramReel({ videoUrl, caption }, env) {
  const e = env || loadEnv();
  if (!e.IG_USER_ID) return { ok: false, error: 'No IG_USER_ID set.' };
  if (!videoUrl) return { ok: false, error: 'Instagram reels need a public video URL (video hosting).' };
  const container = await graphPost(`${e.IG_USER_ID}/media`, { media_type: 'REELS', video_url: videoUrl, caption: caption || '', access_token: e.META_PAGE_TOKEN });
  if (!container.ok) return container;
  // IG must finish processing the video before publish — never publish a half-processed reel.
  const ready = await waitForContainer(container.data.id, e, 40);
  if (!ready.ok) return ready;
  return graphPost(`${e.IG_USER_ID}/media_publish`, { creation_id: container.data.id, access_token: e.META_PAGE_TOKEN });
}

module.exports = {
  metaConfigured, postFacebookText, postFacebookPhoto, postFacebookLocalPhoto, postInstagramPhoto,
  postInstagramStory, postFacebookMultiPhoto, postFacebookVideo, postInstagramCarousel, postInstagramReel,
  waitForContainer, VERSION,
};

// ── Honest limits (surface these to the user, don't hide them) ──────────────
// - Instagram (and FB photo) posts need a PUBLIC image URL. A local image file on the user's
//   computer won't work until it's hosted somewhere public. Text/link FB posts work directly.
// - Reels / video with TRENDING AUDIO cannot be posted via the API (platform restriction) —
//   those stay manual. This system handles image/text/carousel-style posts.
