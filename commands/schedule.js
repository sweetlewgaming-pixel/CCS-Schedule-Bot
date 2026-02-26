const {
  ActionRowBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} = require('discord.js');

const { getMatchesByWeek, getMatchByChannel, updateMatchDateTime } = require('../services/googleSheets');
const { formatScheduleDate, formatScheduleTime } = require('../utils/formatDate');
const { getRoleIdByTeamName } = require('../utils/teamRoles');
const { slugifyTeamName } = require('../utils/slugify');
const { isAdminAuthorized } = require('../utils/permissions');

const CUSTOM_IDS = {
  LEAGUE: 'schedule:league',
  WEEK_PREFIX: 'schedule:week',
  MATCH_PREFIX: 'schedule:match',
  MODAL_PREFIX: 'schedule:modal',
};

const LEAGUES = ['CCS', 'CPL', 'CAS', 'CNL'];
const WEEKS = Array.from({ length: 12 }, (_, i) => i + 1);
const LEAGUE_ANNOUNCEMENT_CHANNELS = {
  CCS: 'ccs-game-times',
  CPL: 'cpl-game-times',
  CAS: 'cas-game-times',
  CNL: 'cnl-game-times',
};
const LEAGUE_SCHEDULING_CATEGORIES = {
  CCS: 'CCS SCHEDULING',
  CPL: 'CPL SCHEDULING',
  CAS: 'CAS Scheduling',
  CNL: 'CNL Scheduling',
};
const CONFIRMED_CHANNEL_SUFFIX = '✅';
const CONFIRMED_CHANNEL_FALLBACK_SUFFIX = 'confirmed';
const OVERWRITE_BUTTON_PREFIX = 'schedule:overwrite';
const OVERWRITE_CACHE_TTL_MS = 10 * 60 * 1000;
const pendingOverwrites = new Map();

function buildLeagueRow() {
  const leagueMenu = new StringSelectMenuBuilder()
    .setCustomId(CUSTOM_IDS.LEAGUE)
    .setPlaceholder('Select a league')
    .addOptions(
      LEAGUES.map((league) => ({
        label: league,
        value: league,
      }))
    );

  return new ActionRowBuilder().addComponents(leagueMenu);
}

function buildWeekRow(league) {
  const weekMenu = new StringSelectMenuBuilder()
    .setCustomId(`${CUSTOM_IDS.WEEK_PREFIX}:${league}`)
    .setPlaceholder('Select a week')
    .addOptions(
      WEEKS.map((week) => ({
        label: `Week ${week}`,
        value: String(week),
      }))
    );

  return new ActionRowBuilder().addComponents(weekMenu);
}

function buildMatchRow(league, week, matches) {
  const matchMenu = new StringSelectMenuBuilder()
    .setCustomId(`${CUSTOM_IDS.MATCH_PREFIX}:${league}:${week}`)
    .setPlaceholder('Select a match')
    .addOptions(
      matches.map((match) => ({
        label: `${match.homeTeam} vs ${match.awayTeam}`.slice(0, 100),
        value: match.matchId,
      }))
    );

  return new ActionRowBuilder().addComponents(matchMenu);
}

function buildScheduleModal(league, week, matchId) {
  const modal = new ModalBuilder()
    .setCustomId(`${CUSTOM_IDS.MODAL_PREFIX}:${league}:${week}:${matchId}`)
    .setTitle('Schedule Match');

  const dateInput = new TextInputBuilder()
    .setCustomId('date')
    .setLabel('Date')
    .setPlaceholder('2/16')
    .setRequired(true)
    .setStyle(TextInputStyle.Short)
    .setMaxLength(5);

  const timeInput = new TextInputBuilder()
    .setCustomId('time')
    .setLabel('Time (PM EST)')
    .setPlaceholder('8 or 8:30')
    .setRequired(true)
    .setStyle(TextInputStyle.Short)
    .setMaxLength(5);

  modal.addComponents(
    new ActionRowBuilder().addComponents(dateInput),
    new ActionRowBuilder().addComponents(timeInput)
  );

  return modal;
}

function parseCustomId(customId, prefix) {
  if (!customId.startsWith(prefix)) {
    return null;
  }

  return customId.split(':');
}

function validateDate(date) {
  return /^([1-9]|1[0-2])\/([1-9]|[12][0-9]|3[01])$/.test(date);
}

function validateTime(time) {
  return /^(1[0-2]|[1-9])(?::([0-5][0-9]))?$/.test(time);
}

function normalizeWeekValue(value) {
  return String(value || '')
    .trim()
    .replace(/^week\s*/i, '');
}

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

async function mentionForTeam(guild, teamName) {
  const roleId = await getRoleIdByTeamName(guild, teamName);
  return roleId ? `<@&${roleId}>` : `@${teamName}`;
}

async function resolveAnnouncementChannel(interaction, league) {
  const desiredName = LEAGUE_ANNOUNCEMENT_CHANNELS[league];
  if (!interaction.guild || !desiredName) {
    return interaction.channel;
  }

  await interaction.guild.channels.fetch();
  const match = interaction.guild.channels.cache.find(
    (channel) => channel.name === desiredName && channel.isTextBased()
  );

  return match || interaction.channel;
}

