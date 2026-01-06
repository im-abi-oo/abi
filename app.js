// app.js
// deps: express, multer, puppeteer
// نصب: npm i express multer puppeteer
// اجرا: node app.js

const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const path = require('path');
const puppeteer = require('puppeteer');

const UPLOAD_DIR = 'uploads';
const upload = multer({ dest: UPLOAD_DIR });
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const HEADLESS = process.env.HEADLESS === 'false' ? false : true;
const MAX_WAIT_MS = 30000;

const TRANSLATE_URL = 'https://translate.google.com/?op=images';

// --- Browser Singleton ---
let browserInstance = null;
async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: HEADLESS,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
    });
  }
  return browserInstance;
}

// --- Find translated image dataURL inside DOM & shadow roots ---
const findImageDataURLScript = `() => {
  function search(root) {
    // canvas
    try {
      const canvases = root.querySelectorAll && root.querySelectorAll('canvas');
      for (const c of canvases) { try { const d=c.toDataURL(); if(d) return d; } catch(e){} }
    } catch(e){}
    // images
    try {
      const imgs = root.querySelectorAll && Array.from(root.querySelectorAll('img'));
      for (const img of imgs) {
        if(img.complete && img.src){
          if(img.src.startsWith('data:')) return img.src;
          try{ const c=document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight;
          const ctx=c.getContext('2d'); ctx.drawImage(img,0,0); return c.toDataURL(); }catch(e){}
        }
      }
    } catch(e){}
    // shadow children
    try {
      const children = root.children?Array.from(root.children):[];
      for(const ch of children){
        if(ch.shadowRoot){ const r=search(ch.shadowRoot); if(r) return r; }
        const r2=search(ch); if(r2) return r2;
      }
    } catch(e){}
    return null;
  }
  return search(document);
}`;

app.post('/translate-image', upload.single('image'), async (req,res)=>{
  const file = req.file;
  if(!file) return res.status(400).json({ok:false,error:'No image uploaded (field name=image).'});

  const from = (req.body.from||'en').trim();
  const to = (req.body.to||'fa').trim();
  const returnType = (req.query.return||req.body.return||'png').toLowerCase();
  const url = `${TRANSLATE_URL}&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}`;

  const start = Date.now();
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({width:1200,height:900});
    await page.goto(url,{waitUntil:'networkidle2',timeout:30000});
    
    const inputSelector='input[type="file"],input[name="file"]';
    await page.waitForSelector(inputSelector,{timeout:15000});
    const inputHandle = await page.$(inputSelector);
    await inputHandle.uploadFile(path.resolve(file.path));

    // poll for translated image
    let dataUrl = null;
    const deadline = Date.now() + MAX_WAIT_MS;
    while(Date.now()<deadline){
      await page.waitForTimeout(700);
      try{ dataUrl = await page.evaluate(new Function('return ('+findImageDataURLScript+')()')); }catch(e){ dataUrl=null; }
      if(dataUrl) break;
    }

    if(!dataUrl){
      // fallback full page screenshot
      const fallback = await page.screenshot({fullPage:true});
      await fs.rm(file.path).catch(()=>{});
      await page.close();
      return returnType==='json' ? res.json({ok:true,fallback:true,imageBase64:'data:image/png;base64,'+fallback.toString('base64')}) : res.type('png').send(fallback);
    }

    const prefix = 'data:image/png;base64,';
    const b64 = dataUrl.startsWith(prefix)?dataUrl.slice(prefix.length):dataUrl.replace(/^data:[^;]+;base64,/,'');
    const buffer = Buffer.from(b64,'base64');
    await fs.rm(file.path).catch(()=>{});
    await page.close();

    if(returnType==='json'){
      return res.json({ok:true,imageBase64:'data:image/png;base64,'+b64});
    } else {
      res.set('Content-Type','image/png');
      return res.send(buffer);
    }

  }catch(err){
    if(page) try{await page.close();}catch(e){}
    if(file) await fs.rm(file.path).catch(()=>{});
    console.error(err);
    return res.status(500).json({ok:false,error:String(err)});
  }
});

app.get('/',(req,res)=>res.send('translate-image service running'));

app.listen(PORT,()=>console.log(`Server listening http://localhost:${PORT} HEADLESS=${HEADLESS}`));
