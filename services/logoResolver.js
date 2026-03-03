const fs = require('fs');
const path = require('path');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const TEAM_LOGO_INDEX_CACHE = new Map();

function normalizeText(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNameTokens(value) {
  return normalizeText(value)
    .split(/[\s-]+/)
    .filter(Boolean);
}

function singularizeToken(token) {
  const value = String(token || '').trim().toLowerCase();
  if (!value) {
    return '';
  }

  if (value.endsWith('ies') && value.length > 4) {
    return `${value.slice(0, -3)}y`;
  }
  if (value.endsWith('ves') && value.length > 4) {
    return `${value.slice(0, -3)}f`;
  }
  if (value.endsWith('es') && value.length > 4) {
    return value.slice(0, -2);
  }
  if (value.endsWith('s') && value.length > 3) {
    return value.slice(0, -1);
  }
  return value;
}

function buildTokenVariants(token) {
  const raw = String(token || '').trim().toLowerCase();
  const singular = singularizeToken(raw);
  const variants = new Set();
  if (raw) {
    variants.add(raw);
  }
  if (singular) {
    variants.add(singular);
  }
  if (singular) {
    variants.add(`${singular}s`);
    variants.add(`${singular}es`);
  }
  return variants;
}

function tokensLikelyMatch(left, right) {
  const leftVariants = buildTokenVariants(left);
  const rightVariants = buildTokenVariants(right);

  for (const l of leftVariants) {
    if (!l) {
      continue;
    }
    for (const r of rightVariants) {
      if (!r) {
        continue;
      }
      if (l === r) {
        return true;
      }
      if (l.length >= 4 && (l.includes(r) || r.includes(l))) {
        return true;
      }
    }
  }
  return false;
}

function scoreNameMatch(teamName, fileBaseName) {
  const teamTokens = toNameTokens(teamName);
  const fileTokens = new Set(toNameTokens(fileBaseName));
  if (!teamTokens.length || !fileTokens.size) {
    return 0;
  }

  let score = 0;
  for (const token of teamTokens) {
    for (const fileToken of fileTokens) {
      if (tokensLikelyMatch(token, fileToken)) {
        // Strong score when the normalized singular forms match.
        const tokenBase = singularizeToken(token);
        const fileBase = singularizeToken(fileToken);
        score += tokenBase === fileBase ? 2 : 1;
        break;
      }
    }
  }

  const compactTeam = teamTokens.join('');
  const compactFile = [...fileTokens].join('');
  if (compactTeam && compactFile && (compactTeam === compactFile || compactTeam.includes(compactFile) || compactFile.includes(compactTeam))) {
    score += 2;
  }

  return score;
}

function getLeagueLogoDir(league) {
  const key = `LOGO_DIR_${String(league || '').toUpperCase()}`;
  const value = String(process.env[key] || '').trim();
  return value || '';
}

function walkImageFiles(rootDir) {
  const out = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const current = queue.shift();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) {
        continue;
      }

      out.push(full);
    }
  }

  return out;
}

function getLeagueTeamLogoIndex(league) {
  const leagueCode = String(league || '').toUpperCase();
  if (TEAM_LOGO_INDEX_CACHE.has(leagueCode)) {
    return TEAM_LOGO_INDEX_CACHE.get(leagueCode);
  }

  const dir = getLeagueLogoDir(leagueCode);
  if (!dir || !fs.existsSync(dir)) {
    throw new Error(`Logo directory missing for ${leagueCode}. Set LOGO_DIR_${leagueCode} in .env`);
  }

  const images = walkImageFiles(dir).map((filePath) => ({
    filePath,
    baseName: path.basename(filePath, path.extname(filePath)),
  }));

  TEAM_LOGO_INDEX_CACHE.set(leagueCode, images);
  return images;
}

function resolveTeamLogoPath(league, teamName) {
  const candidates = getLeagueTeamLogoIndex(league);
  const ranked = candidates
    .map((item) => ({ ...item, score: scoreNameMatch(teamName, item.baseName) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 2) {
    throw new Error(`Logo not found for team "${teamName}" in ${String(league || '').toUpperCase()} logo directory.`);
  }

  return best.filePath;
}

function resolveLeagueLogoPath(league) {
  const dir = String(process.env.LEAGUE_LOGO_DIR || '').trim();
  if (!dir || !fs.existsSync(dir)) {
    return '';
  }

  const leagueCode = String(league || '').toUpperCase();
  const images = walkImageFiles(dir).filter((filePath) => {
    const base = normalizeText(path.basename(filePath, path.extname(filePath)));
    if (base.includes('american') || base.includes('international')) {
      return false;
    }
    return base.includes(leagueCode.toLowerCase());
  });

  return images[0] || '';
}

module.exports = {
  resolveTeamLogoPath,
  resolveLeagueLogoPath,
};
