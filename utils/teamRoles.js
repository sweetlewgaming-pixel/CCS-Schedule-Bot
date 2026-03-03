const { slugifyTeamName } = require('./slugify');

const TEAM_ROLE_MAP = {
  // Optional hard overrides:
  // 'San Diego Sonic Boom': '123456789012345678',
};

const TEAM_NAME_ALIASES = {
  // Common short forms from sheets -> exact Discord role labels.
  thieves: 'Tokha Thieves',
  'tohka thieves': 'Tokha Thieves',
  marauders: 'Miami Marauders',
  'sonic boom': 'San Diego Sonic Boom',
  pirates: 'Palm Beach Pirates',
  'black bears': 'Bad Axe Black Bears',
  conquerors: 'Clearwater Conquerors',
  'culebra conquerors': 'Clearwater Conquerors',
};

const KNOWN_FULL_TEAM_NAMES = [
  'Atlantis Anglers',
  'Frenchmen Bay Fishermen',
  'Bermuda Behemoths',
  'Lyonesse Leviathans',
  'Fiji Flyers',
  'Lautoka Lory',
  'Suva Skyhawks',
  'Rakiraki Redwings',
  'Nepal Ninjas',
  'Sakala Shadows',
  'Palpa Prowlers',
  'Tohka Thieves',
  'Shanghai Samurai',
  'Wuhan Warriors',
  'Shenzhen Shaman',
  'Beijing Bushido',
  'Venezuela Vipers',
  'Caracas Cobras',
  'Coro Copperheads',
  'Anaco Anacondas',
  'Zimbabwe Zebras',
  'Bulawayo Buffalo',
  'Epworth Elephants',
  'Redcliff Rhinos',
  'Houston Howlers',
  'Copper Canyon Coyotes',
  'Waco Wolfpack',
  'Temple Timberwolves',
  'Michigan Moose',
  'Grand Rapids Groundhogs',
  'Bad Axe Black Bears',
  'Detroit Ducks',
  'Puerto Rico Pirates',
  'Palm Beach Pirates',
  'Marshall Island Marauders',
  'Culebra Conquerors',
  'Surfside Shipwreck',
  'San Jose Shockwave',
  'San Diego Sonic Boom',
  'San Francisco Surge',
  'San Bernadino Sound',
  'Seattle Stars',
  'Spokane Supernova',
  'Aberdeen Astronauts',
  'Raymond Rovers',
  'Boston Blasters',
  'Massachusetts Mortars',
  'Cambridge Cannons',
  'Bedford Ballistics',
];

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function singularizeToken(token) {
  const value = String(token || '').trim().toLowerCase();
  if (!value) {
    return '';
  }
  if (value.endsWith('ies') && value.length > 3) {
    return `${value.slice(0, -3)}y`;
  }
  if (value.endsWith('es') && value.length > 3) {
    return value.slice(0, -2);
  }
  if (value.endsWith('s') && value.length > 2) {
    return value.slice(0, -1);
  }
  return value;
}

function tokenizeNormalizedName(value) {
  return normalizeName(value)
    .split(' ')
    .map((t) => singularizeToken(t))
    .filter(Boolean);
}

const FULL_NAME_BY_NORMALIZED = new Map(
  KNOWN_FULL_TEAM_NAMES.map((name) => [normalizeName(name), name])
);
const FULL_NAME_BY_MASCOT = new Map();
for (const name of KNOWN_FULL_TEAM_NAMES) {
  const parts = normalizeName(name).split(' ');
  const mascot = parts[parts.length - 1];
  if (!mascot) {
    continue;
  }
  if (!FULL_NAME_BY_MASCOT.has(mascot)) {
    FULL_NAME_BY_MASCOT.set(mascot, name);
  } else if (FULL_NAME_BY_MASCOT.get(mascot) !== name) {
    FULL_NAME_BY_MASCOT.set(mascot, null);
  }
}

function canonicalizeTeamName(teamName) {
  const normalized = normalizeName(teamName);
  if (!normalized) {
    return '';
  }
  if (TEAM_NAME_ALIASES[normalized]) {
    return TEAM_NAME_ALIASES[normalized];
  }
  if (FULL_NAME_BY_NORMALIZED.has(normalized)) {
    return FULL_NAME_BY_NORMALIZED.get(normalized);
  }
  if (FULL_NAME_BY_MASCOT.has(normalized)) {
    return FULL_NAME_BY_MASCOT.get(normalized) || teamName;
  }
  return teamName;
}

function scoreRoleSlugMatch(teamSlug, roleSlug) {
  if (!teamSlug || !roleSlug) {
    return 0;
  }

  if (roleSlug === teamSlug) {
    return 1000;
  }

  // Accept tight league-tag patterns only.
  if (['ccs', 'cpl', 'cas', 'cnl'].some((tag) => roleSlug === `${tag}-${teamSlug}`)) {
    return 960;
  }

  if (['ccs', 'cpl', 'cas', 'cnl'].some((tag) => roleSlug === `${teamSlug}-${tag}`)) {
    return 930;
  }

  if (roleSlug === `${teamSlug}-team` || roleSlug === `${teamSlug}-role`) {
    return 900;
  }

  return 0;
}

async function getRoleIdByTeamName(guild, teamName) {
  if (!guild || !teamName) {
    return TEAM_ROLE_MAP[teamName] || null;
  }

  const mapped = TEAM_ROLE_MAP[teamName];
  if (mapped) {
    return mapped;
  }

  if (!guild.roles.cache.size) {
    await guild.roles.fetch();
  }

  const canonicalTeamName = canonicalizeTeamName(teamName);
  const exact = guild.roles.cache.find(
    (role) => normalizeName(role.name) === normalizeName(canonicalTeamName) || normalizeName(role.name) === normalizeName(teamName)
  );
  if (exact) {
    return exact.id;
  }

  // Fuzzy fallback for minor naming drift in role labels
  // (for example singular/plural mascot differences).
  const targetNames = [canonicalTeamName, teamName].filter(Boolean);
  let fuzzyBestRole = null;
  let fuzzyBestScore = 0;

  for (const role of guild.roles.cache.values()) {
    const roleTokens = tokenizeNormalizedName(role.name);
    if (!roleTokens.length) {
      continue;
    }

    let roleScore = 0;
    for (const targetName of targetNames) {
      const targetTokens = tokenizeNormalizedName(targetName);
      if (!targetTokens.length) {
        continue;
      }

      const allTokensPresent = targetTokens.every((token) => roleTokens.includes(token));
      if (!allTokensPresent) {
        continue;
      }

      // Prefer exact token-set matches over partial contains.
      const score = targetTokens.length === roleTokens.length ? 720 : 680;
      if (score > roleScore) {
        roleScore = score;
      }
    }

    if (roleScore > fuzzyBestScore) {
      fuzzyBestScore = roleScore;
      fuzzyBestRole = role;
    }
  }

  if (fuzzyBestScore > 0) {
    return fuzzyBestRole.id;
  }

  const teamSlug = slugifyTeamName(canonicalTeamName || teamName);
  if (!teamSlug) {
    return null;
  }

  let bestRole = null;
  let bestScore = 0;

  for (const role of guild.roles.cache.values()) {
    const roleSlug = slugifyTeamName(role.name);
    const score = scoreRoleSlugMatch(teamSlug, roleSlug);
    if (score > bestScore) {
      bestScore = score;
      bestRole = role;
    }
  }

  return bestScore > 0 ? bestRole.id : null;
}

module.exports = {
  TEAM_ROLE_MAP,
  getRoleIdByTeamName,
};
