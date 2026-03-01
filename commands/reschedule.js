const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');

const { getMatchByChannel, updateMatchDateTime } = require('../services/googleSheets');
const { formatScheduleDate, formatScheduleTime } = require('../utils/formatDate');
const { getRoleIdByTeamName } = require('../utils/teamRoles');
const { isAdminAuthorized } = require('../utils/permissions');

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

const CUSTOM_IDS = {
  MODAL_PREFIX: 'reschedule:modal',
  CONFIRM_PREFIX: 'reschedule:confirm',
};

const CONFIRM_TTL_MS = 10 * 60 * 1000;
const pendingReschedules = new Map();

function encodeValue(value) {
  return encodeURIComponent(String(value || '').trim());
}

function decodeValue(value) {
  return decodeURIComponent(String(value || ''));
}

function validateDate(date) {
  return /^([1-9]|1[0-2])\/([1-9]|[12][0-9]|3[01])$/.test(String(date || '').trim());
}

function validateTime(time) {
  return /^(1[0-2]|[1-9])(?::([0-5][0-9]))?$/.test(String(time || '').trim());
}

function isMeaningfulScheduleValue(value) {
  const cleaned = String(value || '').trim().toLowerCase();
  return cleaned !== '' && cleaned !== 'tbd' && cleaned !== 'na' && cleaned !== 'n/a' && cleaned !== '-';
}

function parseCustomId(customId, prefix) {
  if (!String(customId || '').startsWith(prefix)) {
    return null;
  }
  return String(customId).split(':');
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

function cleanupExpiredReschedules() {
  const now = Date.now();
  for (const [token, payload] of pendingReschedules.entries()) {
    if (payload.expiresAt <= now) {
      pendingReschedules.delete(token);
    }
  }
}

function createRescheduleToken(payload) {
  cleanupExpiredReschedules();
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  pendingReschedules.set(token, {
    ...payload,
    expiresAt: Date.now() + CONFIRM_TTL_MS,
  });
  return token;
}

function buildRescheduleModal(league, matchId, oldDate, oldTime) {
  const modal = new ModalBuilder()
    .setCustomId(`${CUSTOM_IDS.MODAL_PREFIX}:${league}:${encodeValue(matchId)}`)
    .setTitle('Reschedule Match');

  const dateInput = new TextInputBuilder()
    .setCustomId('date')
    .setLabel('New Date')
    .setPlaceholder('2/16')
    .setValue(String(oldDate || '').trim() || '2/16')
    .setRequired(true)
    .setStyle(TextInputStyle.Short)
    .setMaxLength(5);

  const timeInput = new TextInputBuilder()
    .setCustomId('time')
    .setLabel('New Time (PM EST)')
    .setPlaceholder('8 or 8:30')
    .setValue(String(oldTime || '').trim() || '8')
    .setRequired(true)
    .setStyle(TextInputStyle.Short)
    .setMaxLength(5);

  modal.addComponents(
    new ActionRowBuilder().addComponents(dateInput),
    new ActionRowBuilder().addComponents(timeInput)
  );

  return modal;
}

function buildConfirmRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_IDS.CONFIRM_PREFIX}:yes:${token}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Yes, reschedule'),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_IDS.CONFIRM_PREFIX}:no:${token}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Cancel')
  );
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

async function deletePreviousScheduledPost(channel, botUserId, homeMention, awayMention, homeTeam, awayTeam, oldTime, oldDate) {
  if (!channel || !channel.isTextBased?.()) {
    return false;
  }

  const oldTimeText = formatScheduleTime(oldTime);
  const oldDateText = formatScheduleDate(oldDate);
  const batches = [];
  let before;
  for (let i = 0; i < 3; i += 1) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) {
      break;
    }
    batches.push(...batch.values());
    before = batch.last().id;
  }

  const target = batches.find((msg) => {
    if (msg.author?.id !== botUserId) {
      return false;
    }
    const content = String(msg.content || '');
    if (!content.includes(oldTimeText) || !content.includes(oldDateText)) {
      return false;
    }

    const hasMentions =
      content.includes(homeMention) && content.includes(awayMention);
    const hasNames =
      content.toLowerCase().includes(String(homeTeam || '').toLowerCase()) &&
      content.toLowerCase().includes(String(awayTeam || '').toLowerCase());

    return hasMentions || hasNames;
  });

  if (!target) {
    return false;
  }

  await target.delete().catch(() => {});
  return true;
}

