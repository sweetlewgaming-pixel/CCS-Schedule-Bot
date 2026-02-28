const { ChannelType, MessageFlags, SlashCommandBuilder } = require('discord.js');

const { isAdminAuthorized } = require('../utils/permissions');
const {
  getMatchByChannel,
  updateMatchBallchasingLink,
  appendPlayerInputRows,
  appendTeamInputRows,
} = require('../services/googleSheets');
const { fetchBallchasingGroup, buildBallchasingPlayerRows, buildBallchasingTeamRows } = require('../services/ballchasing');

const LEAGUE_SCHEDULING_CATEGORIES = {
  CCS: 'CCS SCHEDULING',
  CPL: 'CPL SCHEDULING',
  CAS: 'CAS Scheduling',
  CNL: 'CNL Scheduling',
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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('upload_null')
    .setDescription('Upload ballchasing group link to sheet only (no replay-submissions post)')
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

    if (!isAdminAuthorized(interaction)) {
      await interaction.reply({
        content: 'You do not have permission to use this command.',
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

    const match = await getMatchByChannel(league, interaction.channel.name);
    if (!match) {
      await interaction.reply({
        content: 'Could not determine match from this channel name.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let duplicateCheckResult;
    try {
      duplicateCheckResult = await updateMatchBallchasingLink(league, match.matchId, link, {
        preventDuplicate: true,
        dryRun: true,
      });
    } catch (error) {
      if (error?.code === 403 || error?.response?.status === 403) {
        await interaction.reply({
          content: 'Google Sheets update failed: service account lacks edit permission on this league sheet.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      throw error;
    }

    if (duplicateCheckResult.duplicate) {
      await interaction.reply({
        content: `A ballchasing link is already saved for this match and cannot be replaced.\nCurrent: ${duplicateCheckResult.existingLink}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let appendPlayerResult;
    let appendTeamResult;
    try {
      const group = await fetchBallchasingGroup(link);
      const playerRows = buildBallchasingPlayerRows(match, group.data);
      const teamRows = buildBallchasingTeamRows(group.data, playerRows);
      appendPlayerResult = await appendPlayerInputRows(league, playerRows);
      appendTeamResult = await appendTeamInputRows(league, teamRows);
    } catch (error) {
      await interaction.reply({
        content: `Failed to import ballchasing raw stats: ${error.message}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      await updateMatchBallchasingLink(league, match.matchId, link, { preventDuplicate: false });
    } catch (error) {
      if (error?.code === 403 || error?.response?.status === 403) {
        await interaction.reply({
          content: 'Google Sheets update failed: service account lacks edit permission on this league sheet.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      throw error;
    }

    await interaction.reply({
      content:
        `✅ Ballchasing group link uploaded to sheet only.\n` +
        `✅ Imported ${appendPlayerResult.insertedRows} player row(s) into ${appendPlayerResult.sheetName}.\n` +
        `✅ Imported ${appendTeamResult.insertedRows} team row(s) into ${appendTeamResult.sheetName}.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
