const {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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

const LEAGUES = ['CCS', 'CPL', 'CAS', 'CNL'];
const WEEKS = Array.from({ length: 12 }, (_, i) => i + 1);
const SELECT_PREFIX = 'uploadstaff';
const OVERWRITE_PREFIX = 'uploadstaffovr';
const FLOW_PREFIX = 'uploadstaffflow';
const LINK_MODAL_PREFIX = 'uploadstafflink';
const FINAL_PREFIX = 'uploadstafffinal';
const PENDING_TTL_MS = 10 * 60 * 1000;
const pendingSelections = new Map();
const pendingOverwrites = new Map();
const pendingFinals = new Map();

function isBallchasingGroupUrl(value) {
  return /^https?:\/\/(?:www\.)?ballchasing\.com\/group\/[A-Za-z0-9_-]+(?:[/?].*)?$/i.test(String(value || '').trim());
}

async function inferContextFromMatchChannel(channel) {
  if (!channel || !String(channel.name || '').includes('-at-')) {
    return null;
  }

  for (const league of LEAGUES) {
    const match = await getMatchByChannel(league, channel).catch(() => null);
    if (match) {
      return { league, match };
    }
  }

  return null;
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

async function buildCommissionerAlertMentions(guild) {
  if (!guild) {
    return '';
  }

  if (!guild.roles.cache.size) {
    await guild.roles.fetch();
  }

  const mentionIds = new Set();
  for (const role of guild.roles.cache.values()) {
    const normalized = normalizeRoleName(role.name);
    if (
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

async function notifyStaffTeamMismatch(guild, channel) {
  if (!channel) {
    return;
  }
  const mentions = await buildCommissionerAlertMentions(guild);
  const prefix = mentions ? `${mentions} ` : '';
  await channel.send(`${prefix}Team names need to be adjusted in stats.`).catch(() => {});
}

function cleanupPendingSelections() {
  const now = Date.now();
  for (const [token, data] of pendingSelections.entries()) {
    if (data.expiresAt <= now) {
      pendingSelections.delete(token);
    }
  }
}

function cleanupPendingOverwrites() {
  const now = Date.now();
  for (const [token, data] of pendingOverwrites.entries()) {
    if (data.expiresAt <= now) {
      pendingOverwrites.delete(token);
    }
  }
}

function cleanupPendingFinals() {
  const now = Date.now();
  for (const [token, data] of pendingFinals.entries()) {
    if (data.expiresAt <= now) {
      pendingFinals.delete(token);
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

function createOverwriteToken(payload) {
  cleanupPendingOverwrites();
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  pendingOverwrites.set(token, {
    ...payload,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
  return token;
}

function getPendingOverwrite(token) {
  cleanupPendingOverwrites();
  return pendingOverwrites.get(token) || null;
}

function createFinalToken(payload) {
  cleanupPendingFinals();
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  pendingFinals.set(token, {
    ...payload,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
  return token;
}

function getPendingFinal(token) {
  cleanupPendingFinals();
  return pendingFinals.get(token) || null;
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

function buildPostMatchButtons(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${FLOW_PREFIX}:link:${token}`)
      .setLabel('Enter Ballchasing Link')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${FLOW_PREFIX}:cancel:${token}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildLinkModal(token) {
  const modal = new ModalBuilder()
    .setCustomId(`${LINK_MODAL_PREFIX}:${token}`)
    .setTitle('Upload Staff Link');

  const linkInput = new TextInputBuilder()
    .setCustomId('link')
    .setLabel('Ballchasing Group URL')
    .setPlaceholder('https://ballchasing.com/group/xxxxxx')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(linkInput));
  return modal;
}

function buildFinalConfirmButtons(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${FINAL_PREFIX}:confirm:${token}`)
      .setLabel('Yes, submit upload')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${FINAL_PREFIX}:cancel:${token}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );
}

function parseSelectCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts.length !== 3 || parts[0] !== SELECT_PREFIX) {
    return null;
  }
  return { stage: parts[1], token: parts[2] };
}

function buildOverwriteButtons(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${OVERWRITE_PREFIX}:confirm:${token}`)
      .setLabel('Yes, overwrite')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${OVERWRITE_PREFIX}:cancel:${token}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );
}

function parseOverwriteCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts.length !== 3 || parts[0] !== OVERWRITE_PREFIX) {
    return null;
  }
  return { action: parts[1], token: parts[2] };
}

function parseFlowCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts.length !== 3 || parts[0] !== FLOW_PREFIX) {
    return null;
  }
  return { action: parts[1], token: parts[2] };
}

function parseLinkModalCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts.length !== 2 || parts[0] !== LINK_MODAL_PREFIX) {
    return null;
  }
  return { token: parts[1] };
}

function parseFinalCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts.length !== 3 || parts[0] !== FINAL_PREFIX) {
    return null;
  }
  return { action: parts[1], token: parts[2] };
}

async function processUploadStaff(interaction, league, match, link, groupData, teamMismatchDetected) {
  try {
    await updateMatchBallchasingLink(league, match.matchId, link, { preventDuplicate: false });
  } catch (error) {
    if (error?.code === 403 || error?.response?.status === 403) {
      await interaction.editReply('Google Sheets update failed: service account lacks edit permission on this league sheet.');
      await notifyStaffUploadFailure(
        interaction.guild,
        interaction.channel,
        `⚠️ /upload_admin failed for ${match.awayTeam} at ${match.homeTeam}: Sheets permission denied (403).`
      );
      return;
    }
    await notifyStaffUploadFailure(
      interaction.guild,
      interaction.channel,
      `⚠️ /upload_admin failed for ${match.awayTeam} at ${match.homeTeam}. Error: ${error.message}`
    );
    throw error;
  }

  await interaction.editReply('✅ Ballchasing group link uploaded to sheet only.');
  await interaction.channel
    .send(`✅ Ballchasing link uploaded by <@${interaction.user.id}> (staff mode). No additional uploads are needed for this match.`)
    .catch(() => {});
  if (teamMismatchDetected) {
    await notifyStaffTeamMismatch(interaction.guild, interaction.channel);
  }

  (async () => {
    try {
      const playerRows = buildBallchasingPlayerRows(match, groupData);
      const replayDistanceMap = await fetchGroupReplayTeammateDistanceMap(link).catch(() => new Map());
      applyReplayTeammateDistanceFallback(playerRows, replayDistanceMap);
      const teamRows = buildBallchasingTeamRows(groupData, playerRows);
      console.log(
        `[upload_admin] Importing stats for ${league} ${match.matchId}: playerRows=${playerRows.length} teamRows=${teamRows.length}`
      );
      const playerAppendResult = await appendPlayerInputRows(league, playerRows);
      const teamAppendResult = await appendTeamInputRows(league, teamRows);
      console.log(
        `[upload_admin] Stats import complete for ${league} ${match.matchId}: ` +
          `PlayerInput inserted=${playerAppendResult.insertedRows} TeamInput inserted=${teamAppendResult.insertedRows}`
      );
    } catch (error) {
      console.error(`[upload_admin] Stats import failed for ${league} ${match.matchId}:`, error);
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
        `⚠️ /upload_admin failed for ${match.awayTeam} at ${match.homeTeam}: Sheets permission denied (403).`
      );
      return;
    }
    await notifyStaffUploadFailure(
      interaction.guild,
      interaction.channel,
      `⚠️ /upload_admin failed for ${match.awayTeam} at ${match.homeTeam}. Error: ${error.message}`
    );
    throw error;
  }

  if (duplicateCheckResult.duplicate) {
    const token = createOverwriteToken({
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      league,
      match,
      link,
      existingLink: duplicateCheckResult.existingLink,
    });
    await interaction.editReply({
      content: `A ballchasing link is already saved for this match.\nCurrent: ${duplicateCheckResult.existingLink}\nDo you want to overwrite it?`,
      components: [buildOverwriteButtons(token)],
    });
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
      `⚠️ /upload_admin failed for ${match.awayTeam} at ${match.homeTeam}: could not fetch group data. Error: ${error.message}`
    );
    return;
  }

  const teamCheck = compareGroupTeamsToMatch(group.data, match.homeTeam, match.awayTeam);
  const teamMismatchDetected = teamCheck.canValidate && !teamCheck.isMatch;

  await processUploadStaff(interaction, league, match, link, group.data, teamMismatchDetected);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('upload_admin')
    .setDescription('Staff upload: choose league/week/match, then submit link with confirmation')
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

    const inferredContext = await inferContextFromMatchChannel(interaction.channel);
    if (inferredContext?.league && inferredContext?.match) {
      const token = createSelectionToken({
        userId: interaction.user.id,
        guildId: interaction.guild.id,
        channelId: interaction.channel.id,
        league: inferredContext.league,
        week: String(inferredContext.match.week || ''),
        match: inferredContext.match,
      });

      await interaction.reply({
        content:
          `Detected matchup context: ${inferredContext.league} ` +
          `${inferredContext.match.homeTeam} vs ${inferredContext.match.awayTeam}.\n` +
          'Click below to enter the Ballchasing link.',
        components: [buildPostMatchButtons(token)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const token = createSelectionToken({
      userId: interaction.user.id,
      guildId: interaction.guild.id,
      channelId: interaction.channel.id,
      league: null,
      week: null,
      match: null,
    });

    await interaction.reply({
      content: 'Select a league:',
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
        content: 'This upload selection has expired. Run /upload_admin again.',
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
      pending.match = null;
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
          content: 'League selection missing. Run /upload_admin again.',
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
      pending.match = null;
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
          content: 'League/week selection missing. Run /upload_admin again.',
          components: [],
        });
        pendingSelections.delete(parsed.token);
        return;
      }

      const matches = await getMatchesByWeek(league, week);
      const match = matches.find((m) => String(m.matchId) === String(matchId));
      if (!match) {
        await interaction.update({
          content: 'Could not load that match. Run /upload_admin again.',
          components: [],
        });
        pendingSelections.delete(parsed.token);
        return;
      }

      pending.match = match;
      pending.expiresAt = Date.now() + PENDING_TTL_MS;
      pendingSelections.set(parsed.token, pending);
      await interaction.update({
        content: `Selected ${league} Week ${week}: ${match.homeTeam} vs ${match.awayTeam}.\nNow click below to enter the link.`,
        components: [buildPostMatchButtons(parsed.token)],
      });
      return;
    }
  },

  async handleButtonInteraction(interaction) {
    const flowParsed = parseFlowCustomId(interaction.customId);
    if (flowParsed) {
      const pending = getPendingSelection(flowParsed.token);
      if (!pending) {
        await interaction.reply({
          content: 'This upload selection has expired. Run /upload_admin again.',
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
        pendingSelections.delete(flowParsed.token);
        await interaction.reply({
          content: 'You no longer have permission to use this command.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (flowParsed.action === 'cancel') {
        pendingSelections.delete(flowParsed.token);
        await interaction.update({
          content: 'Upload cancelled.',
          components: [],
        });
        return;
      }

      if (flowParsed.action !== 'link') {
        return;
      }

      if (!pending.league || !pending.week || !pending.match) {
        pendingSelections.delete(flowParsed.token);
        await interaction.reply({
          content: 'League/week/match selection is incomplete. Run /upload_admin again.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.showModal(buildLinkModal(flowParsed.token));
      return;
    }

    const finalParsed = parseFinalCustomId(interaction.customId);
    if (finalParsed) {
      const pending = getPendingFinal(finalParsed.token);
      if (!pending) {
        await interaction.reply({
          content: 'This upload confirmation has expired. Run /upload_admin again.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.user.id !== pending.userId || interaction.guildId !== pending.guildId) {
        await interaction.reply({
          content: 'Only the admin who started this upload can confirm it.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!isAdminAuthorized(interaction)) {
        pendingFinals.delete(finalParsed.token);
        await interaction.reply({
          content: 'You no longer have permission to use this command.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (finalParsed.action === 'cancel') {
        pendingFinals.delete(finalParsed.token);
        await interaction.update({
          content: 'Upload cancelled.',
          components: [],
        });
        return;
      }

      if (finalParsed.action !== 'confirm') {
        return;
      }

      await interaction.update({
        content: `Processing upload for ${pending.league} Week ${pending.week}: ${pending.match.homeTeam} vs ${pending.match.awayTeam}...`,
        components: [],
      });
      pendingFinals.delete(finalParsed.token);
      await executeUploadStaff(interaction, pending.league, pending.match, pending.link);
      return;
    }

    const parsed = parseOverwriteCustomId(interaction.customId);
    if (!parsed) {
      return;
    }

    const pending = getPendingOverwrite(parsed.token);
    if (!pending) {
      await interaction.reply({
        content: 'This overwrite confirmation has expired. Run /upload_admin again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.user.id !== pending.userId || interaction.guildId !== pending.guildId) {
      await interaction.reply({
        content: 'Only the admin who started this upload can confirm overwrite.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!isAdminAuthorized(interaction)) {
      pendingOverwrites.delete(parsed.token);
      await interaction.reply({
        content: 'You no longer have permission to use this command.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (parsed.action === 'cancel') {
      pendingOverwrites.delete(parsed.token);
      await interaction.update({
        content: 'Upload cancelled. Existing ballchasing link was kept.',
        components: [],
      });
      return;
    }

    if (parsed.action !== 'confirm') {
      return;
    }

    await interaction.update({
      content: `Overwriting existing link for ${pending.match.homeTeam} vs ${pending.match.awayTeam}...`,
      components: [],
    });

    pendingOverwrites.delete(parsed.token);

    let group;
    try {
      group = await fetchBallchasingGroup(pending.link);
    } catch (error) {
      await interaction.editReply(`Could not read that Ballchasing group link.\nError: ${error.message}`);
      await notifyStaffUploadFailure(
        interaction.guild,
        interaction.channel,
        `⚠️ /upload_admin failed for ${pending.match.awayTeam} at ${pending.match.homeTeam}: could not fetch group data. Error: ${error.message}`
      );
      return;
    }

    const teamCheck = compareGroupTeamsToMatch(group.data, pending.match.homeTeam, pending.match.awayTeam);
    const teamMismatchDetected = teamCheck.canValidate && !teamCheck.isMatch;

    await processUploadStaff(interaction, pending.league, pending.match, pending.link, group.data, teamMismatchDetected);
  },

  async handleModalSubmit(interaction) {
    const parsed = parseLinkModalCustomId(interaction.customId);
    if (!parsed) {
      return;
    }

    const pending = getPendingSelection(parsed.token);
    if (!pending) {
      await interaction.reply({
        content: 'This upload selection has expired. Run /upload_admin again.',
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

    if (!pending.league || !pending.week || !pending.match) {
      pendingSelections.delete(parsed.token);
      await interaction.reply({
        content: 'League/week/match selection is incomplete. Run /upload_admin again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const link = interaction.fields.getTextInputValue('link').trim();
    if (!isBallchasingGroupUrl(link)) {
      await interaction.reply({
        content: 'Only ballchasing **group** links are allowed. Example: https://ballchasing.com/group/xxxxxx',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    pendingSelections.delete(parsed.token);
    const finalToken = createFinalToken({
      userId: pending.userId,
      guildId: pending.guildId,
      channelId: pending.channelId,
      league: pending.league,
      week: pending.week,
      match: pending.match,
      link,
    });

    await interaction.reply({
      content:
        `Confirm upload:\n` +
        `League: ${pending.league}\n` +
        `Week: ${pending.week}\n` +
        `Match: ${pending.match.homeTeam} vs ${pending.match.awayTeam}\n` +
        `Link: ${link}\n\n` +
        'Are you sure you want to submit this upload?',
      components: [buildFinalConfirmButtons(finalToken)],
      flags: MessageFlags.Ephemeral,
    });
  },
};

