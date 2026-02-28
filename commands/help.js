const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { isAdminAuthorized } = require('../utils/permissions');

function cleanChannelName(name) {
  return String(name || '').replace(/[\u2705]+$/u, '').replace(/confirmed$/i, '').trim();
}

function isMatchupChannel(name) {
  return cleanChannelName(name).includes('-at-');
}

function isTeamChannel(name) {
  const cleaned = cleanChannelName(name).toLowerCase();
  return cleaned.endsWith('-organization') || cleaned.endsWith('-chat');
}

function isAvailabilityAllowedChannel(name) {
  return isMatchupChannel(name) || isTeamChannel(name);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show command list and who can use each command')
    .setDMPermission(false),

  async handleChatInput(interaction) {
    const isElevated = isAdminAuthorized(interaction);
    const channelName = interaction.channel?.name || '';
    const inMatchupChannel = isMatchupChannel(channelName);
    const inAvailabilityChannel = isAvailabilityAllowedChannel(channelName);

    const lines = ['**Commands You Can Use**', '`/help`'];

    if (inAvailabilityChannel) {
      lines.push('`/availability`');
    }

    if (isElevated) {
      lines.push(
        '`/schedule`',
        '`/rebuild_week`',
        '`/suggest_times`',
        '`/request`',
        '`/upload_null`',
        '`/availability_admin`'
      );
      if (inMatchupChannel) {
        lines.push('`/upload`');
      } else {
        lines.push('`/upload` (run in a matchup channel)');
      }
    } else {
      if (inMatchupChannel) {
        lines.push('`/upload` (if you are on one of the two teams)');
      }
    }

    lines.push('', '**Channel Notes**');
    lines.push('`/availability` works in matchup channels and team channels (`*-organization`, `*-chat`).');
    lines.push('`/upload` and `/upload_null` must be used in a matchup channel.');
    if (!isElevated) {
      lines.push('Staff-only commands are hidden because your role is not elevated.');
    }

    await interaction.reply({
      content: lines.join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  },
};