async function publishRescheduledPosts(interaction, league, payload, updatedMatch) {
  const homeMention = await mentionForTeam(interaction.guild, updatedMatch.homeTeam);
  const awayMention = await mentionForTeam(interaction.guild, updatedMatch.awayTeam);
  const newLine = `RESCHEDULED: ${homeMention} ${awayMention} ${formatScheduleTime(payload.newTime)} ${formatScheduleDate(payload.newDate)}`;

  const announcementChannel = await resolveAnnouncementChannel(interaction, league);

  await deletePreviousScheduledPost(
    interaction.channel,
    interaction.client.user.id,
    homeMention,
    awayMention,
    updatedMatch.homeTeam,
    updatedMatch.awayTeam,
    payload.oldTime,
    payload.oldDate
  );

  if (announcementChannel && announcementChannel.id !== interaction.channel.id) {
    await deletePreviousScheduledPost(
      announcementChannel,
      interaction.client.user.id,
      homeMention,
      awayMention,
      updatedMatch.homeTeam,
      updatedMatch.awayTeam,
      payload.oldTime,
      payload.oldDate
    );
  }

  await interaction.channel.send(newLine);
  if (announcementChannel && announcementChannel.id !== interaction.channel.id) {
    await announcementChannel.send(newLine);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reschedule')
    .setDescription('Reschedule an already scheduled match')
    .setDMPermission(false),

  async handleChatInput(interaction) {
    if (!isAdminAuthorized(interaction)) {
      await interaction.reply({
        content: 'Only staff can use this command.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const league = inferLeagueFromParentCategory(interaction.channel);
    if (!league || !interaction.channel?.name?.includes('-at-')) {
      await interaction.reply({
        content: 'Use this command inside the matchup scheduling channel for that match.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const match = await getMatchByChannel(league, interaction.channel);
    if (!match) {
      await interaction.reply({
        content: 'Could not determine the match for this channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!isMeaningfulScheduleValue(match.date) || !isMeaningfulScheduleValue(match.time)) {
      await interaction.reply({
        content: 'Game not scheduled yet. Please use /schedule first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.showModal(buildRescheduleModal(league, match.matchId, match.date, match.time));
  },

  async handleModalSubmit(interaction) {
    const parts = parseCustomId(interaction.customId, CUSTOM_IDS.MODAL_PREFIX);
    if (!parts) {
      return;
    }

    if (!isAdminAuthorized(interaction)) {
      await interaction.reply({
        content: 'Only staff can use this command.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const league = parts[2];
    const matchId = decodeValue(parts.slice(3).join(':'));
    const newDate = interaction.fields.getTextInputValue('date')?.trim();
    const newTime = interaction.fields.getTextInputValue('time')?.trim();

    if (!newDate || !newTime) {
      await interaction.reply({
        content: 'Date and time are required.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!validateDate(newDate)) {
      await interaction.reply({
        content: 'Date must be in M/D format (example: 2/16).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!validateTime(newTime)) {
      await interaction.reply({
        content: 'Time must be 1-12 or 1-12:MM (00-59) in PM EST.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const currentMatch = await getMatchByChannel(league, interaction.channel);
    if (!currentMatch || currentMatch.matchId !== matchId) {
      await interaction.reply({
        content: 'Match context changed. Please run /reschedule again from the matchup channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!isMeaningfulScheduleValue(currentMatch.date) || !isMeaningfulScheduleValue(currentMatch.time)) {
      await interaction.reply({
        content: 'Game not scheduled yet. Please use /schedule first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const token = createRescheduleToken({
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      league,
      matchId,
      oldDate: currentMatch.date,
      oldTime: currentMatch.time,
      newDate,
      newTime,
      homeTeam: currentMatch.homeTeam,
      awayTeam: currentMatch.awayTeam,
    });

    await interaction.reply({
      content:
        `Current: ${formatScheduleTime(currentMatch.time)} ${formatScheduleDate(currentMatch.date)}\n` +
        `New: ${formatScheduleTime(newTime)} ${formatScheduleDate(newDate)}\n\n` +
        'Are you sure you want to reschedule this match?',
      components: [buildConfirmRow(token)],
      flags: MessageFlags.Ephemeral,
    });
  },

  async handleButtonInteraction(interaction) {
    const parts = parseCustomId(interaction.customId, CUSTOM_IDS.CONFIRM_PREFIX);
    if (!parts) {
      return;
    }

    const action = parts[2];
    const token = parts[3];
    const pending = pendingReschedules.get(token);

    if (!pending || pending.expiresAt <= Date.now()) {
      pendingReschedules.delete(token);
      await interaction.reply({
        content: 'Reschedule confirmation expired. Run /reschedule again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.user.id !== pending.userId || interaction.guildId !== pending.guildId) {
      await interaction.reply({
        content: 'Only the staff member who started this reschedule can confirm it.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === 'no') {
      pendingReschedules.delete(token);
      await interaction.update({
        content: 'Reschedule canceled.',
        components: [],
      });
      return;
    }

    if (action !== 'yes') {
      return;
    }

    let updateResult;
    try {
      updateResult = await updateMatchDateTime(pending.league, pending.matchId, pending.newDate, pending.newTime, {
        preventDuplicate: false,
      });
    } catch (error) {
      if (error?.code === 403 || error?.response?.status === 403) {
        pendingReschedules.delete(token);
        await interaction.update({
          content:
            'Google Sheets update failed: service account lacks edit permission on this league sheet.',
          components: [],
        });
        return;
      }
      throw error;
    }

    await publishRescheduledPosts(interaction, pending.league, pending, updateResult.match);
    pendingReschedules.delete(token);

    await interaction.update({
      content: '✅ Match rescheduled successfully.',
      components: [],
    });
  },
};

