const TEAM_ROLE_MAP = {
  // Optional hard overrides:
  // 'San Diego Sonic Boom': '123456789012345678',
};

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreRoleNameMatch(teamName, roleName) {
  const teamNorm = normalizeName(teamName);
  const roleNorm = normalizeName(roleName);
  if (!teamNorm || !roleNorm) {
    return 0;
  }

  if (teamNorm === roleNorm) {
    return 1000;
  }

  const teamCompact = teamNorm.replace(/\s/g, '');
  const roleCompact = roleNorm.replace(/\s/g, '');
  if (teamCompact === roleCompact) {
    return 950;
  }

  // Handles short sheet names like "Anglers" matching role "Atlantis Anglers".
  if (roleNorm.endsWith(` ${teamNorm}`) || roleNorm.startsWith(`${teamNorm} `) || roleNorm.includes(` ${teamNorm} `)) {
    return 900;
  }

  const teamTokens = teamNorm.split(' ').filter(Boolean);
  const roleTokens = new Set(roleNorm.split(' ').filter(Boolean));
  const overlap = teamTokens.filter((token) => roleTokens.has(token)).length;
  if (overlap === 0) {
    return 0;
  }

  // Prefer matches with higher token overlap and fewer extra tokens.
  const coverage = overlap / teamTokens.length;
  const precision = overlap / roleTokens.size;
  return Math.round(coverage * 500 + precision * 300);
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

  const exact = guild.roles.cache.find((role) => role.name === teamName);
  if (exact) {
    return exact.id;
  }

  let bestRole = null;
  let bestScore = 0;

  for (const role of guild.roles.cache.values()) {
    const score = scoreRoleNameMatch(teamName, role.name);
    if (score > bestScore) {
      bestScore = score;
      bestRole = role;
    }
  }

  // Require a meaningful confidence to avoid false pings.
  return bestScore >= 300 ? bestRole.id : null;
}

module.exports = {
  TEAM_ROLE_MAP,
  getRoleIdByTeamName,
};
