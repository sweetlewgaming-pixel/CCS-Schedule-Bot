const {
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');

const { isAdminAuthorized } = require('../utils/permissions');
const { slugifyTeamName } = require('../utils/slugify');

function cleanMatchupChannelName(name) {
  return String(name || '').replace(/✅+$/u, '').replace(/confirmed$/i, '').trim();
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

async function resolveRoleBySlug(guild, teamSlug) {
  if (!guild || !teamSlug) {
    return null;
  }

  if (!guild.roles.cache.size) {
    await guild.roles.fetch();
  }

  const targetSlug = slugifyTeamName(teamSlug);
  let bestRole = null;
  let bestScore = 0;

  for (const role of guild.roles.cache.values()) {
    const roleSlug = slugifyTeamName(role.name);
    let score = 0;
    if (roleSlug === targetSlug) {
      score = 1000;
    } else if (roleSlug.endsWith(`-${targetSlug}`) || roleSlug.startsWith(`${targetSlug}-`)) {
      score = 900;
    } else if (roleSlug.includes(targetSlug)) {
      score = 600;
    }

    if (score > bestScore) {
      bestScore = score;
      bestRole = role;
    }
  }

  return bestScore >= 600 ? bestRole : null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('request')
    .setDescription('Request a proposed day/time in this matchup channel')
    .addStringOption((option) => option.setName('day').setDescription('Day (ex: Tuesday)').setRequired(true))
    .addStringOption((option) =>
      option.setName('time').setDescription('Proposed time range (ex: 8-10 PM EST)').setRequired(true)
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
        content: 'Use `/request` inside a matchup channel named like `team-a-at-team-b`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const day = interaction.options.getString('day', true).trim();
    const time = interaction.options.getString('time', true).trim();

    const roleA = await resolveRoleBySlug(interaction.guild, slugs.leftSlug);
    const roleB = await resolveRoleBySlug(interaction.guild, slugs.rightSlug);

    const mentionA = roleA ? `<@&${roleA.id}>` : `@${slugs.leftSlug}`;
    const mentionB = roleB ? `<@&${roleB.id}>` : `@${slugs.rightSlug}`;

    const lines = [
      `${mentionA} ${mentionB}`,
      `**Scheduling request from** <@${interaction.user.id}>`,
      `**Day:** ${day}`,
      `**Time:** ${time}`,
    ];
    lines.push('React with ✅ or ❌ below.');

    await interaction.reply({
      content: lines.join('\n'),
    });

    const sent = await interaction.fetchReply();
    await sent.react('✅').catch(() => {});
    await sent.react('❌').catch(() => {});
  },
};
