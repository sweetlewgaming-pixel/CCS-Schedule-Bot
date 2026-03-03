const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');

const { isAdminAuthorized } = require('../utils/permissions');
const {
  getMatchesByWeekDetailed,
  getOverallStandingsRecords,
  normalizeTeamKey,
  getInputStatsRows,
  extractMatchStatsFromInputRows,
} = require('../services/googleSheets');
const { fetchBallchasingGroup } = require('../services/ballchasing');
const { buildMatchSummary } = require('../services/resultSummary');
const { resolveLeagueLogoPath, resolveTeamLogoPath } = require('../services/logoResolver');
const { renderResultCard, renderMvpCard } = require('../services/resultCardRenderer');
const { resolveTeamColor } = require('../services/teamColors');
const { slugifyTeamName } = require('../utils/slugify');

const LEAGUES = ['CCS', 'CPL', 'CAS', 'CNL'];
const LEAGUE_OPTION_ALL = 'ALL';
const POST_GAP_MS = 3200;
const ACTIVE_RENDER_BACKEND = String(process.env.RENDER_BACKEND || 'html').trim().toLowerCase();
const MATCH_AUTOCOMPLETE_CACHE_MS = 30_000;
const matchAutocompleteCache = new Map();
const LEAGUE_DISPLAY_NAMES = {
  CCS: 'CLUTCH COMPETITOR SERIES',
  CPL: 'CLUTCH PROSPECT LEAGUE',
  CAS: 'CLUTCH AMATUER SERIES',
  CNL: 'CLUTCH NOVICE LEAGUE',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFeedChannelConfig(league) {
  const envKey = `${league}_RESULT_FEED_CHANNEL`;
  return String(process.env[envKey] || '').trim();
}

async function resolveFeedChannel(guild, league, fallbackChannel) {
  const configured = getFeedChannelConfig(league);
  if (!guild) {
    return fallbackChannel || null;
  }

  await guild.channels.fetch();

  if (configured) {
    const byId = guild.channels.cache.get(configured);
    if (byId && byId.type === ChannelType.GuildText) {
      return byId;
    }

    const normalized = configured.toLowerCase();
    const byName = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildText && String(ch.name || '').toLowerCase() === normalized
    );
    if (byName) {
      return byName;
    }
  }

  const defaultFeedName = `${String(league || '').toLowerCase()}-feed`;
  const byDefaultName = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildText && String(ch.name || '').toLowerCase() === defaultFeedName
  );
  if (byDefaultName) {
    return byDefaultName;
  }

  return fallbackChannel || null;
}

