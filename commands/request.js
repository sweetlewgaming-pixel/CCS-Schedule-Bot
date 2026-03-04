const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  MessageFlags,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const { isAdminAuthorized } = require('../utils/permissions');
const { getRoleIdByTeamName } = require('../utils/teamRoles');
const { getMatchByChannel } = require('../services/googleSheets');
const { inferLeagueFromParentCategory, scheduleMatchById } = require('./schedule');
const MENTION_DEBUG_ENABLED = String(process.env.MENTION_DEBUG || '').trim().toLowerCase() === 'true';
const ACCEPT_EMOJI = '\u2705';
const REJECT_EMOJI = '\u274C';
const SCHEDULE_BUTTON_PREFIX = 'propose:schedule';
const SCHEDULE_CONFIRM_PREFIX = 'propose:confirm';
const SCHEDULE_MODAL_PREFIX = 'propose:modal';
const PROPOSAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const pendingProposalSchedules = new Map();
const DAY_VARIANTS = new Map([
  ['sun', { label: 'Sunday', index: 0 }],
  ['sunday', { label: 'Sunday', index: 0 }],
  ['mon', { label: 'Monday', index: 1 }],
  ['monday', { label: 'Monday', index: 1 }],
  ['tue', { label: 'Tuesday', index: 2 }],
  ['tues', { label: 'Tuesday', index: 2 }],
  ['tuesday', { label: 'Tuesday', index: 2 }],
  ['wed', { label: 'Wednesday', index: 3 }],
  ['weds', { label: 'Wednesday', index: 3 }],
  ['wednesday', { label: 'Wednesday', index: 3 }],
  ['thu', { label: 'Thursday', index: 4 }],
  ['thur', { label: 'Thursday', index: 4 }],
  ['thurs', { label: 'Thursday', index: 4 }],
  ['thursday', { label: 'Thursday', index: 4 }],
  ['fri', { label: 'Friday', index: 5 }],
  ['friday', { label: 'Friday', index: 5 }],
  ['sat', { label: 'Saturday', index: 6 }],
  ['saturday', { label: 'Saturday', index: 6 }],
]);
const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function cleanMatchupChannelName(name) {
  return String(name || '').replace(/[\u2705]+$/u, '').replace(/confirmed$/i, '').trim();
}

function parseMatchupSlugsFromChannel(channelName) {
  const cleaned = cleanMatchupChannelName(channelName);
  const parts = cleaned.split('-at-');
  if (parts.length !== 2) {
    return null;
  }

  const left = parts[0].trim();
  const right = parts[1].trim();
  if (!left || !right) {
    return null;
  }

  return {
    leftSlug: left,
    rightSlug: right,
  };
}

function parseDayInput(dayInput) {
  const key = String(dayInput || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return DAY_VARIANTS.get(key) || null;
}

function parseDateInput(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^([1-9]|1[0-2])\/([1-9]|[12][0-9]|3[01])$/);
  if (!match) {
    return null;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const now = new Date();
  const currentYear = now.getFullYear();
  const candidate = new Date(currentYear, month - 1, day);
  if (candidate.getMonth() !== month - 1 || candidate.getDate() !== day) {
    return null;
  }

  return {
    month,
    day,
    date: `${month}/${day}`,
    weekday: candidate.getDay(),
  };
}

function getNextDateForWeekday(targetWeekday) {
  const now = new Date();
  const currentWeekday = now.getDay();
  const daysToAdd = (targetWeekday - currentWeekday + 7) % 7;
  const target = new Date(now);
  target.setHours(0, 0, 0, 0);
  target.setDate(target.getDate() + daysToAdd);
  const month = target.getMonth() + 1;
  const day = target.getDate();
  return `${month}/${day}`;
}

function validateDate(date) {
  return /^([1-9]|1[0-2])\/([1-9]|[12][0-9]|3[01])$/.test(String(date || '').trim());
}

function validateTime(time) {
  return /^(1[0-2]|[1-9])(?::([0-5][0-9]))?\s*(am|pm)?$/i.test(String(time || '').trim());
}

function cleanupExpiredProposalSchedules() {
  const now = Date.now();
  for (const [token, data] of pendingProposalSchedules.entries()) {
    if (data.expiresAt <= now) {
      pendingProposalSchedules.delete(token);
    }
  }
}

function createProposalScheduleToken(payload) {
  cleanupExpiredProposalSchedules();
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  pendingProposalSchedules.set(token, {
    ...payload,
    expiresAt: Date.now() + PROPOSAL_CACHE_TTL_MS,
  });
  return token;
}

function buildScheduleProposalRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SCHEDULE_BUTTON_PREFIX}:${token}`)
      .setStyle(ButtonStyle.Primary)
      .setLabel('Schedule Proposed Time')
  );
}

function parseScheduleProposalButton(customId) {
  if (!String(customId || '').startsWith(`${SCHEDULE_BUTTON_PREFIX}:`)) {
    return null;
  }

  const parts = String(customId).split(':');
  if (parts.length !== 3) {
    return null;
  }

  return { token: parts[2] };
}

function parseScheduleProposalModal(customId) {
  if (!String(customId || '').startsWith(`${SCHEDULE_MODAL_PREFIX}:`)) {
    return null;
  }

  const parts = String(customId).split(':');
  if (parts.length !== 3) {
    return null;
  }

  return { token: parts[2] };
}

function buildScheduleConfirmRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SCHEDULE_CONFIRM_PREFIX}:yes:${token}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Yes, schedule it'),
    new ButtonBuilder()
      .setCustomId(`${SCHEDULE_CONFIRM_PREFIX}:cancel:${token}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Cancel')
  );
}

