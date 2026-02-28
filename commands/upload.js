const { ChannelType, MessageFlags, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const { isAdminAuthorized } = require('../utils/permissions');
const {
  getMatchByChannel,
  updateMatchBallchasingLink,
  appendPlayerInputRows,
  appendTeamInputRows,
} = require('../services/googleSheets');
const { getRoleIdByTeamName } = require('../utils/teamRoles');
const {
  fetchBallchasingGroup,
  buildBallchasingPlayerRows,
  buildBallchasingTeamRows,
  compareGroupTeamsToMatch,
} = require('../services/ballchasing');

const LEAGUE_SCHEDULING_CATEGORIES = {
  CCS: 'CCS SCHEDULING',
  CPL: 'CPL SCHEDULING',
  CAS: 'CAS Scheduling',
  CNL: 'CNL Scheduling',
};

const LEAGUE_REPLAY_SUBMISSION_CHANNELS = {
  CCS: ['ccs replay submissions', 'ccs-replay-submission', 'ccs-replay-submissions'],
  CPL: ['cpl replay submissions', 'cpl-replay-submission', 'cpl-replay-submissions'],
  CAS: ['cas replay submissions', 'cas-replay-submission', 'cas-replay-submissions'],
  CNL: ['cnl replay submissions', 'cnl-replay-submission', 'cnl-replay-submissions'],
};

const TEAM_CHECK_BUTTON_PREFIX = 'upload:teamcheck';
const TEAM_CHECK_TTL_MS = 10 * 60 * 1000;
const pendingTeamCheckConfirms = new Map();

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

async function resolveReplaySubmissionChannel(guild, league) {
  if (!guild) {
    return null;
  }

  const desired = LEAGUE_REPLAY_SUBMISSION_CHANNELS[league];
  if (!desired || !desired.length) {
    return null;
  }

  await guild.channels.fetch();
  const desiredSet = new Set(desired.map((name) => String(name || '').trim().toLowerCase()));
  return (
    guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildText && desiredSet.has(String(ch.name || '').trim().toLowerCase())
    ) || null
  );
}