async function markChannelAsConfirmed(channel) {
  if (!channel || typeof channel.setName !== 'function' || !channel.name) {
    return;
  }

  if (channel.name.endsWith(CONFIRMED_CHANNEL_SUFFIX) || channel.name.endsWith(CONFIRMED_CHANNEL_FALLBACK_SUFFIX)) {
    return;
  }

  const maxNameLength = 100;
  const buildName = (suffix) => {
    const allowedBaseLength = maxNameLength - suffix.length;
    const base = channel.name.slice(0, allowedBaseLength);
    return `${base}${suffix}`;
  };

  try {
    await channel.setName(buildName(CONFIRMED_CHANNEL_SUFFIX), 'Match scheduling confirmed via /schedule');
    return;
  } catch (error) {
    // Fallback for guilds where emoji suffixes are rejected by channel naming rules.
    await channel.setName(buildName(CONFIRMED_CHANNEL_FALLBACK_SUFFIX), 'Match scheduling confirmed via /schedule');
  }
}

async function findMatchupChannelForMatch(guild, league, homeTeam, awayTeam) {
  if (!guild) {
    return null;
  }

  await guild.channels.fetch();
  const categoryName = LEAGUE_SCHEDULING_CATEGORIES[league];
  if (!categoryName) {
    return null;
  }

  const category = guild.channels.cache.find((ch) => ch.type === ChannelType.GuildCategory && ch.name === categoryName);
  if (!category) {
    return null;
  }

  const awaySlug = slugifyTeamName(awayTeam);
  const homeSlug = slugifyTeamName(homeTeam);
  const awayAtHome = `${awaySlug}-at-${homeSlug}`;
  const homeAtAway = `${homeSlug}-at-${awaySlug}`;
  const candidateNames = new Set([
    awayAtHome,
    `${awayAtHome}${CONFIRMED_CHANNEL_SUFFIX}`,
    `${awayAtHome}${CONFIRMED_CHANNEL_FALLBACK_SUFFIX}`,
    homeAtAway,
    `${homeAtAway}${CONFIRMED_CHANNEL_SUFFIX}`,
    `${homeAtAway}${CONFIRMED_CHANNEL_FALLBACK_SUFFIX}`,
  ]);

  return (
    guild.channels.cache.find(
      (ch) => ch.parentId === category.id && ch.isTextBased?.() && candidateNames.has(ch.name)
    ) || null
  );
}

function cleanupExpiredOverwrites() {
  const now = Date.now();
  for (const [token, data] of pendingOverwrites.entries()) {
    if (data.expiresAt <= now) {
      pendingOverwrites.delete(token);
    }
  }
}

function createOverwriteToken(payload) {
  cleanupExpiredOverwrites();
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  pendingOverwrites.set(token, {
    ...payload,
    expiresAt: Date.now() + OVERWRITE_CACHE_TTL_MS,
  });
  return token;
}

function buildOverwriteRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${OVERWRITE_BUTTON_PREFIX}:confirm:${token}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Overwrite'),
    new ButtonBuilder()
      .setCustomId(`${OVERWRITE_BUTTON_PREFIX}:cancel:${token}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Cancel')
  );
}

function parseOverwriteButton(customId) {
  if (!customId.startsWith(`${OVERWRITE_BUTTON_PREFIX}:`)) {
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

async function publishScheduleResult(interaction, league, week, time, date, match) {
  const { homeTeam, awayTeam } = match;
  const homeMention = await mentionForTeam(interaction.guild, homeTeam);
  const awayMention = await mentionForTeam(interaction.guild, awayTeam);

  const output = `${homeMention} ${awayMention} ${formatScheduleTime(time)} ${formatScheduleDate(date)}`;
  const reminder =
    '🚨 **REPLAY UPLOAD REMINDER** 🚨\n' +
    '**After your match, upload your ballchasing group link using** `/upload`';

  const targetChannel = await resolveAnnouncementChannel(interaction, league);
  if (targetChannel) {
    await targetChannel.send(output);
  }

  const matchupChannel = await findMatchupChannelForMatch(interaction.guild, league, homeTeam, awayTeam);

  if (matchupChannel) {
    try {
      await markChannelAsConfirmed(matchupChannel);
      await matchupChannel.send(`✅ **Match scheduled.**\n\n${reminder}`);
    } catch (error) {
      console.error('Failed to mark matchup channel as confirmed:', error);
    }
  } else if (interaction.channel) {
    try {
      await markChannelAsConfirmed(interaction.channel);
      await interaction.channel.send(`✅ **Match scheduled.**\n\n${reminder}`);
    } catch (error) {
      console.error('Failed to mark channel as confirmed:', error);
    }
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Schedule a Rocket League league match')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async handleChatInput(interaction) {
    if (!isAdminAuthorized(interaction)) {
      await interaction.reply({
        content: 'You need admin access to use this command.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const inferredLeague = inferLeagueFromParentCategory(interaction.channel);
    if (inferredLeague && interaction.channel?.name?.includes('-at-')) {
      const inferredMatch = await getMatchByChannel(inferredLeague, interaction.channel.name);
      if (inferredMatch) {
        const week = normalizeWeekValue(inferredMatch.week);
        await interaction.showModal(buildScheduleModal(inferredLeague, week, inferredMatch.matchId));
        return;
      }
    }

    await interaction.reply({
      content: 'Select a league:',
      components: [buildLeagueRow()],
      flags: MessageFlags.Ephemeral,
    });
  },

  async handleSelectMenu(interaction) {
    if (interaction.customId === CUSTOM_IDS.LEAGUE) {
      const league = interaction.values[0];

      await interaction.update({
        content: `League selected: ${league}\nNow select a week:`,
        components: [buildWeekRow(league)],
      });
      return;
    }

    const weekParts = parseCustomId(interaction.customId, CUSTOM_IDS.WEEK_PREFIX);
    if (weekParts) {
      const league = weekParts[2];
      const week = interaction.values[0];
      const matches = await getMatchesByWeek(league, week);

      if (matches.length === 0) {
        await interaction.update({
          content: `No matches found for ${league} Week ${week}.`,
          components: [],
        });
        return;
      }

      await interaction.update({
        content: `${league} Week ${week} selected. Choose a match:`,
        components: [buildMatchRow(league, week, matches)],
      });
      return;
    }

    const matchParts = parseCustomId(interaction.customId, CUSTOM_IDS.MATCH_PREFIX);
    if (matchParts) {
      const league = matchParts[2];
      const week = matchParts[3];
      const matchId = interaction.values[0];
      await interaction.showModal(buildScheduleModal(league, week, matchId));
    }
  },

  async handleModalSubmit(interaction) {
    const modalParts = parseCustomId(interaction.customId, CUSTOM_IDS.MODAL_PREFIX);
    if (!modalParts) {
      return;
    }

    const league = modalParts[2];
    const week = modalParts[3];
    const matchId = modalParts.slice(4).join(':');

    const date = interaction.fields.getTextInputValue('date')?.trim();
    const time = interaction.fields.getTextInputValue('time')?.trim();

    if (!date || !time) {
      await interaction.reply({ content: 'Date and time are required.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (!validateDate(date)) {
      await interaction.reply({
        content: 'Date must be in M/D format (example: 2/16).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!validateTime(time)) {
      await interaction.reply({
        content: 'Time must be 1-12 or 1-12:MM (00-59) in PM EST.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let updateResult;
    try {
      updateResult = await updateMatchDateTime(league, matchId, date, time, { preventDuplicate: true });
    } catch (error) {
      if (error?.code === 403 || error?.response?.status === 403) {
        await interaction.reply({
          content:
            'Google Sheets update failed: service account lacks edit permission on this league sheet. Share the spreadsheet with GOOGLE_CLIENT_EMAIL as Editor.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      throw error;
    }

    if (updateResult.duplicate) {
      const token = createOverwriteToken({
        userId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        league,
        week,
        matchId,
        date,
        time,
      });

      const existingDate = updateResult.existingDate ? ` (${updateResult.existingDate})` : '';
      const existingTime = updateResult.existingTime ? ` (${updateResult.existingTime})` : '';

      await interaction.reply({
        content: `This match is already scheduled${existingDate || existingTime ? ` [current date${existingDate} time${existingTime}]` : ''}. Are you sure you want to overwrite it?`,
        components: [buildOverwriteRow(token)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await publishScheduleResult(interaction, league, week, time, date, updateResult.match);
    await interaction.reply({ content: '\u2705 Match scheduled successfully', flags: MessageFlags.Ephemeral });
  },

  async handleButtonInteraction(interaction) {
    const parsed = parseOverwriteButton(interaction.customId);
    if (!parsed) {
      return;
    }

    const pending = pendingOverwrites.get(parsed.token);
    if (!pending || pending.expiresAt <= Date.now()) {
      pendingOverwrites.delete(parsed.token);
      await interaction.reply({
        content: 'This overwrite confirmation expired. Please submit /schedule again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.user.id !== pending.userId) {
      await interaction.reply({
        content: 'Only the admin who submitted this schedule can confirm overwrite.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (parsed.action === 'cancel') {
      pendingOverwrites.delete(parsed.token);
      await interaction.update({
        content: 'Overwrite canceled.',
        components: [],
      });
      return;
    }

    if (parsed.action !== 'confirm') {
      return;
    }

    await interaction.update({
      content: 'Overwriting existing schedule...',
      components: [],
    });

    try {
      const updateResult = await updateMatchDateTime(pending.league, pending.matchId, pending.date, pending.time, {
        preventDuplicate: false,
      });

      await publishScheduleResult(
        interaction,
        pending.league,
        pending.week,
        pending.time,
        pending.date,
        updateResult.match
      );
      pendingOverwrites.delete(parsed.token);
      await interaction.editReply('\u2705 Match schedule overwritten successfully');
    } catch (error) {
      console.error('Failed overwrite scheduling:', error);
      await interaction.editReply('Failed to overwrite schedule. Please try again.');
    }
  },
};
