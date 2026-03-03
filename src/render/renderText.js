function getTextWidth(ctx, text, letterSpacing = 0) {
  const chars = [...String(text || '')];
  if (!chars.length) {
    return 0;
  }

  let width = 0;
  for (const ch of chars) {
    width += ctx.measureText(ch).width;
  }
  width += letterSpacing * Math.max(0, chars.length - 1);
  return width;
}

function drawTextByChars(ctx, text, startX, y, mode, letterSpacing = 0) {
  const chars = [...String(text || '')];
  let x = startX;
  for (const ch of chars) {
    if (mode === 'stroke') {
      ctx.strokeText(ch, x, y);
    } else {
      ctx.fillText(ch, x, y);
    }
    x += ctx.measureText(ch).width + letterSpacing;
  }
}

function buildFillStyle(ctx, x, y, fontSize, options) {
  if (options.fillMode === 'solid') {
    return options.fillColor || '#BFBFBF';
  }

  const grad = ctx.createLinearGradient(x, y - fontSize, x, y + fontSize * 0.1);
  grad.addColorStop(0, options.gradientTop || '#CFCFCF');
  grad.addColorStop(1, options.gradientBottom || '#8F8F8F');
  return grad;
}

function drawStyledText(ctx, options) {
  const text = String(options.text || '');
  if (!text) {
    return;
  }

  const x = Number(options.x || 0);
  const y = Number(options.y || 0);
  const fontSize = Number(options.fontSize || 64);
  const fontFamily = String(options.fontFamily || 'Arial Black');
  const fontWeight = String(options.fontWeight || '900');
  const italic = Boolean(options.italic);
  const letterSpacing = Number(options.letterSpacing || 0);
  const align = String(options.align || 'center');

  const skewX = Number(options.skewX || 0);
  const strokeScale = Number(options.strokeScale || 0.12);
  const strokeWidth = Number(options.strokeWidth || Math.max(2, fontSize * strokeScale));
  const strokeColor = String(options.strokeColor || '#FFFFFF');

  const shadowColor = String(options.shadowColor || 'rgba(0,0,0,0.8)');
  const shadowBlur = Number(options.shadowBlur || 8);
  const shadowOffsetX = Number(options.shadowOffsetX || 4);
  const shadowOffsetY = Number(options.shadowOffsetY || 4);

  const innerStrokeColor = options.innerStrokeColor ? String(options.innerStrokeColor) : '';
  const innerStrokeWidth = Number(options.innerStrokeWidth || Math.max(1, fontSize * 0.02));

  const glowEnabled = Boolean(options.glowEnabled);
  const glowColor = String(options.glowColor || 'rgba(255,255,255,0.25)');
  const glowBlur = Number(options.glowBlur || 12);

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.font = `${italic ? 'italic ' : ''}${fontWeight} ${fontSize}px "${fontFamily}"`;

  const textWidth = getTextWidth(ctx, text, letterSpacing);
  let startX = x;
  if (align === 'center') {
    startX = x - textWidth / 2;
  } else if (align === 'right') {
    startX = x - textWidth;
  }

  if (skewX !== 0) {
    ctx.transform(1, 0, skewX, 1, 0, 0);
  }

  if (glowEnabled) {
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = glowBlur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    drawTextByChars(ctx, text, startX, y, 'stroke', letterSpacing);
  }

  ctx.shadowColor = shadowColor;
  ctx.shadowBlur = shadowBlur;
  ctx.shadowOffsetX = shadowOffsetX;
  ctx.shadowOffsetY = shadowOffsetY;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = strokeWidth;
  drawTextByChars(ctx, text, startX, y, 'stroke', letterSpacing);

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = buildFillStyle(ctx, x, y, fontSize, options);
  drawTextByChars(ctx, text, startX, y, 'fill', letterSpacing);

  if (innerStrokeColor) {
    ctx.strokeStyle = innerStrokeColor;
    ctx.lineWidth = innerStrokeWidth;
    drawTextByChars(ctx, text, startX, y, 'stroke', letterSpacing);
  }

  ctx.restore();
}

module.exports = {
  drawStyledText,
};
