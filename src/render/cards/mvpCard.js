const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const { drawStyledText } = require('../renderText');
const { OUTPUT_SIZE, SCALE, STYLE_TUNING, PATHS } = require('../config');

function ensureOutputDir() {
  fs.mkdirSync(PATHS.outputDir, { recursive: true });
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

  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = '#d7dde8';
  ctx.beginPath();
  ctx.arc(width * 0.5, height * 0.55, width * 0.34, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, width - 8, height - 8);
}

function downsampleCanvas(hiResCanvas, targetSize = OUTPUT_SIZE) {
  const out = createCanvas(targetSize.width, targetSize.height);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(hiResCanvas, 0, 0, targetSize.width, targetSize.height);
  return out;
}

function getFittedFontSize(ctx, text, fontFamily, fontWeight, italic, desiredSize, maxWidth, letterSpacing = 0, minSize = 24) {
  let size = desiredSize;
  const content = String(text || '');
  while (size > minSize) {
    ctx.font = `${italic ? 'italic ' : ''}${fontWeight} ${size}px "${fontFamily}"`;
    const chars = [...content];
    let measured = 0;
    for (const ch of chars) {
      measured += ctx.measureText(ch).width;
    }
    measured += letterSpacing * Math.max(0, chars.length - 1);
    if (measured <= maxWidth) {
      return size;
    }
    size -= 2;
  }
  return Math.max(minSize, size);
}

