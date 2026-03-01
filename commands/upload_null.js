const {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

const { isAdminAuthorized } = require('../utils/permissions');
const {
  getMatchByChannel,
  getMatchesByWeek,
  updateMatchBallchasingLink,
  appendPlayerInputRows,
  appendTeamInputRows,
} = require('../services/googleSheets');
const {
  fetchBallchasingGroup,
  fetchGroupReplayTeammateDistanceMap,
  buildBallchasingPlayerRows,
  applyReplayTeammateDistanceFallback,
  buildBallchasingTeamRows,
  compareGroupTeamsToMatch,
} = require('../services/ballchasing');

const LEAGUE_SCHEDULING_CATEGORIES = {
  CCS: 'CCS SCHEDULING',
  CPL: 'CPL SCHEDULING',
  CAS: 'CAS Scheduling',
  CNL: 'CNL Scheduling',
};

const LEAGUES = ['CCS', 'CPL', 'CAS', 'CNL'];
const WEEKS = Array.from({ length: 12 }, (_, i) => i + 1);
const SELECT_PREFIX = 'uploadstaff';
const PENDING_TTL_MS = 10 * 60 * 1000;
const pendingSelections = new Map();

function inferLeagueFromParentCategory(channel) {
  const parentName = channel?.parent?.name;
  if (!parentName) {
    return null;
  }

  const normalizedParent = String(parentName).trim().toLowerCase();
  for (const [league, categoryName] of Object.entries(LEAGUE_SCHEDULING_CATEGORIES)) {
    if (String(categoryName).trim().toLowerCase() === normalizedParent) {
      return league;
    }
  }

  return null;
}

function isBallchasingGroupUrl(value) {
  return /^https?:\/\/(?:www\.)?ballchasing\.com\/group\/[A-Za-z0-9_-]+(?:[/?].*)?$/i.test(String(value || '').trim());
}

function normalizeRoleName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

async function buildModAdminAlertMentions(guild) {
  if (!guild) {
    return '';
  }

  if (!guild.roles.cache.size) {
    await guild.roles.fetch();
  }

  const mentionIds = new Set();
  const adminRoleId = String(process.env.ADMIN_ROLE_ID || '').trim();
  if (adminRoleId && guild.roles.cache.has(adminRoleId)) {
    mentionIds.add(adminRoleId);
  }

  for (const role of guild.roles.cache.values()) {
    const normalized = normalizeRoleName(role.name);
    if (
      normalized === 'mods' ||
      normalized === 'moderator' ||
      normalized === 'moderators' ||
      normalized === 'admin' ||
      normalized === 'admins' ||
      normalized === 'commissioner' ||
      normalized === 'commissioners' ||
      normalized === 'commisioner' ||
      normalized === 'commisioners'
    ) {
      mentionIds.add(role.id);
    }
  }

  return [...mentionIds].map((id) => `<@&${id}>`).join(' ');
}

async function notifyStaffUploadFailure(guild, channel, message) {
  if (!channel) {
    return;
  }
  const mentions = await buildModAdminAlertMentions(guild);
  const prefix = mentions ? `${mentions} ` : '';
  await channel.send(`${prefix}${message}`).catch(() => {});
}

async function notifyStaffTeamMismatch(guild, channel, match, teamCheck) {
  const foundText = teamCheck.foundTeams.length ? teamCheck.foundTeams.join(', ') : 'None found';
  const missingText = teamCheck.missingTeams.length ? teamCheck.missingTeams.join(', ') : 'N/A';
  await notifyStaffUploadFailure(
    guild,
    channel,
    `⚠️ Team mismatch on /upload_staff for ${match.awayTeam} at ${match.homeTeam}. Expected: ${match.homeTeam}, ${match.awayTeam}. Found in link: ${foundText}. Missing expected teams: ${missingText}. Upload continued.`
  );
}

function cleanupPendingSelections() {
  const now = Date.now();
  for (const [token, data] of pendingSelections.entries()) {
    if (data.expiresAt <= now) {
      pendingSelections.delete(token);
    }
  }
}

function createSelectionToken(payload) {
  cleanupPendingSelections();
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  pendingSelections.set(token, {
    ...payload,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
  return token;
}

function getPendingSelection(token) {
  cleanupPendingSelections();
  return pendingSelections.get(token) || null;
}

function buildLeagueSelectRow(token) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${SELECT_PREFIX}:league:${token}`)
    .setPlaceholder('Select league')
    .addOptions(LEAGUES.map((league) => ({ label: league, value: league })));
  return new ActionRowBuilder().addComponents(menu);
}

function buildWeekSelectRow(token) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${SELECT_PREFIX}:week:${token}`)
    .setPlaceholder('Select week')
    .addOptions(WEEKS.map((week) => ({ label: `Week ${week}`, value: String(week) })));
  return new ActionRowBuilder().addComponents(menu);
}

function buildMatchSelectRow(token, matches) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${SELECT_PREFIX}:match:${token}`)
    .setPlaceholder('Select match')
    .addOptions(
      matches.slice(0, 25).map((match) => ({
        label: `${match.homeTeam} vs ${match.awayTeam}`.slice(0, 100),
        value: String(match.matchId),
      }))
    );
  return new ActionRowBuilder().addComponents(menu);
}

function parseSelectCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts.length !== 3 || parts[0] !== SELECT_PREFIX) {
    return null;
  }
  return { stage: parts[1], token: parts[2] };
}

async function processUploadStaff(interaction, league, match, link, groupData) {
  try {
    await updateMatchBallchasingLink(league, match.matchId, link, { preventDuplicate: false });
  } catch (error) {
    if (error?.code === 403 || error?.response?.status === 403) {
      await interaction.editReply('Google Sheets update failed: service account lacks edit permission on this league sheet.');
      await notifyStaffUploadFailure(
        interaction.guild,
        interaction.channel,
        `⚠️ /upload_staff failed for ${match.awayTeam} at ${match.homeTeam}: Sheets permission denied (403).`
      );
      return;
    }
    await notifyStaffUploadFailure(
      interaction.guild,
      interaction.channel,
      `⚠️ /upload_staff failed for ${match.awayTeam} at ${match.homeTeam}. Error: ${error.message}`
    );
    throw error;
  }

  await interaction.editReply('✅ Ballchasing group link uploaded to sheet only.');
  await interaction.channel
    .send(`✅ Ballchasing link uploaded by <@${interaction.user.id}> (staff mode). No additional uploads are needed for this match.`)
    .catch(() => {});

  (async () => {
    try {
      const playerRows = buildBallchasingPlayerRows(match, groupData);
      const replayDistanceMap = await fetchGroupReplayTeammateDistanceMap(link).catch(() => new Map());
      applyReplayTeammateDistanceFallback(playerRows, replayDistanceMap);
      const teamRows = buildBallchasingTeamRows(groupData, playerRows);
      await appendPlayerInputRows(league, playerRows);
      await appendTeamInputRows(league, teamRows);
    } catch (error) {
      const modAdminMentions = await buildModAdminAlertMentions(interaction.guild);
      const alertPrefix = modAdminMentions ? `${modAdminMentions} ` : '';
      await interaction.channel
        .send(
          `${alertPrefix}⚠️ Ballchasing link was saved, but raw stats import failed for ${match.awayTeam} at ${match.homeTeam}. Please import manually.\nError: ${error.message}`
        )
        .catch(() => {});
    }
  })();
}

async function executeUploadStaff(interaction, league, match, link) {
  let duplicateCheckResult;
  try {
    duplicateCheckResult = await updateMatchBallchasingLink(league, match.matchId, link, {
      preventDuplicate: true,
      dryRun: true,
    });
  } catch (error) {
    if (error?.code === 403 || error?.response?.status === 403) {
      await interaction.editReply('Google Sheets update failed: service account lacks edit permission on this league sheet.');
      await notifyStaffUploadFailure(
        interaction.guild,
        interaction.channel,
        `⚠️ /upload_staff failed for ${match.awayTeam} at ${match.homeTeam}: Sheets permission denied (403).`
      );
      return;
    }
    await notifyStaffUploadFailure(
      interaction.guild,
      interaction.channel,
      `⚠️ /upload_staff failed for ${match.awayTeam} at ${match.homeTeam}. Error: ${error.message}`
    );
    throw error;
  }

  if (duplicateCheckResult.duplicate) {
    await interaction.editReply(
      `A ballchasing link is already saved for this match and cannot be replaced.\nCurrent: ${duplicateCheckResult.existingLink}`
    );
    return;
  }

  let group;
  try {
    group = await fetchBallchasingGroup(link);
  } catch (error) {
    await interaction.editReply(`Could not read that Ballchasing group link.\nError: ${error.message}`);
    await notifyStaffUploadFailure(
      interaction.guild,
      interaction.channel,
      `⚠️ /upload_staff failed for ${match.awayTeam} at ${match.homeTeam}: could not fetch group data. Error: ${error.message}`
    );
    return;
  }

  const teamCheck = compareGroupTeamsToMatch(group.data, match.homeTeam, match.awayTeam);
  if (teamCheck.canValidate && !teamCheck.isMatch) {
    await notifyStaffTeamMismatch(interaction.guild, interaction.channel, match, teamCheck);
  }

  await processUploadStaff(interaction, league, match, link, group.data);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('upload_staff')
    .setDescription('Staff upload: update match link/stats from any channel')
    .addStringOption((option) => option.setName('link').setDescription('Ballchasing group URL').setRequired(true))
    .setDMPermission(false),

  async handleChatInput(interaction) {
    if (!interaction.guild || !interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
      await interaction.reply({
        content: 'Use this command in a server text channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!isAdminAuthorized(interaction)) {
      await interaction.reply({
        content: 'You do not have permission to use this command.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const link = interaction.options.getString('link', true).trim();
    if (!isBallchasingGroupUrl(link)) {
      await interaction.reply({
        content: 'Only ballchasing **group** links are allowed. Example: https://ballchasing.com/group/xxxxxx',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const inferredLeague = inferLeagueFromParentCategory(interaction.channel);
    if (inferredLeague && interaction.channel.name.includes('-at-')) {
      const match = await getMatchByChannel(inferredLeague, interaction.channel);
      if (match) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await executeUploadStaff(interaction, inferredLeague, match, link);
        return;
      }
    }

    const token = createSelectionToken({
      userId: interaction.user.id,
      guildId: interaction.guild.id,
      channelId: interaction.channel.id,
      link,
      league: null,
      week: null,
    });

    await interaction.reply({
      content: 'This is not a matchup channel. Select a league:',
      components: [buildLeagueSelectRow(token)],
      flags: MessageFlags.Ephemeral,
    });
  },

  async handleSelectMenu(interaction) {
    const parsed = parseSelectCustomId(interaction.customId);
    if (!parsed) {
      return;
    }

    const pending = getPendingSelection(parsed.token);
    if (!pending) {
      await interaction.reply({
        content: 'This upload selection has expired. Run /upload_staff again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.user.id !== pending.userId || interaction.guildId !== pending.guildId) {
      await interaction.reply({
        content: 'Only the admin who started this upload can continue it.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!isAdminAuthorized(interaction)) {
      pendingSelections.delete(parsed.token);
      await interaction.reply({
        content: 'You no longer have permission to use this command.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (parsed.stage === 'league') {
      pending.league = interaction.values[0];
      pending.week = null;
      pending.expiresAt = Date.now() + PENDING_TTL_MS;
      pendingSelections.set(parsed.token, pending);
      await interaction.update({
        content: `League selected: ${pending.league}\nNow select a week:`,
        components: [buildWeekSelectRow(parsed.token)],
      });
      return;
    }

    if (parsed.stage === 'week') {
      const league = pending.league;
      const week = interaction.values[0];
      if (!league) {
        await interaction.update({
          content: 'League selection missing. Run /upload_staff again.',
          components: [],
        });
        pendingSelections.delete(parsed.token);
        return;
      }

      const matches = await getMatchesByWeek(league, week);
      if (!matches.length) {
        await interaction.update({
          content: `No matches found for ${league} Week ${week}.`,
          components: [],
        });
        pendingSelections.delete(parsed.token);
        return;
      }

      pending.week = week;
      pending.expiresAt = Date.now() + PENDING_TTL_MS;
      pendingSelections.set(parsed.token, pending);
      await interaction.update({
        content: `${league} Week ${week} selected. Now select a match:`,
        components: [buildMatchSelectRow(parsed.token, matches)],
      });
      return;
    }

    if (parsed.stage === 'match') {
      const league = pending.league;
      const week = pending.week;
      const matchId = interaction.values[0];
      if (!league || !week) {
        await interaction.update({
          content: 'League/week selection missing. Run /upload_staff again.',
          components: [],
        });
        pendingSelections.delete(parsed.token);
        return;
      }

      const matches = await getMatchesByWeek(league, week);
      const match = matches.find((m) => String(m.matchId) === String(matchId));
      if (!match) {
        await interaction.update({
          content: 'Could not load that match. Run /upload_staff again.',
          components: [],
        });
        pendingSelections.delete(parsed.token);
        return;
      }

      await interaction.update({
        content: `Processing upload for ${league} Week ${week}: ${match.homeTeam} vs ${match.awayTeam}...`,
        components: [],
      });
      pendingSelections.delete(parsed.token);
      await executeUploadStaff(interaction, league, match, pending.link);
    }
  },
};