function normalizeWebsiteUrl(match) {
  const fromSheet = String(match?.websiteLink || '').trim();
  const weekRaw = String(match?.week || '').trim();
  const weekNumber = weekRaw.replace(/^week\s*/i, '').trim();

  const appendWeekQuery = (url) => {
    const value = String(url || '').trim();
    if (!value || !weekNumber) {
      return value;
    }

    try {
      const parsed = new URL(value);
      parsed.searchParams.set('week', weekNumber);
      return parsed.toString();
    } catch (_) {
      const hasQuery = value.includes('?');
      const separator = hasQuery ? '&' : '?';
      return `${value}${separator}week=${encodeURIComponent(weekNumber)}`;
    }
  };

  if (fromSheet) {
    return appendWeekQuery(fromSheet);
  }

  const homeTeam = String(match?.homeTeam || '').trim();
  const awayTeam = String(match?.awayTeam || '').trim();
  const homeTeamSlug = slugifyTeamName(homeTeam);
  const awayTeamSlug = slugifyTeamName(awayTeam);
  const league = String(match?.league || '').trim();
  const tier = String(process.env[`LEAGUE_TIER_${league}`] || '').trim();

  const template = String(process.env.WEBSITE_MATCH_URL_TEMPLATE || '').trim();
  if (template) {
    const built = template
      .replaceAll('{match_id}', encodeURIComponent(match.matchId || ''))
      .replaceAll('{league}', encodeURIComponent(league))
      .replaceAll('{week}', encodeURIComponent(weekRaw))
      .replaceAll('{week_number}', encodeURIComponent(weekNumber))
      .replaceAll('{home_team}', encodeURIComponent(homeTeam))
      .replaceAll('{away_team}', encodeURIComponent(awayTeam))
      .replaceAll('{home_team_slug}', encodeURIComponent(homeTeamSlug))
      .replaceAll('{away_team_slug}', encodeURIComponent(awayTeamSlug))
      .replaceAll('{tier}', encodeURIComponent(tier));
    return appendWeekQuery(built);
  }

  const baseUrl = String(process.env.WEBSITE_MATCH_BASE_URL || '').trim();
  if (!baseUrl || !league || !weekNumber || !homeTeamSlug || !awayTeamSlug) {
    return '';
  }

  const core = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(league)}-w${encodeURIComponent(
    weekNumber
  )}-${encodeURIComponent(awayTeamSlug)}-vs-${encodeURIComponent(homeTeamSlug)}`;
  const built = tier ? `${core}?tier=${encodeURIComponent(tier)}` : core;
  return appendWeekQuery(built);
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function isLikelyBallchasingGroupLink(value) {
  return /^https?:\/\/(?:www\.)?ballchasing\.com\/group\/[A-Za-z0-9_-]+(?:[/?].*)?$/i.test(String(value || '').trim());
}

function toRecordText(record) {
  if (!record || !Number.isFinite(record.wins) || !Number.isFinite(record.losses)) {
    return '';
  }
  return `${record.wins}-${record.losses}`;
}

function parseWeekNumber(weekValue) {
  const cleaned = String(weekValue || '')
    .trim()
    .replace(/^week\s*/i, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

async function getMatchesForAutocomplete(league, week) {
  const key = `${String(league).toUpperCase()}|${String(week)}`;
  const now = Date.now();
  const cached = matchAutocompleteCache.get(key);
  if (cached && now - cached.ts < MATCH_AUTOCOMPLETE_CACHE_MS) {
    return cached.matches;
  }

  const matches = await getMatchesByWeekDetailed(league, String(week));
  matchAutocompleteCache.set(key, { ts: now, matches });
  return matches;
}

function getRecordFromStandings(standingsMap, teamName) {
  if (!standingsMap || !teamName) {
    return null;
  }
  const teamKey = normalizeTeamKey(teamName);
  let record = standingsMap.get(teamKey);

  // Fallback: match abbreviated schedule names to full RawStandings names.
  if (!record) {
    const teamTokens = teamKey.split(' ').filter(Boolean);
    let best = null;
    for (const [key, value] of standingsMap.entries()) {
      const keyTokens = String(key || '').split(' ').filter(Boolean);
      const shared = teamTokens.filter((t) => keyTokens.includes(t)).length;
      if (shared === 0) {
        continue;
      }
      const contains = key.includes(teamKey) || teamKey.includes(key);
      const score = shared * 10 + (contains ? 3 : 0);
      if (!best || score > best.score) {
        best = { score, value };
      }
    }
    if (best) {
      record = best.value;
    }
  }

  if (!record) {
    return null;
  }
  return {
    wins: Number(record.wins) || 0,
    losses: Number(record.losses) || 0,
  };
}

function getDisplayRecordsForMatch({ standingsMap, homeTeam, awayTeam, week, fallbackHomeRecord, fallbackAwayRecord, homeWon }) {
  const homeBase = getRecordFromStandings(standingsMap, homeTeam);
  const awayBase = getRecordFromStandings(standingsMap, awayTeam);

  if (!homeBase || !awayBase) {
    return {
      homeRecord: fallbackHomeRecord || '',
      awayRecord: fallbackAwayRecord || '',
      adjusted: false,
    };
  }

  const weekNumber = parseWeekNumber(week);
  const homeGames = homeBase.wins + homeBase.losses;
  const awayGames = awayBase.wins + awayBase.losses;
  const behindStandings = weekNumber > 0 && homeGames < weekNumber && awayGames < weekNumber;

  if (!behindStandings) {
    return {
      homeRecord: toRecordText(homeBase),
      awayRecord: toRecordText(awayBase),
      adjusted: false,
    };
  }

  const homeAdjusted = {
    wins: homeBase.wins + (homeWon ? 1 : 0),
    losses: homeBase.losses + (homeWon ? 0 : 1),
  };
  const awayAdjusted = {
    wins: awayBase.wins + (homeWon ? 0 : 1),
    losses: awayBase.losses + (homeWon ? 1 : 0),
  };

  return {
    homeRecord: toRecordText(homeAdjusted),
    awayRecord: toRecordText(awayAdjusted),
    adjusted: true,
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('post_result')
    .setDescription('Generate and post result feed cards for all matches in a league week')
    .addStringOption((option) =>
      option
        .setName('league')
        .setDescription('League code')
        .setRequired(true)
        .addChoices(
          { name: LEAGUE_OPTION_ALL, value: LEAGUE_OPTION_ALL },
          ...LEAGUES.map((league) => ({ name: league, value: league }))
        )
    )
    .addIntegerOption((option) =>
      option
        .setName('week')
        .setDescription('Week number')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(20)
    )
    .addStringOption((option) =>
      option
        .setName('match_id')
        .setDescription('Optional: post only one match_id for that week')
        .setAutocomplete(true)
        .setRequired(false)
    )
    .setDMPermission(false),

  async handleAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (!focused || focused.name !== 'match_id') {
        await interaction.respond([]);
        return;
      }

      const selectedLeague = interaction.options.getString('league');
      const week = interaction.options.getInteger('week');
      if (!selectedLeague || !week) {
        await interaction.respond([]);
        return;
      }

      const needle = String(focused.value || '').trim().toLowerCase();
      const leaguesToSearch = selectedLeague === LEAGUE_OPTION_ALL ? LEAGUES : [selectedLeague];
      const options = [];

      for (const league of leaguesToSearch) {
        const matches = await getMatchesForAutocomplete(league, week);
        for (const match of matches) {
          const matchId = String(match.matchId || '').trim();
          if (!matchId) {
            continue;
          }
          const label = `${league} | ${matchId} | ${match.awayTeam} vs ${match.homeTeam}`;
          const haystack = `${matchId} ${match.awayTeam} ${match.homeTeam}`.toLowerCase();
          if (needle && !haystack.includes(needle)) {
            continue;
          }
          options.push({
            name: label.slice(0, 100),
            value: matchId,
          });
          if (options.length >= 25) {
            break;
          }
        }
        if (options.length >= 25) {
          break;
        }
      }

      await interaction.respond(options.slice(0, 25));
    } catch (_) {
      await interaction.respond([]).catch(() => {});
    }
  },

  async handleChatInput(interaction) {
    try {
      if (!interaction.guild || !interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
        await interaction.reply({
          content: 'Use this command in a server text channel.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (!isAdminAuthorized(interaction)) {
        await interaction.editReply('You need admin access to use this command.');
        return;
      }

      const selectedLeague = interaction.options.getString('league', true);
      const week = interaction.options.getInteger('week', true);
      const matchIdFilter = String(interaction.options.getString('match_id') || '').trim();
      const leaguesToRun = selectedLeague === LEAGUE_OPTION_ALL ? LEAGUES : [selectedLeague];
      const summaryBlocks = [];

      for (const league of leaguesToRun) {
        let matches = await getMatchesByWeekDetailed(league, String(week));
        if (matchIdFilter) {
          const wanted = matchIdFilter.toLowerCase();
          matches = matches.filter((m) => String(m.matchId || '').toLowerCase() === wanted);
        }
        if (!matches.length) {
          if (!matchIdFilter) {
            summaryBlocks.push(`No RawSchedule matches found for ${league} Week ${week}.`);
          }
          continue;
        }

        const targetChannel = await resolveFeedChannel(
          interaction.guild,
          league,
          selectedLeague === LEAGUE_OPTION_ALL ? null : interaction.channel
        );
        if (!targetChannel) {
          summaryBlocks.push(`Skipped ${league} Week ${week}: feed channel not found (expected #${league.toLowerCase()}-feed or ${league}_RESULT_FEED_CHANNEL).`);
          continue;
        }

        const leagueLogoPath = resolveLeagueLogoPath(league);
        const posted = [];
        const skipped = [];
        const warnings = [];
        let usedInputStatsCount = 0;
        let usedBallchasingFallbackCount = 0;
        let inputStatsRows = { playerRows: [], teamRows: [] };
        let standingsMap = new Map();
        try {
          standingsMap = await getOverallStandingsRecords(league);
        } catch (error) {
          warnings.push(`Could not read ${league} RawStandings overall records: ${error.message}`);
        }
        try {
          inputStatsRows = await getInputStatsRows(league);
        } catch (error) {
          warnings.push(`Could not read ${league} PlayerInput/TeamInput rows: ${error.message}`);
        }

        for (const match of matches) {
          const ballchasingLink = String(match.ballchasingLink || '').trim();
          if (!isLikelyBallchasingGroupLink(ballchasingLink)) {
            skipped.push(`match_id ${match.matchId}: missing/invalid Ballchasing group link`);
            continue;
          }

          let summary = extractMatchStatsFromInputRows(inputStatsRows, match);
          if (!summary) {
            let group;
            try {
              group = await fetchBallchasingGroup(ballchasingLink);
            } catch (error) {
              skipped.push(`match_id ${match.matchId}: Ballchasing fetch failed (${error.message})`);
              continue;
            }
            summary = buildMatchSummary(group.data, match.homeTeam, match.awayTeam);
            warnings.push(`match_id ${match.matchId}: used Ballchasing stats fallback (PlayerInput/TeamInput incomplete).`);
            usedBallchasingFallbackCount += 1;
          } else {
            usedInputStatsCount += 1;
          }

          const homeWins = Number(summary.homeWins || 0);
          const awayWins = Number(summary.awayWins || 0);
          const homeWon = homeWins >= awayWins;
          const displayRecords = getDisplayRecordsForMatch({
            standingsMap,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            week: match.week || String(week),
            fallbackHomeRecord: match.homeRecord,
            fallbackAwayRecord: match.awayRecord,
            homeWon,
          });

          const winnerTeam = homeWon ? match.homeTeam : match.awayTeam;
          const loserTeam = homeWon ? match.awayTeam : match.homeTeam;
          const winnerWins = homeWon ? homeWins : awayWins;
          const loserWins = homeWon ? awayWins : homeWins;
          const winnerRecord = homeWon ? displayRecords.homeRecord : displayRecords.awayRecord;
          const loserRecord = homeWon ? displayRecords.awayRecord : displayRecords.homeRecord;

          let homeLogoPath;
          let awayLogoPath;
          try {
            homeLogoPath = resolveTeamLogoPath(league, match.homeTeam);
            awayLogoPath = resolveTeamLogoPath(league, match.awayTeam);
          } catch (error) {
            skipped.push(`match_id ${match.matchId}: logo resolution failed (${error.message})`);
            continue;
          }

          let resultPng;
          let mvpPng;
          try {
            const winnerLogoPath = homeWon ? homeLogoPath : awayLogoPath;
            const loserLogoPath = homeWon ? awayLogoPath : homeLogoPath;
            const winnerColor = resolveTeamColor(winnerTeam) || '#e5e7eb';
            resultPng = await renderResultCard({
              league,
              leagueLabel: LEAGUE_DISPLAY_NAMES[league] || league,
              week: match.week,
              // Template places away on left and home on right; map winner -> left.
              homeTeam: loserTeam,
              awayTeam: winnerTeam,
              homeWins: loserWins,
              awayWins: winnerWins,
              homeRecord: loserRecord,
              awayRecord: winnerRecord,
              homeLogoPath: loserLogoPath,
              awayLogoPath: winnerLogoPath,
              resultAccentColor: winnerColor,
              leagueLogoPath,
            });

            mvpPng = await renderMvpCard({
              league,
              mvpName: summary.mvp.name,
              mvpLine1: `${summary.mvp.goals} Goals, ${summary.mvp.assists} Assists, ${summary.mvp.saves} Saves`,
              mvpLine2: `and ${summary.mvp.shots} Shots!`,
              mvpScore: summary.mvp.score,
              mvpAccentColor: resolveTeamColor(summary.mvp.teamName) || '#e5e7eb',
              mvpLeftAccentColor: winnerColor,
              leagueLogoPath,
            });
          } catch (error) {
            skipped.push(`match_id ${match.matchId}: card rendering failed (${error.message})`);
            continue;
          }

          const websiteUrl = normalizeWebsiteUrl({ ...match, league });
          const messageContent = `${winnerTeam} vs ${loserTeam} Week ${match.week} Result`;
          await targetChannel.send({
            content: messageContent,
            files: [new AttachmentBuilder(resultPng, { name: `${league}-${match.matchId}-result.png` })],
          });
          await sleep(POST_GAP_MS);

          if (websiteUrl && isValidHttpUrl(websiteUrl)) {
            const weekText = String(match.week || '').replace(/^week\s*/i, '').trim() || String(week);
            const linkLabel = `${match.homeTeam} VS ${match.awayTeam} Week ${weekText} Website Link`.slice(0, 80);
            await targetChannel.send({
              files: [new AttachmentBuilder(mvpPng, { name: `${league}-${match.matchId}-mvp.png` })],
              components: [
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(linkLabel).setURL(websiteUrl)
                ),
              ],
            });
          } else {
            await targetChannel.send({
              files: [new AttachmentBuilder(mvpPng, { name: `${league}-${match.matchId}-mvp.png` })],
            });
          }
          await sleep(POST_GAP_MS);

          if (summary.matchedTeams && (!summary.matchedTeams.home || !summary.matchedTeams.away)) {
            warnings.push(`match_id ${match.matchId}: Ballchasing team-name matching was partial.`);
          }
          if (displayRecords.adjusted) {
            warnings.push(`match_id ${match.matchId}: display record was adjusted from standings based on Ballchasing result.`);
          }

          posted.push(match.matchId);
        }

        const lines = [
          `Week feed finished for ${league} Week ${week} in #${targetChannel.name}.`,
          `Renderer: ${ACTIVE_RENDER_BACKEND}`,
          `Stats source: input=${usedInputStatsCount}, ballchasing_fallback=${usedBallchasingFallbackCount}`,
          `Posted: ${posted.length}`,
          `Skipped: ${skipped.length}`,
        ];
        if (skipped.length) {
          lines.push(`Skipped details:\n- ${skipped.join('\n- ')}`);
        }
        if (warnings.length) {
          lines.push(`Warnings:\n- ${warnings.join('\n- ')}`);
        }
        summaryBlocks.push(lines.join('\n'));
      }

      if (!summaryBlocks.length && matchIdFilter) {
        await interaction.editReply(`No match found for match_id "${matchIdFilter}" in week ${week}.`);
        return;
      }

      await interaction.editReply(summaryBlocks.join('\n\n'));
    } catch (error) {
      const message = `post_result failed: ${error?.message || 'Unknown error'}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message).catch(() => {});
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  },
};

