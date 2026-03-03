const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { drawStyledText } = require('../renderText');
const { OUTPUT_SIZE, SCALE, STYLE_TUNING, PATHS } = require('../config');

function ensureOutputDir() {
  fs.mkdirSync(PATHS.outputDir, { recursive: true });
}

async function drawLogoSafe(ctx, logoPath, x, y, width, height) {
  if (!logoPath) {
    return;
  }
  const filePath = path.resolve(logoPath);
  if (!fs.existsSync(filePath)) {
    return;
  }
  const image = await loadImage(filePath);

  const ratio = Math.min(width / image.width, height / image.height);
  const w = image.width * ratio;
  const h = image.height * ratio;
  const drawX = x + (width - w) / 2;
  const drawY = y + (height - h) / 2;

  ctx.drawImage(image, drawX, drawY, w, h);
}

function drawBackground(ctx, width, height) {
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, '#111111');
  grad.addColorStop(1, '#09112a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  const redGlow = ctx.createRadialGradient(width * 0.2, height * 0.1, 0, width * 0.2, height * 0.1, width * 0.6);
  redGlow.addColorStop(0, 'rgba(180,20,34,0.38)');
  redGlow.addColorStop(1, 'rgba(180,20,34,0)');
  ctx.fillStyle = redGlow;
  ctx.fillRect(0, 0, width, height);

  const redGlow2 = ctx.createRadialGradient(width * 0.8, height * 0.12, 0, width * 0.8, height * 0.12, width * 0.6);
  redGlow2.addColorStop(0, 'rgba(180,20,34,0.34)');
  redGlow2.addColorStop(1, 'rgba(180,20,34,0)');
  ctx.fillStyle = redGlow2;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, width - 8, height - 8);
}