async function mvpCard(data, options = {}) {
  const width = Number((options.outputSize || OUTPUT_SIZE).width) * SCALE;
  const height = Number((options.outputSize || OUTPUT_SIZE).height) * SCALE;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  drawBackground(ctx, width, height);

  const fonts = options.fonts || {};
  const tune = { ...STYLE_TUNING, ...(options.tuning || {}) };
  const mvpSkew = tune.skewX * 0.45;

  const accent = data.accentColor || '#D1D5DB';
  const maxTextWidth = width * 0.86;
  const playerNameText = String(data.playerName || '').toUpperCase();
  const line1Text = String(data.statsLine1 || '').toUpperCase();
  const line2Text = String(data.statsLine2 || '').toUpperCase();
  const totalScoreText = String(data.totalScore || '').toUpperCase();
  const footerText = String(data.footer || 'MORE INFO ON THE WEBSITE BELOW').toUpperCase();

  const playerNameSize = getFittedFontSize(
    ctx,
    playerNameText,
    fonts.headline || 'Arial Black',
    '900',
    true,
    width * 0.12,
    maxTextWidth,
    tune.letterSpacing.headline * SCALE,
    width * 0.06
  );
  const line1Size = getFittedFontSize(
    ctx,
    line1Text,
    fonts.stats || 'Arial Bold',
    '900',
    true,
    width * 0.058,
    maxTextWidth,
    tune.letterSpacing.stats * SCALE,
    width * 0.036
  );
  const line2Size = getFittedFontSize(
    ctx,
    line2Text,
    fonts.stats || 'Arial Bold',
    '900',
    true,
    width * 0.058,
    maxTextWidth,
    tune.letterSpacing.stats * SCALE,
    width * 0.036
  );
  const totalSize = getFittedFontSize(
    ctx,
    `TOTAL SCORE: ${totalScoreText}`,
    fonts.stats || 'Arial Bold',
    '900',
    true,
    width * 0.062,
    maxTextWidth,
    tune.letterSpacing.stats * SCALE,
    width * 0.04
  );
  const footerSize = getFittedFontSize(
    ctx,
    footerText,
    fonts.stats || 'Arial Bold',
    '900',
    true,
    width * 0.034,
    maxTextWidth,
    tune.letterSpacing.stats * SCALE,
    width * 0.022
  );

  drawStyledText(ctx, {
    text: String(data.title || 'MVP').toUpperCase(),
    x: width * 0.5,
    y: height * 0.18,
    fontSize: width * 0.16,
    fontFamily: fonts.headline,
    italic: true,
    align: 'center',
    strokeScale: tune.strokeScale,
    letterSpacing: tune.letterSpacing.headline * SCALE,
    shadowBlur: tune.shadowBlur * SCALE,
    shadowOffsetX: tune.shadowOffsetX * SCALE,
    shadowOffsetY: tune.shadowOffsetY * SCALE,
    gradientTop: '#F2F2F2',
    gradientBottom: '#B8B8B8',
    skewX: mvpSkew,
  });

  drawStyledText(ctx, {
    text: playerNameText,
    x: width * 0.5,
    y: height * 0.29,
    fontSize: playerNameSize,
    fontFamily: fonts.headline,
    italic: true,
    align: 'center',
    strokeScale: tune.strokeScale * 0.85,
    fillMode: 'solid',
    fillColor: accent,
    shadowBlur: tune.shadowBlur * SCALE,
    shadowOffsetX: tune.shadowOffsetX * SCALE,
    shadowOffsetY: tune.shadowOffsetY * SCALE,
    skewX: mvpSkew,
  });

  drawStyledText(ctx, {
    text: 'STATS:',
    x: width * 0.5,
    y: height * 0.40,
    fontSize: width * 0.10,
    fontFamily: fonts.headline,
    italic: true,
    align: 'center',
    strokeScale: tune.strokeScale * 0.85,
    fillMode: 'solid',
    fillColor: '#F3F4F6',
    skewX: mvpSkew,
  });

  drawStyledText(ctx, {
    text: line1Text,
    x: width * 0.5,
    y: height * 0.50,
    fontSize: line1Size,
    fontFamily: fonts.stats,
    italic: true,
    align: 'center',
    strokeScale: tune.strokeScale * 0.58,
    fillMode: 'solid',
    fillColor: accent,
    letterSpacing: tune.letterSpacing.stats * SCALE,
    skewX: mvpSkew,
  });

  drawStyledText(ctx, {
    text: line2Text,
    x: width * 0.5,
    y: height * 0.58,
    fontSize: line2Size,
    fontFamily: fonts.stats,
    italic: true,
    align: 'center',
    strokeScale: tune.strokeScale * 0.58,
    fillMode: 'solid',
    fillColor: accent,
    letterSpacing: tune.letterSpacing.stats * SCALE,
    skewX: mvpSkew,
  });

  drawStyledText(ctx, {
    text: 'TOTAL SCORE:',
    x: width * 0.5,
    y: height * 0.68,
    fontSize: totalSize,
    fontFamily: fonts.stats,
    italic: true,
    align: 'right',
    strokeScale: tune.strokeScale * 0.6,
    fillMode: 'solid',
    fillColor: '#F3F4F6',
    letterSpacing: tune.letterSpacing.stats * SCALE,
    skewX: mvpSkew,
  });

  drawStyledText(ctx, {
    text: ` ${totalScoreText}`,
    x: width * 0.5,
    y: height * 0.68,
    fontSize: totalSize,
    fontFamily: fonts.stats,
    italic: true,
    align: 'left',
    strokeScale: tune.strokeScale * 0.6,
    fillMode: 'solid',
    fillColor: accent,
    letterSpacing: tune.letterSpacing.stats * SCALE,
    skewX: mvpSkew,
  });

  drawStyledText(ctx, {
    text: footerText,
    x: width * 0.5,
    y: height * 0.77,
    fontSize: footerSize,
    fontFamily: fonts.stats,
    italic: true,
    align: 'center',
    strokeScale: tune.strokeScale * 0.5,
    fillMode: 'solid',
    fillColor: '#F3F4F6',
    letterSpacing: tune.letterSpacing.stats * SCALE,
    skewX: mvpSkew,
  });

  const outCanvas = downsampleCanvas(canvas, options.outputSize || OUTPUT_SIZE);
  const png = outCanvas.toBuffer('image/png');

  ensureOutputDir();
  const matchId = String(data.matchId || 'sample').trim();
  const filePath = path.join(PATHS.outputDir, `mvp_${matchId}.png`);
  fs.writeFileSync(filePath, png);

  return { filePath, buffer: png };
}

module.exports = {
  mvpCard,
};