async function isTeamMember(interaction, homeTeam, awayTeam) {
  const memberRoles = interaction.member?.roles?.cache;
  if (!memberRoles) {
    return false;
  }

  const homeRoleId = await getRoleIdByTeamName(interaction.guild, homeTeam);
  const awayRoleId = await getRoleIdByTeamName(interaction.guild, awayTeam);
  return Boolean((homeRoleId && memberRoles.has(homeRoleId)) || (awayRoleId && memberRoles.has(awayRoleId)));
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
      normalized === 'admins'
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

function cleanupExpiredTeamCheckTokens() {
  const now = Date.now();
  for (const [token, item] of pendingTeamCheckConfirms.entries()) {
    if (item.expiresAt <= now) {
      pendingTeamCheckConfirms.delete(token);
    }
  }
}

function createTeamCheckToken(payload) {
  cleanupExpiredTeamCheckTokens();
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  pendingTeamCheckConfirms.set(token, {
    ...payload,
    expiresAt: Date.now() + TEAM_CHECK_TTL_MS,
  });
  return token;
}

function buildTeamCheckConfirmRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TEAM_CHECK_BUTTON_PREFIX}:confirm:${token}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Confirm Upload Anyway'),
    new ButtonBuilder()
      .setCustomId(`${TEAM_CHECK_BUTTON_PREFIX}:cancel:${token}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Cancel')
  );
}

function parseTeamCheckButton(customId) {
  if (!customId.startsWith(`${TEAM_CHECK_BUTTON_PREFIX}:`)) {
    return null;
  }

  const parts = customId.split(':');
  if (parts.length !== 4) {
    return null;
  }

  return {
    action: parts[2],
    token: parts[3],
  };
}

async function checkDuplicate(interaction, league, match, link) {
  try {
    return await updateMatchBallchasingLink(league, match.matchId, link, {
      preventDuplicate: true,
      dryRun: true,
    });
  } catch (error) {
    if (error?.code === 403 || error?.response?.status === 403) {
      await interaction.editReply('Google Sheets update failed: service account lacks edit permission on this league sheet.');
      await notifyStaffUploadFailure(
        interaction.guild,
        interaction.channel,
        `⚠️ /upload failed for ${match.awayTeam} at ${match.homeTeam}: Sheets permission denied (403).`
      );
      return null;
    }
    await notifyStaffUploadFailure(
      interaction.guild,
      interaction.channel,
      `⚠️ /upload failed for ${match.awayTeam} at ${match.homeTeam}. Error: ${error.message}`
    );
    throw error;
  }
}

async function processUpload(interaction, league, match, link, groupData) {
  try {
    await updateMatchBallchasingLink(league, match.matchId, link, { preventDuplicate: false });
  } catch (error) {
    if (error?.code === 403 || error?.response?.status === 403) {
      await interaction.editReply('Google Sheets update failed: service account lacks edit permission on this league sheet.');
      await notifyStaffUploadFailure(
        interaction.guild,
        interaction.channel,
        `⚠️ /upload failed for ${match.awayTeam} at ${match.homeTeam}: Sheets permission denied (403).`
      );
      return;
    }
    await notifyStaffUploadFailure(
      interaction.guild,
      interaction.channel,
      `⚠️ /upload failed for ${match.awayTeam} at ${match.homeTeam}. Error: ${error.message}`
    );
    throw error;
  }

  const replayChannel = await resolveReplaySubmissionChannel(interaction.guild, league);
  if (replayChannel) {
    await replayChannel.send(`Ballchasing upload for ${match.awayTeam} at ${match.homeTeam}: ${link}`);
  }

  await interaction.editReply('✅ Ballchasing group link uploaded successfully and posted.');
  await interaction.channel
    .send(`✅ Ballchasing link uploaded by <@${interaction.user.id}>. No additional uploads are needed for this match.`)
    .catch(() => {});

  (async () => {
    try {
      const playerRows = buildBallchasingPlayerRows(match, groupData);
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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('upload')
    .setDescription('Upload ballchasing group link for the current matchup')
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

    const link = interaction.options.getString('link', true).trim();
    if (!isBallchasingGroupUrl(link)) {
      await interaction.reply({
        content: 'Only ballchasing **group** links are allowed. Example: https://ballchasing.com/group/xxxxxx',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const league = inferLeagueFromParentCategory(interaction.channel);
    if (!league || !interaction.channel.name.includes('-at-')) {
      await interaction.reply({
        content: 'Use this inside a matchup scheduling channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const match = await getMatchByChannel(league, interaction.channel);
    if (!match) {
      await interaction.reply({
        content: 'Could not determine match from this channel name.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const isAdmin = isAdminAuthorized(interaction);
    const allowed = isAdmin || (await isTeamMember(interaction, match.homeTeam, match.awayTeam));
    if (!allowed) {
      await interaction.reply({
        content: 'Only players on the two teams (or elevated staff roles) can use this command.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const duplicateCheckResult = await checkDuplicate(interaction, league, match, link);
    if (!duplicateCheckResult) {
      return;
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
        `⚠️ /upload failed for ${match.awayTeam} at ${match.homeTeam}: could not fetch group data. Error: ${error.message}`
      );
      return;
    }

    const teamCheck = compareGroupTeamsToMatch(group.data, match.homeTeam, match.awayTeam);
    if (teamCheck.canValidate && !teamCheck.isMatch) {
      const foundText = teamCheck.foundTeams.length ? teamCheck.foundTeams.join(', ') : 'None found';
      if (!isAdmin) {
        await interaction.editReply(
          `Team mismatch detected. Expected: ${match.homeTeam} and ${match.awayTeam}. Found in link: ${foundText}.\nPlease recheck the link or ask an admin to confirm override.`
        );
        return;
      }

      const token = createTeamCheckToken({
        userId: interaction.user.id,
        league,
        match,
        link,
      });

      await interaction.editReply({
        content: `Team mismatch detected.\nExpected: ${match.homeTeam} vs ${match.awayTeam}\nFound in link: ${foundText}\n\nConfirm to upload anyway?`,
        components: [buildTeamCheckConfirmRow(token)],
      });
      return;
    }

    await processUpload(interaction, league, match, link, group.data);
  },

  async handleButtonInteraction(interaction) {
    const parsed = parseTeamCheckButton(interaction.customId);
    if (!parsed) {
      return;
    }

    const pending = pendingTeamCheckConfirms.get(parsed.token);
    if (!pending || pending.expiresAt <= Date.now()) {
      pendingTeamCheckConfirms.delete(parsed.token);
      await interaction.reply({
        content: 'This confirmation has expired. Please run /upload again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.user.id !== pending.userId) {
      await interaction.reply({
        content: 'Only the user who started this upload can confirm it.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (parsed.action === 'cancel') {
      pendingTeamCheckConfirms.delete(parsed.token);
      await interaction.update({
        content: 'Upload canceled.',
        components: [],
      });
      return;
    }

    if (parsed.action !== 'confirm') {
      return;
    }

    if (!isAdminAuthorized(interaction)) {
      pendingTeamCheckConfirms.delete(parsed.token);
      await interaction.update({
        content: 'You no longer have admin permission to override this mismatch.',
        components: [],
      });
      return;
    }

    await interaction.update({
      content: 'Processing override upload...',
      components: [],
    });

    const duplicateCheckResult = await checkDuplicate(interaction, pending.league, pending.match, pending.link);
    if (!duplicateCheckResult) {
      pendingTeamCheckConfirms.delete(parsed.token);
      return;
    }

    if (duplicateCheckResult.duplicate) {
      pendingTeamCheckConfirms.delete(parsed.token);
      await interaction.editReply(
        `A ballchasing link is already saved for this match and cannot be replaced.\nCurrent: ${duplicateCheckResult.existingLink}`
      );
      return;
    }

    let group;
    try {
      group = await fetchBallchasingGroup(pending.link);
    } catch (error) {
      pendingTeamCheckConfirms.delete(parsed.token);
      await interaction.editReply(`Could not read that Ballchasing group link.\nError: ${error.message}`);
      await notifyStaffUploadFailure(
        interaction.guild,
        interaction.channel,
        `⚠️ /upload override failed for ${pending.match.awayTeam} at ${pending.match.homeTeam}: could not fetch group data. Error: ${error.message}`
      );
      return;
    }

    pendingTeamCheckConfirms.delete(parsed.token);
    await processUpload(interaction, pending.league, pending.match, pending.link, group.data);
  },
};
