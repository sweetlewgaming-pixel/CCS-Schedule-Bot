const fs = require('fs');
const path = require('path');
const { GlobalFonts } = require('@napi-rs/canvas');

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2']);

function getKnownFamilies() {
  if (Array.isArray(GlobalFonts.families)) {
    return GlobalFonts.families.map((name) => String(name || '').trim().toLowerCase());
  }
  return [];
}

function hasFamilyInstalled(name) {
  const target = String(name || '').trim();
  if (!target) {
    return false;
  }

  if (typeof GlobalFonts.has === 'function') {
    try {
      return Boolean(GlobalFonts.has(target));
    } catch (_) {
      // Fall through to family list check.
    }
  }

  const families = getKnownFamilies();
  return families.includes(target.toLowerCase());
}

function loadFontsFromDir(fontsDir, logger = console.log) {
  const dir = String(fontsDir || '').trim();
  if (!dir || !fs.existsSync(dir)) {
    logger(`[render-fonts] fonts dir not found: ${dir || '(empty path)'}`);
    return [];
  }

  const loaded = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!FONT_EXTENSIONS.has(ext)) {
      continue;
    }

    const filePath = path.join(dir, entry.name);
    try {
      const ok = GlobalFonts.registerFromPath(filePath);
      if (ok) {
        loaded.push(filePath);
      }
    } catch (_) {
      // Ignore invalid font files and continue.
    }
  }

  logger(`[render-fonts] loaded ${loaded.length} font file(s) from ${dir}`);
  return loaded;
}

function chooseFontForRole(role, stack, logger = console.log) {
  const candidates = Array.isArray(stack) ? stack : [];
  if (!candidates.length) {
    logger(`[render-fonts] role=${role} chosen=(none)`);
    return 'sans-serif';
  }

  let chosen = candidates[candidates.length - 1];
  for (const family of candidates) {
    if (hasFamilyInstalled(family)) {
      chosen = family;
      break;
    }
  }

  logger(`[render-fonts] role=${role} chosen=${chosen} stack=[${candidates.join(' | ')}]`);
  return chosen;
}

function resolveFontRoles(fontStacks, logger = console.log) {
  const out = {};
  for (const [role, stack] of Object.entries(fontStacks || {})) {
    out[role] = chooseFontForRole(role, stack, logger);
  }
  return out;
}

module.exports = {
  loadFontsFromDir,
  resolveFontRoles,
};
