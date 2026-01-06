// app.js
// deps: express, multer, puppeteer
// npm i express multer puppeteer

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs/promises');
const puppeteer = require('puppeteer');

const UPLOAD_DIR = 'uploads';
const upload = multer({ dest: UPLOAD_DIR });
const app = express();

app.use(express.json());

// config via ENV (defaults sensible)
const PORT = process.env.PORT || 3000;
const HEADLESS = process.env.HEADLESS === 'false' ? false : true;
const PAGE_IDLE_TIMEOUT_MS = Number(process.env.PAGE_IDLE_TIMEOUT_MS || 30_000); // close pages idle > 30s
const POOL_CLEAN_INTERVAL_MS = Number(process.env.POOL_CLEAN_INTERVAL_MS || 10_000);
const MAX_PAGE_POOL = Number(process.env.MAX_PAGE_POOL || 50); // soft cap for pool size (not hard concurrency limit)
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS || 30_000);

const TRANSLATE_BASE = 'https://translate.google.com/?op=images';

// --- Browser + Page Pool (dynamic, no hard concurrency limit) ---
let browserPromise = null;
async function ensureBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    }).catch(err => {
      console.error('Browser launch error:', err);
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

const pagePool = {
  pages: [], // { page, inUse: bool, lastUsed: timestamp }
  async acquire() {
    // try to find an idle page
    for (let i = 0; i < this.pages.length; i++) {
      const entry = this.pages[i];
      if (!entry.inUse) {
        entry.inUse = true;
        entry.lastUsed = Date.now();
        return entry.page;
      }
    }
    // no idle page -> create new (but respect soft cap)
    const b = await ensureBrowser();
    const browser = await b;
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });
    // minor optimization: block unneeded resources optionally (keeps it simple here)
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const t = req.resourceType();
      // allow most, but we could block fonts/analytics; keep simple and continue
      req.continue().catch(()=>{});
    });
    this.pages.push({ page, inUse: true, lastUsed: Date.now() });
    // if pool grows beyond soft cap, we won't create more entries in future clean cycles
    return page;
  },
  release(page) {
    const entry = this.pages.find(e => e.page === page);
    if (entry) {
      entry.inUse = false;
      entry.lastUsed = Date.now();
    } else {
      // page not from pool (rare) -> close it
      try { page.close().catch(()=>{}); } catch(e){}
    }
  },
  async clean() {
    const now = Date.now();
    // close pages idle > PAGE_IDLE_TIMEOUT_MS to save memory
    const survivors = [];
    for (const e of this.pages) {
      if (!e.inUse && (now - e.lastUsed) > PAGE_IDLE_TIMEOUT_MS) {
        try { await e.page.close().catch(()=>{}); } catch(e){}
      } else {
        survivors.push(e);
      }
    }
    // soft-trim if pool too large: keep most-recently-used pages
    if (survivors.length > MAX_PAGE_POOL) {
      // sort by lastUsed desc and keep top MAX_PAGE_POOL
      survivors.sort((a,b)=>b.lastUsed - a.lastUsed);
      const toKeep = survivors.slice(0, MAX_PAGE_POOL);
      const toClose = survivors.slice(MAX_PAGE_POOL);
      for (const e of toClose) {
        try { await e.page.close().catch(()=>{}); } catch(e){}
      }
      this.pages = toKeep;
    } else {
      this.pages = survivors;
    }
  },
  async closeAll() {
    for (const e of this.pages) {
      try { await e.page.close().catch(()=>{}); } catch(e){}
    }
    this.pages = [];
    if (browserPromise) {
      const b = await browserPromise.catch(()=>null);
      if (b) await b.close().catch(()=>{});
      browserPromise = null;
    }
  }
};

// run periodic cleaner
setInterval(() => {
  pagePool.clean().catch(err => {
    console.error('pagePool.clean error:', err);
  });
}, POOL_CLEAN_INTERVAL_MS);

