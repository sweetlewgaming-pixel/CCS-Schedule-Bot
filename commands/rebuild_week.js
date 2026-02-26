const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');

const { rebuildWeekChannelsForLeagues } = require('../services/scheduleChannels');
const { isAdminAuthorized } = require('../utils/permissions');

const LEAGUES = ['CCS', 'CPL', 'CAS', 'CNL'];
const ALL_LEAGUES = 'ALL';
const BUTTON_PREFIX = 'rebuild_week';

function getTargetLeagues(leagueOption) {
  return leagueOption === ALL_LEAGUES ? LEAGUES : [leagueOption];
}

function buildConfirmRow(userId, league, week) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}:confirm:${userId}:${league}:${week}`)
      .setLabel('Yes, rebuild')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}:cancel:${userId}:${league}:${week}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );
}

function parseButtonCustomId(customId) {
  if (!customId.startsWith(`${BUTTON_PREFIX}:`)) {
    return null;
  }

  const parts = customId.split(':');
  if (parts.length < 5) {
    return null;
  }

  return {
    action: parts[1],
    userId: parts[2],
    league: parts[3],
    week: Number(parts[4]),
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rebuild_week')
    .setDescription('Delete and recreate weekly scheduling channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName('league')
        .setDescription('League to rebuild, or ALL')
        .setRequired(true)
        .addChoices(
          { name: 'ALL', value: ALL_LEAGUES },
          ...LEAGUES.map((league) => ({ name: league, value: league }))
        )
    )
    .addIntegerOption((option) =>
      option.setName('week').setDescription('Week number').setRequired(true).setMinValue(1).setMaxValue(12)
    ),

  async handleChatInput(interaction) {
    if (!interaction.guild) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
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

    const me = await interaction.guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({
        content: 'Bot is missing Manage Channels permission.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const league = interaction.options.getString('league', true);
    const week = interaction.options.getInteger('week', true);
    const scopeText = league === ALL_LEAGUES ? 'ALL leagues' : `${league}`;

    await interaction.reply({
      content: `Are you sure you want to rebuild scheduling channels for ${scopeText} Week ${week}? This will delete current matchup text channels inside the selected scheduling categories.`,
      components: [buildConfirmRow(interaction.user.id, league, week)],
      flags: MessageFlags.Ephemeral,
    });
  },

  async handleButtonInteraction(interaction) {
    const parsed = parseButtonCustomId(interaction.customId);
    if (!parsed) {
      return;
    }

    if (interaction.user.id !== parsed.userId) {
      await interaction.reply({
        content: 'Only the admin who started this action can confirm it.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (parsed.action === 'cancel') {
      await interaction.update({
        content: 'Rebuild canceled.',
        components: [],
      });
      return;
    }

    if (parsed.action !== 'confirm') {
      return;
    }

    if (!isAdminAuthorized(interaction)) {
      await interaction.update({
        content: 'You no longer have permission to run this action.',
        components: [],
      });
      return;
    }

    const me = await interaction.guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.update({
        content: 'Bot is missing Manage Channels permission.',
        components: [],
      });
      return;
    }

    await interaction.update({
      content: 'Rebuilding scheduling channels, please wait...',
      components: [],
    });

    const targetLeagues = getTargetLeagues(parsed.league);

    try {
      const { results, skipped } = await rebuildWeekChannelsForLeagues(interaction.guild, targetLeagues, parsed.week);

      const summaryLines = [];
      for (const result of results) {
        summaryLines.push(
          `✅ ${result.league}: Deleted ${result.deletedCount}, Created ${result.createdCount} (Week ${parsed.week})`
        );

        if (result.createdNames.length) {
          summaryLines.push(result.createdNames.map((name) => `- #${name}`).join('\n'));
        }
      }

      for (const item of skipped) {
        summaryLines.push(`⚠️ ${item.league}: Skipped (${item.reason})`);
      }

      await interaction.editReply(summaryLines.join('\n'));
    } catch (error) {
      console.error('Failed to rebuild week channels:', error);
      await interaction.editReply(
        `Failed to rebuild channels. No changes were made for this run if planning failed. Error: ${error.message}`
      );
    }
  },
};
