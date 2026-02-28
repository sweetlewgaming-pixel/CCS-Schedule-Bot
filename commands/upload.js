const { ChannelType, MessageFlags, SlashCommandBuilder } = require('discord.js');

const { isAdminAuthorized } = require('../utils/permissions');
const {
  getMatchByChannel,
  updateMatchBallchasingLink,
  appendPlayerInputRows,
  appendTeamInputRows,
} = require('../services/googleSheets');
const { getRoleIdByTeamName } = require('../utils/teamRoles');
const { fetchBallchasingGroup, buildBallchasingPlayerRows, buildBallchasingTeamRows } = require('../services/ballchasing');

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
    if (normalized === 'mods' || normalized === 'moderator' || normalized === 'moderators' || normalized === 'admin' || normalized === 'admins') {
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

    const allowed = isAdminAuthorized(interaction) || (await isTeamMember(interaction, match.homeTeam, match.awayTeam));
    if (!allowed) {
      await interaction.reply({
        content: 'Only players on the two teams (or elevated staff roles) can use this command.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

    if (duplicateCheckResult.duplicate) {
      await interaction.editReply(
        `A ballchasing link is already saved for this match and cannot be replaced.\nCurrent: ${duplicateCheckResult.existingLink}`
      );
      return;
    }

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
        const group = await fetchBallchasingGroup(link);
        const playerRows = buildBallchasingPlayerRows(match, group.data);
        const teamRows = buildBallchasingTeamRows(group.data, playerRows);
        const appendPlayerResult = await appendPlayerInputRows(league, playerRows);
        const appendTeamResult = await appendTeamInputRows(league, teamRows);
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
  },
};
