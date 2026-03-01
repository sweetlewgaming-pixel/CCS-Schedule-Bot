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
    const lines = [];
    const add = (command, description) => lines.push(`\`${command}\` - ${description}`);

    if (isElevated) {
      lines.push('**Command Access Tiers**', '', '**Everyone**');
      add('/help', 'Show this command list.');
      add(
        '/availability',
        'Post your weekly availability (matchup channels + team channels like `*-organization` / `*-chat`).'
      );

      lines.push('', '**Team Members (Matchup Channels)**');
      add('/upload', 'Upload a Ballchasing group link for the current matchup.');
      add('/propose_time', 'Post a proposed match time request with accept/decline buttons.');

      lines.push('', '**Staff / Admin**');
      add('/schedule', 'Schedule a match date/time or record forfeits.');
      add('/rebuild_week', 'Delete/recreate weekly matchup channels from RawSchedule.');
      add('/suggest', 'Parse posted availability and suggest best overlap times.');
      add('/upload_staff', 'Staff upload mode from any channel (select league/week/match if needed).');
      add('/availability_admin', 'Create or import availability on behalf of another user.');
    } else {
      lines.push('**Commands You Can Use**');
      add('/help', 'Show this command list.');
      if (inAvailabilityChannel) {
        add('/availability', 'Post your weekly availability using the schedule UI.');
      } else {
        add(
          '/availability',
          'Post availability (use in matchup channels or team channels like `*-organization` / `*-chat`).'
        );
      }

      if (inMatchupChannel) {
        add('/upload', 'Upload a Ballchasing group link for this matchup (team members + staff).');
        add('/propose_time', 'Post a proposed match time request with accept/decline buttons.');
      }
    }

    await interaction.reply({
      content: lines.join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  },
};
