#!/usr/bin/env node
/* Graba los videos MP4 de los tutoriales (uno por sección) a partir de los tours
 * interactivos definidos en webadmin/tutorial-guides.js.
 *
 * Cómo funciona:
 *   1. Genera la narración de cada paso con un motor TTS (por defecto espeak-ng + MBROLA,
 *      offline; opcionalmente OpenAI TTS si defines OPENAI_API_KEY) y mide su duración.
 *   2. Abre el panel con Playwright, inicia sesión, navega a la sección y reproduce el tour
 *      en "modo grabación" con los tiempos de cada paso iguales a la narración.
 *   3. Une video (webm de Playwright) + narración con ffmpeg → webadmin/videos/<seccion>.mp4
 *      y escribe webadmin/videos/manifest.json (lo lee el Centro de aprendizaje).
 *
 * Uso:  node scripts/record-tutorials.js [--only=orders,inbound] [--base=http://localhost:3000]
 *       Requiere el servidor corriendo con datos demo:  npm run start:demo
 * Env:  TTS=none (default, sin voz) | espeak | openai   ESPEAK_VOICE=mb-mx2   OPENAI_API_KEY=...   OPENAI_TTS_VOICE=nova
 *       CHROME=/ruta/a/chrome (si Playwright no encuentra su Chromium)
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'webadmin', 'videos');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }));
const BASE = args.base || 'http://localhost:3000';
const ONLY = args.only ? String(args.only).split(',') : null;
// Por defecto los videos se graban SIN narración (TTS=none): el texto de cada paso ya va en pantalla.
// TTS=espeak (voz sintética offline) u OPENAI_API_KEY / TTS=openai para agregar voz.
const TTS = process.env.TTS || 'none';
const SILENT = TTS === 'none';
const ESPEAK_VOICE = process.env.ESPEAK_VOICE || 'mb-mx2';
const PAD_MS = 1100;          // aire entre narración y cambio de paso
const W = 1440, H = 900;

// ---- Contenido de los tours (mismo archivo que usa el panel) ----------------
const guidesSrc = fs.readFileSync(path.join(ROOT, 'webadmin', 'tutorial-guides.js'), 'utf8');
const sandbox = { window: {} }; new Function('window', guidesSrc)(sandbox.window);
const GUIDES = sandbox.window.NINJA_TOUR_GUIDES;

// Quién graba cada sección (el rol determina qué pasos se ven).
const PLATFORM_PAGES = ['pkgmatrix', 'operations', 'usage', 'announcements'];
const USERS = { admin: { email: 'ana@ninjahubs.cl', pass: 'demo1234', role: 'ADMIN' }, root: { email: process.env.ROOT_EMAIL || 'admin@ninjahubs.cl', pass: process.env.ROOT_PASSWORD || 'admin1234', role: 'PLATFORM_ADMIN' } };

// ---- Texto → voz -------------------------------------------------------------
const SAY = [[/\bSKUs\b/g, 'esquiús'], [/\bSKU\b/g, 'esquiú'], [/\bKPIs\b/g, 'kapeís'], [/\bKPI\b/g, 'kapeí'], [/\b3PL\b/g, 'tres pe ele'],
  [/\bWMS\b/g, 'doble ve eme ese'], [/\bOMS\b/g, 'o eme ese'], [/\bEAN\b/g, 'e a ene'], [/\bDUN\b/g, 'dun'], [/\bPDF\b/g, 'pe de efe'], [/\bQA\b/g, 'control de calidad'],
  [/\bURL\b/g, 'u erre ele'], [/\bHTTP\b/g, 'hache te te pe'], [/\bB2B\b/g, 'be a be'], [/\bB2C\b/g, 'be a ce'], [/\bIA\b/g, 'inteligencia artificial'], [/\bABC\b/g, 'a be ce'],
  [/\bFIFO\b/g, 'fifo'], [/\bID\b/g, 'identificador'], [/\bCLP\b/g, 'pesos'], [/\bUSD\b/g, 'dólares'], [/\bu\/h\b/g, 'unidades por hora'], [/\bMP4\b/g, 'video'],
  [/OR-AAAAMMDD-XXXX/g, 'o erre, fecha, correlativo'], [/24\/7/g, 'las veinticuatro horas'], [/→/g, ', luego '], [/[«»]/g, ''], [/%/g, ' por ciento'], [/\s+/g, ' ']];
function plain(html) { return String(html).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim(); }
function sayable(t) { let s = plain(t); for (const [re, to] of SAY) s = s.replace(re, to); return s.trim(); }

function ffprobeMs(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Math.round(parseFloat(r.stdout) * 1000) || 0;
}
async function synth(text, wav) {
  if (SILENT) return Math.max(3500, 70 * text.length); // tiempo de lectura cómodo (~14 caracteres/seg)
  if (TTS === 'openai') {
    const res = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts', voice: process.env.OPENAI_TTS_VOICE || 'nova', input: text, response_format: 'wav', instructions: 'Narración clara y cercana en español latinoamericano neutro, para un tutorial de software.' }) });
    if (!res.ok) throw new Error('OpenAI TTS ' + res.status + ' ' + (await res.text()));
    fs.writeFileSync(wav + '.raw.wav', Buffer.from(await res.arrayBuffer()));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav + '.raw.wav', '-ar', '44100', '-ac', '1', wav]); fs.unlinkSync(wav + '.raw.wav');
  } else {
    // espeak-ng → wav 16k (MBROLA) → normalizamos a 44.1k mono y un poco de reverb-free "aire".
    execFileSync('espeak-ng', ['-v', ESPEAK_VOICE, '-s', process.env.ESPEAK_SPEED || '150', '-p', process.env.ESPEAK_PITCH || '48', '-a', '170', '-w', wav + '.raw.wav', text], { stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav + '.raw.wav', '-af', 'highpass=f=90,lowpass=f=7500,dynaudnorm=g=7', '-ar', '44100', '-ac', '1', wav]); fs.unlinkSync(wav + '.raw.wav');
  }
  return ffprobeMs(wav);
}

// ---- Fuentes locales (la grabación no depende de Google Fonts) ---------------
const FONT_DIRS = (process.env.FONT_DIRS || '/tmp/fonts').split(':');
function findFont(file) { for (const d of FONT_DIRS) { const hits = walk(d).filter(p => p.endsWith('/' + file)); if (hits[0]) return hits[0]; } return null; }
function walk(d) { let out = []; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) out = out.concat(walk(p)); else out.push(p); } } catch (e) { } return out; }
const FONT_CSS = [['Sora', 'sora', [500, 600, 700, 800]], ['Inter', 'inter', [400, 500, 600, 700]], ['IBM Plex Mono', 'ibm-plex-mono', [500, 600]], ['Manrope', 'manrope', [400, 500, 600, 700, 800]]]
  .map(([fam, slug, ws]) => ws.map(w => `@font-face{font-family:"${fam}";font-weight:${w};font-style:normal;font-display:swap;src:url(${BASE}/__fonts/${slug}-latin-${w}-normal.woff2) format("woff2")}`).join('\n')).join('\n');

// ---- Grabación de una sección ----------------------------------------------
async function recordSection(browser, pg, tmp) {
  const g = GUIDES[pg]; const who = PLATFORM_PAGES.includes(pg) ? USERS.root : USERS.admin;
  const steps = g.steps.filter(s => !s.roles || s.roles.includes(who.role));
  // 1) narración
  const seg = { intro: null, steps: [], outro: null };
  seg.intro = { text: sayable(g.title + '. ' + g.summary), wav: path.join(tmp, pg + '-intro.wav') };
  seg.intro.ms = await synth(seg.intro.text, seg.intro.wav);
  for (let i = 0; i < steps.length; i++) { const s = { text: sayable(steps[i].title + '. ' + steps[i].text), wav: path.join(tmp, pg + '-s' + i + '.wav') }; s.ms = await synth(s.text, s.wav); seg.steps.push(s); }
  seg.outro = { text: sayable('¡Listo! ' + (g.outro || 'Ya puedes operar esta sección con autonomía. Vuelve a este tutorial cuando quieras.')), wav: path.join(tmp, pg + '-outro.wav') };
  seg.outro.ms = await synth(seg.outro.text, seg.outro.wav);
  const timings = { intro: seg.intro.ms + PAD_MS + 600, steps: seg.steps.map(s => s.ms + PAD_MS), outro: seg.outro.ms + 1500 };

  // 2) video
  const vdir = path.join(tmp, 'v-' + pg); fs.mkdirSync(vdir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: vdir, size: { width: W, height: H } }, locale: 'es-CL', timezoneId: 'America/Santiago' });
  await context.route(/fonts\.googleapis\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: FONT_CSS }));
  await context.route(/\/__fonts\//, r => { const f = findFont(r.request().url().split('/').pop()); f ? r.fulfill({ status: 200, contentType: 'font/woff2', body: fs.readFileSync(f) }) : r.fulfill({ status: 404, body: '' }); });
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => r.abort());
  const pageCreatedAt = Date.now();
  const page = await context.newPage();
  await page.goto(BASE + '/admin/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('nwms.tour.auto', 'false'); localStorage.setItem('nwms.tour.seen.v1', '{}'); });
  await page.fill('#lg-email', who.email); await page.fill('#lg-pass', who.pass); await page.click('#lg-btn');
  await page.waitForFunction(() => document.getElementById('loginov').classList.contains('off') && window.NinjaTour);
  await page.waitForTimeout(2200);
  await page.evaluate(() => { const a = document.getElementById('ann-x'); if (a) a.click(); }); // sin barra de anuncios en el video
  if (pg === 'multicliente') { await page.selectOption('#seller', '__all__'); }
  else if (pg !== 'dashboard') { await page.click('.nav[data-pg=' + pg + ']'); }
  await page.waitForTimeout(2600);
  await page.mouse.move(W / 2, H / 2);
  const tourStartedAt = Date.now();
  await page.evaluate(([p, t]) => { window.__ntDone = null; NinjaTour.start(p, { record: true, timings: t }).then(ok => { window.__ntDone = ok; }); return 1; }, [pg, timings]);
  const log = await (async () => {
    await page.waitForFunction(() => window.__ntDone !== null, null, { timeout: 15 * 60 * 1000 });
    return page.evaluate(() => window.__ntLog);
  })();
  await page.waitForTimeout(600);
  const offset = (tourStartedAt - pageCreatedAt) / 1000;
  await context.close();
  const webm = fs.readdirSync(vdir).map(f => path.join(vdir, f)).find(f => f.endsWith('.webm'));

  const mp4 = path.join(OUT, pg + '.mp4');
  if (SILENT) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', offset.toFixed(3), '-i', webm, '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-tune', 'animation', '-pix_fmt', 'yuv420p', '-r', '20', '-movflags', '+faststart', mp4]);
    const durS = ffprobeMs(mp4);
    return { file: pg + '.mp4', duration: Math.floor(durS / 60000) + ':' + String(Math.round(durS / 1000) % 60).padStart(2, '0'), seconds: Math.round(durS / 1000), steps: log.filter(e => e.k === 'step').length, tts: 'none', audio: false, recordedAt: new Date().toISOString() };
  }

  // 3) pista de audio según lo que realmente se mostró (pasos ocultos para el rol se saltan)
  const clips = [];
  for (const e of log) {
    if (e.k === 'intro') clips.push({ at: e.t + 400, wav: seg.intro.wav });
    else if (e.k === 'step' && seg.steps[e.i]) clips.push({ at: e.t + 900, wav: seg.steps[e.i].wav });
    else if (e.k === 'outro') clips.push({ at: e.t + 500, wav: seg.outro.wav });
  }
  const total = Math.max(...clips.map(c => c.at + ffprobeMs(c.wav))) + 1500;
  const audio = path.join(tmp, pg + '-mix.wav');
  const inputs = []; const filters = [];
  clips.forEach((c, i) => { inputs.push('-i', c.wav); filters.push(`[${i}]adelay=${Math.round(c.at)}|${Math.round(c.at)}[a${i}]`); });
  filters.push(clips.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad=whole_dur=${(total / 1000).toFixed(3)}[out]`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-ar', '44100', '-ac', '2', audio]);

  // 4) mux: recortamos el arranque (login/navegación) y unimos con la narración
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', offset.toFixed(3), '-i', webm, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-tune', 'animation', '-pix_fmt', 'yuv420p', '-r', '20', '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', mp4]);
  const dur = ffprobeMs(mp4);
  return { file: pg + '.mp4', duration: Math.floor(dur / 60000) + ':' + String(Math.round(dur / 1000) % 60).padStart(2, '0'), seconds: Math.round(dur / 1000), steps: log.filter(e => e.k === 'step').length, tts: TTS === 'openai' ? 'openai' : 'espeak/' + ESPEAK_VOICE, audio: true, recordedAt: new Date().toISOString() };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nwms-rec-'));
  const manifestPath = path.join(OUT, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  const pages = Object.keys(GUIDES).filter(p => !ONLY || ONLY.includes(p));
  const launch = { args: ['--no-proxy-server', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--force-device-scale-factor=1'] };
  if (process.env.CHROME) launch.executablePath = process.env.CHROME;
  const browser = await chromium.launch(launch);
  for (const pg of pages) {
    const t = Date.now(); process.stdout.write(`▶ ${pg} … `);
    try {
      const r = await recordSection(browser, pg, tmp);
      manifest[pg] = r; fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log(`ok ${r.duration} (${((Date.now() - t) / 1000).toFixed(0)}s)`);
    } catch (e) { console.log('ERROR', e.message.split('\n')[0]); }
  }
  await browser.close();
  console.log('Videos en', OUT);
})();