function drawLeagueWatermark(ctx, width, height) {
  ctx.save();
  ctx.globalAlpha = 0.13;
  ctx.fillStyle = '#d7dde8';
  ctx.beginPath();
  ctx.arc(width * 0.5, height * 0.53, width * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.arc(width * 0.5, height * 0.53, width * 0.24, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function downsampleCanvas(hiResCanvas, targetSize = OUTPUT_SIZE) {
  const out = createCanvas(targetSize.width, targetSize.height);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(hiResCanvas, 0, 0, targetSize.width, targetSize.height);
  return out;
}

async function weekResultCard(data, options = {}) {
  const width = Number((options.outputSize || OUTPUT_SIZE).width) * SCALE;
  const height = Number((options.outputSize || OUTPUT_SIZE).height) * SCALE;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  drawBackground(ctx, width, height);
  drawLeagueWatermark(ctx, width, height);

  const fonts = options.fonts || {};
  const tune = { ...STYLE_TUNING, ...(options.tuning || {}) };

  const logoBoxW = width * 0.30;
  const logoBoxH = height * 0.33;
  await drawLogoSafe(ctx, data.homeLogoPath, width * 0.07, height * 0.19, logoBoxW, logoBoxH);
  await drawLogoSafe(ctx, data.awayLogoPath, width * 0.63, height * 0.19, logoBoxW, logoBoxH);

  const leagueTitle = String(data.leagueTitle || '').toUpperCase();
  const leagueFontScale = leagueTitle.length > 12 ? 0.039 : 0.058;
  drawStyledText(ctx, {
    text: leagueTitle,
    x: width * 0.5,
    y: height * 0.12,
    fontSize: width * leagueFontScale,
    fontFamily: fonts.headline,
    italic: true,
    align: 'center',
    strokeScale: tune.strokeScale,
    letterSpacing: tune.letterSpacing.headline * SCALE,
    shadowBlur: tune.shadowBlur * SCALE,
    shadowOffsetX: tune.shadowOffsetX * SCALE,
    shadowOffsetY: tune.shadowOffsetY * SCALE,
    gradientTop: tune.gradientTop,
    gradientBottom: tune.gradientBottom,
    skewX: tune.skewX,
  });

  drawStyledText(ctx, {
    text: `${data.homeScore}-${data.awayScore}`,
    x: width * 0.5,
    y: height * 0.49,
    fontSize: width * 0.24,
    fontFamily: fonts.numbers,
    italic: true,
    align: 'center',
    strokeScale: tune.strokeScale,
    letterSpacing: tune.letterSpacing.numbers * SCALE,
    shadowBlur: (tune.shadowBlur + 4) * SCALE,
    shadowOffsetX: (tune.shadowOffsetX + 1) * SCALE,
    shadowOffsetY: (tune.shadowOffsetY + 1) * SCALE,
    gradientTop: '#E7E7E7',
    gradientBottom: '#A2A2A2',
    skewX: -0.1,
  });

  drawStyledText(ctx, {
    text: String(data.homeTeamName || '').toUpperCase(),
    x: width * 0.22,
    y: height * 0.58,
    fontSize: width * 0.042,
    fontFamily: fonts.stats,
    italic: true,
    align: 'center',
    strokeScale: tune.strokeScale * 0.6,
    letterSpacing: tune.letterSpacing.stats * SCALE,
    fillMode: 'solid',
    fillColor: '#F3F4F6',
    skewX: tune.skewX,
  });

  drawStyledText(ctx, {
    text: String(data.awayTeamName || '').toUpperCase(),
    x: width * 0.78,
    y: height * 0.58,
    fontSize: width * 0.042,
    fontFamily: fonts.stats,
    italic: true,
    align: 'center',
    strokeScale: tune.strokeScale * 0.6,
    letterSpacing: tune.letterSpacing.stats * SCALE,
    fillMode: 'solid',
    fillColor: '#F3F4F6',
    skewX: tune.skewX,
  });

  if (data.homeRecord) {
    drawStyledText(ctx, {
      text: `(${data.homeRecord})`,
      x: width * 0.22,
      y: height * 0.66,
      fontSize: width * 0.033,
      fontFamily: fonts.stats,
      italic: true,
      align: 'center',
      strokeScale: tune.strokeScale * 0.55,
      fillMode: 'solid',
      fillColor: '#D1D5DB',
      skewX: tune.skewX,
    });
  }

  if (data.awayRecord) {
    drawStyledText(ctx, {
      text: `(${data.awayRecord})`,
      x: width * 0.78,
      y: height * 0.66,
      fontSize: width * 0.033,
      fontFamily: fonts.stats,
      italic: true,
      align: 'center',
      strokeScale: tune.strokeScale * 0.55,
      fillMode: 'solid',
      fillColor: '#D1D5DB',
      skewX: tune.skewX,
    });
  }

  drawStyledText(ctx, {
    text: String(data.weekLabel || '').toUpperCase(),
    x: width * 0.5,
    y: height * 0.90,
    fontSize: width * 0.078,
    fontFamily: fonts.headline,
    italic: true,
    align: 'center',
    strokeScale: tune.strokeScale,
    letterSpacing: tune.letterSpacing.headline * SCALE,
    shadowBlur: tune.shadowBlur * SCALE,
    shadowOffsetX: tune.shadowOffsetX * SCALE,
    shadowOffsetY: tune.shadowOffsetY * SCALE,
    gradientTop: tune.gradientTop,
    gradientBottom: tune.gradientBottom,
    skewX: tune.skewX,
  });

  const outCanvas = downsampleCanvas(canvas, options.outputSize || OUTPUT_SIZE);
  const png = outCanvas.toBuffer('image/png');

  ensureOutputDir();
  const matchId = String(data.matchId || 'sample').trim();
  const filePath = path.join(PATHS.outputDir, `week_result_${matchId}.png`);
  fs.writeFileSync(filePath, png);

  return { filePath, buffer: png };
}

module.exports = {
  weekResultCard,
};
