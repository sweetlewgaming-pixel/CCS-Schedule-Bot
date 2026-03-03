const { slugifyTeamName } = require('./slugify');

const TEAM_ROLE_MAP = {
  // Optional hard overrides:
  // 'San Diego Sonic Boom': '123456789012345678',
};

function scoreRoleSlugMatch(teamSlug, roleSlug) {
  if (!teamSlug || !roleSlug) {
    return 0;
  }

  if (roleSlug === teamSlug) {
    return 1000;
  }

  // Accept common prefixed/suffixed role naming patterns only.
  if (roleSlug.endsWith(`-${teamSlug}`)) {
    return 960;
  }

  if (roleSlug.startsWith(`${teamSlug}-`)) {
    return 930;
  }

  if (roleSlug.includes(`-${teamSlug}-`)) {
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

  const exact = guild.roles.cache.find((role) => role.name === teamName);
  if (exact) {
    return exact.id;
  }

  const teamSlug = slugifyTeamName(teamName);
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