// graceful shutdown
async function shutdown() {
  console.log('shutting down, closing browser and pages...');
  await pagePool.closeAll().catch(()=>{});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Utility: script to find image dataURL inside document and shadow roots
const findImageDataURLScript = `() => {
  function searchRoot(root) {
    // 1) canvas
    try {
      const canvases = root.querySelectorAll && root.querySelectorAll('canvas');
      if (canvases && canvases.length) {
        for (const c of canvases) {
          try {
            const d = c.toDataURL && c.toDataURL('image/png');
            if (d) return d;
          } catch(e) {}
        }
      }
    } catch(e){}
    // 2) img elements
    try {
      const imgs = root.querySelectorAll && Array.from(root.querySelectorAll('img'));
      if (imgs && imgs.length) {
        for (const img of imgs) {
          if (!img.complete) continue;
          if (img.src && img.src.startsWith('data:')) return img.src;
          if (img.src && img.naturalWidth > 0) {
            try {
              const c = document.createElement('canvas');
              c.width = img.naturalWidth;
              c.height = img.naturalHeight;
              const ctx = c.getContext('2d');
              ctx.drawImage(img,0,0);
              const d = c.toDataURL('image/png');
              if (d) return d;
            } catch(e){}
          }
        }
      }
    } catch(e){}
    // 3) background-image data:
    try {
      const all = root.querySelectorAll && Array.from(root.querySelectorAll('*'));
      if (all && all.length) {
        for (const el of all) {
          try {
            const bg = window.getComputedStyle(el).getPropertyValue('background-image') || '';
            const m = bg.match(/url\\(["']?(data:[^)'" ]+)["']?\\)/);
            if (m && m[1]) return m[1];
          } catch(e){}
        }
      }
    } catch(e){}
    // 4) children & shadow roots
    try {
      const children = root.children ? Array.from(root.children) : [];
      for (const ch of children) {
        if (ch.shadowRoot) {
          const r = searchRoot(ch.shadowRoot);
          if (r) return r;
        }
        const r2 = searchRoot(ch);
        if (r2) return r2;
      }
    } catch(e){}
    return null;
  }
  return searchRoot(document);
}`;

app.post('/translate-image', upload.single('image'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ ok:false, error: 'No image uploaded (field name: image).' });

  const from = (req.body.from || 'en').trim();
  const to = (req.body.to || 'fa').trim();
  const returnType = (req.query.return || req.body.return || 'png').toLowerCase(); // 'png' or 'json'
  const url = `${TRANSLATE_BASE}&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}`;

  const start = Date.now();
  let page = null;
  try {
    page = await pagePool.acquire();
    // navigate
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 }).catch(()=>{});
    const fileInputSelector = 'input[type="file"], input[name="file"]';
    await page.waitForSelector(fileInputSelector, { timeout: 15_000 });

    // upload file
    const inputHandle = await page.$(fileInputSelector);
    await inputHandle.uploadFile(path.resolve(file.path));

    // poll for translated image dataURL
    const deadline = Date.now() + MAX_WAIT_MS;
    let dataUrl = null;
    while (Date.now() < deadline) {
      await page.waitForTimeout(700);
      try {
        dataUrl = await page.evaluate(new Function('return (' + findImageDataURLScript + ')()'));
      } catch (e) {
        dataUrl = null;
      }
      if (dataUrl) break;
    }

    // fallback: full page screenshot if no dataUrl
    if (!dataUrl) {
      const fallback = await page.screenshot({ fullPage: true });
      await fs.rm(file.path).catch(()=>{});
      const took = Date.now() - start;
      pagePool.release(page);
      if (returnType === 'json') {
        return res.json({
          ok: true,
          info: { fallback: true, tookMs: took, note: 'Returned full-page screenshot because no embedded translated image found.' },
          imageBase64: 'data:image/png;base64,' + fallback.toString('base64')
        });
      } else {
        res.set('Content-Type','image/png');
        res.set('X-Note','fallback-fullpage-screenshot');
        res.set('X-Processed-Ms', String(took));
        return res.send(fallback);
      }
    }

    // normalize and return extracted image
    const prefix = 'data:image/png;base64,';
    const b64 = dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : dataUrl.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(b64, 'base64');
    const took = Date.now() - start;
    await fs.rm(file.path).catch(()=>{});
    pagePool.release(page);

    if (returnType === 'json') {
      return res.json({ ok: true, info:{ tookMs: took }, imageBase64: 'data:image/png;base64,' + b64 });
    } else {
      res.set('Content-Type','image/png');
      res.set('Content-Length', String(buffer.length));
      res.set('X-Processed-Ms', String(took));
      return res.send(buffer);
    }

  } catch (err) {
    if (page) {
      try { pagePool.release(page); } catch(e){};
    }
    if (file) await fs.rm(file.path).catch(()=>{});
    console.error('/translate-image error:', err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

app.get('/', (req,res) => res.send('translate-image service running'));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}  (HEADLESS=${HEADLESS})`);
});