function parseScheduleConfirmButton(customId) {
  if (!String(customId || '').startsWith(`${SCHEDULE_CONFIRM_PREFIX}:`)) {
    return null;
  }

  const parts = String(customId).split(':');
  if (parts.length !== 4) {
    return null;
  }

  return {
    action: parts[2],
    token: parts[3],
  };
}

function buildScheduleFromProposalModal(token, proposal) {
  const modal = new ModalBuilder().setCustomId(`${SCHEDULE_MODAL_PREFIX}:${token}`).setTitle('Schedule Proposed Time');

  const dateInput = new TextInputBuilder()
    .setCustomId('date')
    .setLabel('Date (M/D)')
    .setPlaceholder('2/16')
    .setRequired(true)
    .setStyle(TextInputStyle.Short)
    .setMaxLength(5);

  const timeInput = new TextInputBuilder()
    .setCustomId('time')
    .setLabel('Time (EST)')
    .setPlaceholder('8, 8:30, or 10:15am')
    .setRequired(true)
    .setStyle(TextInputStyle.Short)
    .setMaxLength(8);

  const proposalDay = String(proposal?.proposedDate || proposal?.day || '').trim();
  const proposalTime = String(proposal?.time || '').trim();
  if (validateDate(proposalDay)) {
    dateInput.setValue(proposalDay);
  }
  if (validateTime(proposalTime)) {
    timeInput.setValue(proposalTime);
  }

  modal.addComponents(
    new ActionRowBuilder().addComponents(dateInput),
    new ActionRowBuilder().addComponents(timeInput)
  );

  return modal;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('propose_time')
    .setDescription('Request a proposed day/time in this matchup channel')
    .addStringOption((option) =>
      option.setName('day').setDescription('Day or date (ex: Tues or 3/9)').setRequired(true)
    )
    .addStringOption((option) =>
      option.setName('time').setDescription('Proposed time (ex: 8 PM, 8:30pm)').setRequired(true)
    )
    .setDMPermission(false),

  async handleChatInput(interaction) {
    if (!interaction.guild || !interaction.channel || !interaction.channel.isTextBased?.()) {
      await interaction.reply({
        content: 'Use this command in a server text channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!isAdminAuthorized(interaction)) {
      await interaction.reply({
        content: 'You need the required role level (Mods+) or CCS Times Keeper to use this command.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const slugs = parseMatchupSlugsFromChannel(interaction.channel.name);
    if (!slugs) {
      await interaction.reply({
        content: 'Use `/propose_time` inside a matchup channel named like `team-a-at-team-b`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const dayInput = interaction.options.getString('day', true).trim();
    const time = interaction.options.getString('time', true).trim();
    const parsedDay = parseDayInput(dayInput);
    const parsedDate = parsedDay ? null : parseDateInput(dayInput);
    if (!parsedDay && !parsedDate) {
      await interaction.reply({
        content:
          'Day must be a weekday name (Tuesday) or abbreviation (Tues), or a date in M/D format (example: 3/9).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!validateTime(time)) {
      await interaction.reply({
        content: 'Time must be 1-12 or 1-12:MM (00-59), optional am/pm (case-insensitive).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const day = parsedDay ? parsedDay.label : WEEKDAY_LABELS[parsedDate.weekday];
    const proposedDate = parsedDay ? getNextDateForWeekday(parsedDay.index) : parsedDate.date;

    const roleAId = await getRoleIdByTeamName(interaction.guild, slugs.leftSlug);
    const roleBId = await getRoleIdByTeamName(interaction.guild, slugs.rightSlug);

    const mentionA = roleAId ? `<@&${roleAId}>` : `@${slugs.leftSlug}`;
    const mentionB = roleBId ? `<@&${roleBId}>` : `@${slugs.rightSlug}`;

    const lines = [
      `${mentionA} ${mentionB}`,
      `**Scheduling request from** <@${interaction.user.id}>`,
      `**Day:** ${day}`,
      `**Date:** ${proposedDate}`,
      `**Time:** ${time}`,
    ];
    lines.push(`React with ${ACCEPT_EMOJI} or ${REJECT_EMOJI} below.`);

    const inferredLeague = inferLeagueFromParentCategory(interaction.channel);
    const inferredMatch =
      inferredLeague && interaction.channel?.name?.includes('-at-')
        ? await getMatchByChannel(inferredLeague, interaction.channel)
        : null;

    let scheduleComponents = [];
    if (inferredLeague && inferredMatch) {
      const week = String(inferredMatch.week || '').trim().replace(/^week\s*/i, '');
      const token = createProposalScheduleToken({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        league: inferredLeague,
        week,
        matchId: inferredMatch.matchId,
        day,
        proposedDate,
        time,
      });
      scheduleComponents = [buildScheduleProposalRow(token)];
    }

    const allowedRoleMentions = [roleAId, roleBId].filter(Boolean);
    await interaction.reply({
      content: lines.join('\n'),
      components: scheduleComponents,
      allowedMentions: {
        parse: ['users'],
        roles: allowedRoleMentions,
      },
    });

    const sent = await interaction.fetchReply();
    if (MENTION_DEBUG_ENABLED) {
      const recognizedRoleIds = [...(sent.mentions?.roles?.keys?.() || [])];
      const expectedRoleIds = [roleAId, roleBId].filter(Boolean);
      const missingRoleMentions = expectedRoleIds.filter((id) => !recognizedRoleIds.includes(id));
      await interaction.followUp({
        content:
          `[mention-debug] expected roles: ${expectedRoleIds.length ? expectedRoleIds.join(', ') : 'none'} | ` +
          `recognized in sent message: ${recognizedRoleIds.length ? recognizedRoleIds.join(', ') : 'none'} | ` +
          `missing: ${missingRoleMentions.length ? missingRoleMentions.join(', ') : 'none'}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await sent.react(ACCEPT_EMOJI).catch(() => {});
    await sent.react(REJECT_EMOJI).catch(() => {});
  },

  async handleButtonInteraction(interaction) {
    const confirmParsed = parseScheduleConfirmButton(interaction.customId);
    if (confirmParsed) {
      if (!isAdminAuthorized(interaction)) {
        await interaction.reply({
          content: 'You need the required role level (Mods+) or CCS Times Keeper to schedule from this proposal.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      cleanupExpiredProposalSchedules();
      const pending = pendingProposalSchedules.get(confirmParsed.token);
      if (!pending || pending.expiresAt <= Date.now()) {
        pendingProposalSchedules.delete(confirmParsed.token);
        await interaction.update({
          content: 'This proposal scheduling confirmation expired. Post a new /propose_time request.',
          components: [],
        });
        return;
      }

      if (pending.guildId !== interaction.guildId || pending.channelId !== interaction.channelId) {
        await interaction.reply({
          content: 'This scheduling confirmation is only valid in the original matchup channel.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (confirmParsed.action === 'cancel') {
        await interaction.update({
          content: 'Scheduling canceled.',
          components: [],
        });
        return;
      }

      if (confirmParsed.action !== 'yes') {
        return;
      }

      const proposedDate = String(pending.proposedDate || pending.day || '').trim();
      const proposedTime = String(pending.time || '').trim();
      if (validateDate(proposedDate) && validateTime(proposedTime)) {
        try {
          const updateResult = await scheduleMatchById(interaction, {
            league: pending.league,
            week: pending.week,
            matchId: pending.matchId,
            date: proposedDate,
            time: proposedTime,
            preventDuplicate: true,
          });

          if (updateResult.duplicate) {
            const existingDate = updateResult.existingDate ? ` (${updateResult.existingDate})` : '';
            const existingTime = updateResult.existingTime ? ` (${updateResult.existingTime})` : '';
            await interaction.update({
              content:
                `This match is already scheduled${existingDate || existingTime ? ` [current date${existingDate} time${existingTime}]` : ''}. ` +
                'Use /reschedule if you need to change it.',
              components: [],
            });
            return;
          }

          pendingProposalSchedules.delete(confirmParsed.token);
          await interaction.update({
            content: '✅ Match scheduled from proposal successfully.',
            components: [],
          });
        } catch (error) {
          if (error?.code === 403 || error?.response?.status === 403) {
            await interaction.update({
              content:
                'Google Sheets update failed: service account lacks edit permission on this league sheet. Share the spreadsheet with GOOGLE_CLIENT_EMAIL as Editor.',
              components: [],
            });
            return;
          }
          throw error;
        }
        return;
      }

      await interaction.showModal(buildScheduleFromProposalModal(confirmParsed.token, pending));
      return;
    }

    const parsed = parseScheduleProposalButton(interaction.customId);
    if (!parsed) {
      return;
    }

    if (!isAdminAuthorized(interaction)) {
      await interaction.reply({
        content: 'You need the required role level (Mods+) or CCS Times Keeper to schedule from this proposal.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    cleanupExpiredProposalSchedules();
    const pending = pendingProposalSchedules.get(parsed.token);
    if (!pending || pending.expiresAt <= Date.now()) {
      pendingProposalSchedules.delete(parsed.token);
      await interaction.reply({
        content: 'This proposal scheduling button expired. Post a new /propose_time request.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (pending.guildId !== interaction.guildId || pending.channelId !== interaction.channelId) {
      await interaction.reply({
        content: 'This scheduling button is only valid in the original matchup channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: 'Are you sure you want to schedule this proposed time?',
      components: [buildScheduleConfirmRow(parsed.token)],
      flags: MessageFlags.Ephemeral,
    });
  },

  async handleModalSubmit(interaction) {
    const parsed = parseScheduleProposalModal(interaction.customId);
    if (!parsed) {
      return;
    }

    if (!isAdminAuthorized(interaction)) {
      await interaction.reply({
        content: 'You need the required role level (Mods+) or CCS Times Keeper to schedule from this proposal.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    cleanupExpiredProposalSchedules();
    const pending = pendingProposalSchedules.get(parsed.token);
    if (!pending || pending.expiresAt <= Date.now()) {
      pendingProposalSchedules.delete(parsed.token);
      await interaction.reply({
        content: 'This proposal scheduling session expired. Post a new /propose_time request.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (pending.guildId !== interaction.guildId || pending.channelId !== interaction.channelId) {
      await interaction.reply({
        content: 'This scheduling session is only valid in the original matchup channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const date = interaction.fields.getTextInputValue('date')?.trim();
    const time = interaction.fields.getTextInputValue('time')?.trim();

    if (!validateDate(date)) {
      await interaction.reply({
        content: 'Date must be in M/D format (example: 2/16).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!validateTime(time)) {
      await interaction.reply({
        content: 'Time must be 1-12 or 1-12:MM (00-59), optional am/pm (default is PM).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      const updateResult = await scheduleMatchById(interaction, {
        league: pending.league,
        week: pending.week,
        matchId: pending.matchId,
        date,
        time,
        preventDuplicate: true,
      });

      if (updateResult.duplicate) {
        const existingDate = updateResult.existingDate ? ` (${updateResult.existingDate})` : '';
        const existingTime = updateResult.existingTime ? ` (${updateResult.existingTime})` : '';
        await interaction.reply({
          content:
            `This match is already scheduled${existingDate || existingTime ? ` [current date${existingDate} time${existingTime}]` : ''}. ` +
            'Use /reschedule if you need to change it.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      pendingProposalSchedules.delete(parsed.token);
      await interaction.reply({
        content: '✅ Match scheduled from proposal successfully.',
        flags: MessageFlags.Ephemeral,
      });
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
  },
};
