const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const RESULT_CARD_SIZE = { width: Number(process.env.RESULT_CARD_WIDTH || 1200), height: Number(process.env.RESULT_CARD_HEIGHT || 675) };
const MVP_CARD_SIZE = { width: Number(process.env.MVP_CARD_WIDTH || 900), height: Number(process.env.MVP_CARD_HEIGHT || 1200) };

let browserPromise = null;
const logoDataUrlCache = new Map();
let ninjasTargetVisibleRatio = null;
let embeddedFontCssCache = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function ensureDataUrl(filePath) {
  if (!filePath) {
    return '';
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png'
    ? 'image/png'
    : ext === '.webp'
      ? 'image/webp'
      : (ext === '.jpg' || ext === '.jpeg')
        ? 'image/jpeg'
        : ext === '.woff2'
          ? 'font/woff2'
          : ext === '.woff'
            ? 'font/woff'
        : 'application/octet-stream';
  const bytes = fs.readFileSync(filePath);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function buildEmbeddedFontCss() {
  if (embeddedFontCssCache !== null) {
    return embeddedFontCssCache;
  }

  const fontDefs = [
    {
      family: 'FeedDisplay',
      weight: 700,
      style: 'normal',
      filePath: path.join(__dirname, '..', 'node_modules', '@fontsource', 'oswald', 'files', 'oswald-latin-700-normal.woff2'),
    },
    {
      family: 'FeedDisplay',
      weight: 400,
      style: 'normal',
      filePath: path.join(__dirname, '..', 'node_modules', '@fontsource', 'anton', 'files', 'anton-latin-400-normal.woff2'),
    },
    {
      family: 'FeedBody',
      weight: 700,
      style: 'normal',
      filePath: path.join(__dirname, '..', 'node_modules', '@fontsource', 'rajdhani', 'files', 'rajdhani-latin-700-normal.woff2'),
    },
    {
      family: 'FeedBody',
      weight: 600,
      style: 'normal',
      filePath: path.join(__dirname, '..', 'node_modules', '@fontsource', 'rajdhani', 'files', 'rajdhani-latin-600-normal.woff2'),
    },
  ];

  const blocks = [];
  for (const font of fontDefs) {
    if (!fs.existsSync(font.filePath)) {
      continue;
    }
    const src = ensureDataUrl(font.filePath);
    blocks.push(
      `@font-face{font-family:'${font.family}';font-style:${font.style};font-weight:${font.weight};font-display:block;src:url('${src}') format('woff2');}`
    );
  }

  embeddedFontCssCache = blocks.join('');
  return embeddedFontCssCache;
}

function findNinjasLogoPath() {
  const candidates = [
    String(process.env.LOGO_DIR_CCS || '').trim(),
    String(process.env.LOGO_DIR_CPL || '').trim(),
    String(process.env.LOGO_DIR_CAS || '').trim(),
    String(process.env.LOGO_DIR_CNL || '').trim(),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        continue;
      }
      if (entry.name.toLowerCase().includes('ninjas')) {
        return path.join(dir, entry.name);
      }
    }
  }

  return '';
}

function getVisibleBounds(image) {
  const w = Math.max(1, Math.round(image.width));
  const h = Math.max(1, Math.round(image.height));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, w, h);
  const pixels = ctx.getImageData(0, 0, w, h).data;

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const alpha = pixels[(y * w + x) * 4 + 3];
      if (alpha <= 10) {
        continue;
      }
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    return { x: 0, y: 0, width: w, height: h, canvasWidth: w, canvasHeight: h };
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    canvasWidth: w,
    canvasHeight: h,
  };
}

async function getNinjasTargetVisibleRatio() {
  if (ninjasTargetVisibleRatio !== null) {
    return ninjasTargetVisibleRatio;
  }

  const ninjasPath = findNinjasLogoPath();
  if (!ninjasPath || !fs.existsSync(ninjasPath)) {
    ninjasTargetVisibleRatio = 0.78;
    return ninjasTargetVisibleRatio;
  }

  const image = await loadImage(ninjasPath);
  const bounds = getVisibleBounds(image);
  const ratioX = bounds.width / bounds.canvasWidth;
  const ratioY = bounds.height / bounds.canvasHeight;
  ninjasTargetVisibleRatio = Math.max(0.5, Math.min(0.95, Math.max(ratioX, ratioY)));
  return ninjasTargetVisibleRatio;
}

async function ensureNormalizedLogoDataUrl(filePath) {
  if (!filePath) {
    return '';
  }

  const stat = fs.statSync(filePath);
  const cacheKey = `${filePath}|${stat.mtimeMs}`;
  const cached = logoDataUrlCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const image = await loadImage(filePath);
  const bounds = getVisibleBounds(image);
  const targetRatio = await getNinjasTargetVisibleRatio();

  // Keep visible logo footprint consistent with Ninjas by adjusting transparent padding.
  const outW = Math.max(bounds.width, Math.round(bounds.width / targetRatio));
  const outH = Math.max(bounds.height, Math.round(bounds.height / targetRatio));
  const outCanvas = createCanvas(outW, outH);
  const outCtx = outCanvas.getContext('2d');
  const dx = Math.round((outW - bounds.width) / 2);
  const dy = Math.round((outH - bounds.height) / 2);
  outCtx.drawImage(
    image,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    dx,
    dy,
    bounds.width,
    bounds.height
  );

  const normalized = `data:image/png;base64,${outCanvas.toBuffer('image/png').toString('base64')}`;
  logoDataUrlCache.set(cacheKey, normalized);
  return normalized;
}

