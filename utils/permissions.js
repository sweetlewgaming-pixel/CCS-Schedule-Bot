const { PermissionFlagsBits } = require('discord.js');

const ELEVATED_ROLE_NAMES = new Set([
  'mods',
  'moderator',
  'moderators',
  'owner',
  'ccstimeskeeper',
]);

function normalizeRoleName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function hasElevatedRole(member) {
  const roles = member?.roles?.cache;
  if (!roles) {
    return false;
  }

  for (const role of roles.values()) {
    if (ELEVATED_ROLE_NAMES.has(normalizeRoleName(role.name))) {
      return true;
    }
  }

  return false;
}

function hasNamedRole(member, normalizedRoleName) {
  const roles = member?.roles?.cache;
  if (!roles) {
    return false;
  }

  for (const role of roles.values()) {
    if (normalizeRoleName(role.name) === normalizedRoleName) {
      return true;
    }
  }

  return false;
}

function hasRoleAtOrAbove(interaction, minRoleId) {
  if (!minRoleId) {
    // Fallback: use "Mods" role as baseline when ID is not configured.
    const guild = interaction.guild;
    if (!guild) {
      return false;
    }

    const modsRole = guild.roles.cache.find((role) => normalizeRoleName(role.name) === 'mods');
    if (!modsRole) {
      return false;
    }

    minRoleId = modsRole.id;
  }

  const guild = interaction.guild;
  const memberRoles = interaction.member?.roles?.cache;
  if (!guild || !memberRoles) {
    return false;
  }

  const minRole = guild.roles.cache.get(minRoleId);
  if (!minRole) {
    return false;
  }

  for (const role of memberRoles.values()) {
    if (role.position >= minRole.position) {
      return true;
    }
  }

  return false;
}

function isAdminAuthorized(interaction) {
  const member = interaction.member;
  if (!member) {
    return false;
  }

  const hasAdministrator = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  const adminMinRoleId = process.env.ADMIN_MIN_ROLE_ID;
  const hasAdminRole = adminRoleId ? member.roles?.cache?.has(adminRoleId) : false;
  const hasAdminMinRole = hasRoleAtOrAbove(interaction, adminMinRoleId);
  const hasNamedElevatedRole = hasElevatedRole(member);

  return Boolean(hasAdministrator || hasAdminRole || hasAdminMinRole || hasNamedElevatedRole);
}

module.exports = {
  isAdminAuthorized,
  hasNamedRole,
  hasRoleAtOrAbove,
  normalizeRoleName,
};