function applyVariables(template, vars) {
  let html = template;
  for (const [key, value] of Object.entries(vars)) {
    html = html.replaceAll(`{{${key}}}`, String(value ?? ''));
  }
  return html;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

async function renderTemplateToPng(templatePath, variables, size) {
  const template = fs.readFileSync(templatePath, 'utf8');
  const html = applyVariables(template, variables);

  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
  await page.setContent(html, { waitUntil: 'networkidle' });
  const png = await page.screenshot({ type: 'png' });
  await page.close();
  return png;
}

function getLeagueLogoTuning(league, cardType) {
  const code = String(league || '').trim().toUpperCase();
  const tune = { scale: 1, scaleX: 1, offsetYPercent: 0 };

  if (cardType === 'mvp') {
    // Stats card: CPL/CNL slightly smaller; nudge all marks down a little.
    tune.offsetYPercent = 4;
    if (code === 'CPL' || code === 'CNL') {
      tune.scale = 0.92;
    }
    return tune;
  }

  // Result card: CAS slightly larger and lower.
  if (cardType === 'result' && code === 'CAS') {
    tune.scale = 1.1;
    tune.scaleX = 1.24;
    tune.offsetYPercent = 8;
  }

  return tune;
}

function buildLeagueLogoMarkup(leagueLogoPath, options = {}) {
  if (!leagueLogoPath) {
    return '';
  }
  const dataUrl = ensureDataUrl(leagueLogoPath);
  if (!dataUrl) {
    return '';
  }
  const tune = getLeagueLogoTuning(options.league, options.cardType);
  const style = `transform: translateY(${Number(tune.offsetYPercent || 0)}%) scaleX(${Number(tune.scaleX || 1)}) scaleY(${Number(tune.scale || 1)});`;
  return `<img src="${dataUrl}" style="${style}" />`;
}

function computeMvpNameSizeVw(name) {
  const len = String(name || '').trim().length;
  if (len <= 9) return 14.2;
  if (len <= 11) return 12.8;
  if (len <= 13) return 11.3;
  if (len <= 15) return 10.1;
  if (len <= 18) return 9.2;
  return 8.4;
}

async function renderResultCard(data) {
  const templatePath = path.join(__dirname, '..', 'templates', 'result-feed', 'result.html');
  const homeLogoDataUrl = await ensureNormalizedLogoDataUrl(data.homeLogoPath);
  const awayLogoDataUrl = await ensureNormalizedLogoDataUrl(data.awayLogoPath);
  const vars = {
    EMBEDDED_FONT_CSS: buildEmbeddedFontCss(),
    LEAGUE: escapeHtml(data.leagueLabel || data.league || ''),
    WEEK: escapeHtml(data.week || ''),
    HOME_TEAM: escapeHtml(data.homeTeam || ''),
    AWAY_TEAM: escapeHtml(data.awayTeam || ''),
    HOME_WINS: escapeHtml(data.homeWins ?? 0),
    AWAY_WINS: escapeHtml(data.awayWins ?? 0),
    HOME_RECORD: data.homeRecord ? escapeHtml(`(${data.homeRecord})`) : '',
    AWAY_RECORD: data.awayRecord ? escapeHtml(`(${data.awayRecord})`) : '',
    RESULT_ACCENT_COLOR: escapeHtml(data.resultAccentColor || 'transparent'),
    HOME_LOGO: homeLogoDataUrl,
    AWAY_LOGO: awayLogoDataUrl,
    LEAGUE_LOGO: buildLeagueLogoMarkup(data.leagueLogoPath, { league: data.league, cardType: 'result' }),
  };

  return renderTemplateToPng(templatePath, vars, RESULT_CARD_SIZE);
}

async function renderMvpCard(data) {
  const templatePath = path.join(__dirname, '..', 'templates', 'result-feed', 'mvp.html');
  const vars = {
    EMBEDDED_FONT_CSS: buildEmbeddedFontCss(),
    MVP_NAME: escapeHtml(data.mvpName || 'TBD'),
    MVP_NAME_SIZE_VW: computeMvpNameSizeVw(data.mvpName || 'TBD'),
    MVP_LINE1: escapeHtml(data.mvpLine1 || ''),
    MVP_LINE2: escapeHtml(data.mvpLine2 || ''),
    MVP_SCORE: escapeHtml(data.mvpScore ?? 0),
    MVP_ACCENT_COLOR: escapeHtml(data.mvpAccentColor || '#e5e7eb'),
    MVP_LEFT_ACCENT_COLOR: escapeHtml(data.mvpLeftAccentColor || 'transparent'),
    LEAGUE_LOGO: buildLeagueLogoMarkup(data.leagueLogoPath, { league: data.league, cardType: 'mvp' }),
  };

  return renderTemplateToPng(templatePath, vars, MVP_CARD_SIZE);
}

module.exports = {
  renderResultCard,
  renderMvpCard,
  RESULT_CARD_SIZE,
  MVP_CARD_SIZE,
};
