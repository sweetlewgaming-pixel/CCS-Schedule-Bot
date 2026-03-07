const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  StringSelectMenuBuilder,
  SlashCommandBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const { isAdminAuthorized } = require('../utils/permissions');
const {
  getMatchesByWeekDetailed,
  getOverallStandingsRecords,
  normalizeTeamKey,
  teamsLikelyMatch,
  getInputStatsRows,
  extractMatchStatsFromInputRows,
} = require('../services/googleSheets');
const { resolveLeagueLogoPath, resolveTeamLogoPath } = require('../services/logoResolver');
const { renderResultCard, renderMvpCard } = require('../services/resultCardRenderer');
const { resolveTeamColor } = require('../services/teamColors');
const { slugifyTeamName } = require('../utils/slugify');

const LEAGUES = ['CCS', 'CPL', 'CAS', 'CNL'];
const LEAGUE_OPTION_ALL = 'ALL';
const POST_GAP_MS = 3200;
const PREVIEW_POST_GAP_MS = 1200;
const ACTIVE_RENDER_BACKEND = String(process.env.RENDER_BACKEND || 'html').trim().toLowerCase();
const MATCH_AUTOCOMPLETE_CACHE_MS = 30_000;
const matchAutocompleteCache = new Map();
const PREVIEW_SESSION_TTL_MS = 1000 * 60 * 60 * 6;
const PREVIEW_TOKEN_LENGTH = 10;
const PREVIEW_BUTTON_PREFIX = 'post_result_preview_btn';
const PREVIEW_SELECT_PREFIX = 'post_result_preview_mvp';
const PREVIEW_CHANNEL_NAME = 'feed-preview';
const PREVIEW_CHANNEL_ENV = 'RESULT_FEED_PREVIEW_CHANNEL';
const previewSessions = new Map();
const PREVIEW_STATE_PATH = path.join(__dirname, '..', 'data', 'post-result-preview-sessions.json');
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

function getPreviewChannelConfig() {
  return String(process.env[PREVIEW_CHANNEL_ENV] || '').trim();
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

async function resolvePreviewChannel(guild, fallbackChannel) {
  if (!guild) {
    return fallbackChannel || null;
  }

  await guild.channels.fetch();
  const configured = getPreviewChannelConfig();
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

  const byDefaultName = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildText && String(ch.name || '').toLowerCase() === PREVIEW_CHANNEL_NAME
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

function cleanWeekValue(weekValue) {
  return String(weekValue || '')
    .trim()
    .toLowerCase()
    .replace(/^week\s*/i, '');
}

function dedupeLatestByKey(rows, keyFn) {
  const out = [];
  const seen = new Set();
  const ordered = [...rows].sort((a, b) => Number(b?._rowIndex || 0) - Number(a?._rowIndex || 0));
  for (const row of ordered) {
    const key = keyFn(row);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(row);
  }
  return out;
}

function toMvpCandidate(raw) {
  return {
    id: String(raw.id || '').trim(),
    name: String(raw.name || 'TBD').trim() || 'TBD',
    teamName: String(raw.teamName || '').trim(),
    goals: Number(raw.goals || 0) || 0,
    assists: Number(raw.assists || 0) || 0,
    saves: Number(raw.saves || 0) || 0,
    shots: Number(raw.shots || 0) || 0,
    score: Number(raw.score || 0) || 0,
  };
}

function buildMvpCandidatesFromInputRows(inputRows, match) {
  const weekKey = cleanWeekValue(match?.week || '');
  const homeTeam = String(match?.homeTeam || '').trim();
  const awayTeam = String(match?.awayTeam || '').trim();
  const playerRows = Array.isArray(inputRows?.playerRows) ? inputRows.playerRows : [];
  const scopedRows = playerRows.filter((row) => {
    const teamName = String(row.team_name || '').trim();
    if (!teamName) {
      return false;
    }
    if (cleanWeekValue(row.week) !== weekKey) {
      return false;
    }
    return teamsLikelyMatch(teamName, homeTeam) || teamsLikelyMatch(teamName, awayTeam);
  });
  const latestRows = dedupeLatestByKey(scopedRows, (row) => {
    return `${normalizeTeamKey(row.team_name)}|${String(row.player_name || '').trim().toLowerCase()}`;
  });
  return latestRows
    .map((row) =>
      toMvpCandidate({
        id: `input:${normalizeTeamKey(row.team_name)}:${String(row.player_name || '').trim().toLowerCase()}`,
        name: row.player_name,
        teamName: row.team_name,
        goals: row.goals,
        assists: row.assists,
        saves: row.saves,
        shots: row.shots,
        score: row.score,
      })
    )
    .sort((a, b) => b.score - a.score);
}

function ensurePreviewStateDir() {
  fs.mkdirSync(path.dirname(PREVIEW_STATE_PATH), { recursive: true });
}

function serializePreviewSession(session) {
  return {
    ...session,
    previews: Array.isArray(session?.previews)
      ? session.previews.map((preview) => ({
          ...preview,
          resultPng: Buffer.isBuffer(preview?.resultPng) ? preview.resultPng.toString('base64') : '',
          mvpPng: Buffer.isBuffer(preview?.mvpPng) ? preview.mvpPng.toString('base64') : '',
        }))
      : [],
  };
}

function deserializePreviewSession(session) {
  return {
    ...session,
    previews: Array.isArray(session?.previews)
      ? session.previews.map((preview) => ({
          ...preview,
          resultPng: preview?.resultPng ? Buffer.from(String(preview.resultPng), 'base64') : Buffer.alloc(0),
          mvpPng: preview?.mvpPng ? Buffer.from(String(preview.mvpPng), 'base64') : Buffer.alloc(0),
        }))
      : [],
  };
}

function savePreviewSessions() {
  ensurePreviewStateDir();
  const payload = {};
  for (const [token, session] of previewSessions.entries()) {
    payload[token] = serializePreviewSession(session);
  }
  fs.writeFileSync(PREVIEW_STATE_PATH, JSON.stringify(payload, null, 2));
}

function loadPreviewSessions() {
  try {
    ensurePreviewStateDir();
    if (!fs.existsSync(PREVIEW_STATE_PATH)) {
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(PREVIEW_STATE_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return;
    }
    for (const [token, session] of Object.entries(parsed)) {
      previewSessions.set(token, deserializePreviewSession(session));
    }
  } catch (_) {
    // Ignore malformed state and continue with empty in-memory sessions.
  }
}

function createSessionToken() {
  return Math.random().toString(36).slice(2, 2 + PREVIEW_TOKEN_LENGTH);
}

function cleanupPreviewSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, session] of previewSessions.entries()) {
    if (now - Number(session?.createdAt || 0) > PREVIEW_SESSION_TTL_MS) {
      previewSessions.delete(token);
      changed = true;
    }
  }
  if (changed) {
    savePreviewSessions();
  }
}

function createPreviewSession(payload) {
  cleanupPreviewSessions();
  const token = createSessionToken();
  previewSessions.set(token, {
    ...payload,
    createdAt: Date.now(),
  });
  savePreviewSessions();
  return token;
}

function getPreviewSession(token) {
  cleanupPreviewSessions();
  return previewSessions.get(token) || null;
}

function parsePreviewButtonId(customId) {
  const parts = String(customId || '').split(':');
  if (parts.length !== 4 || parts[0] !== PREVIEW_BUTTON_PREFIX) {
    return null;
  }
  const index = Number(parts[3]);
  if (!Number.isInteger(index) || index < 0) {
    return null;
  }
  return {
    action: parts[1],
    token: parts[2],
    index,
  };
}

function parsePreviewSelectId(customId) {
  const parts = String(customId || '').split(':');
  if (parts.length !== 3 || parts[0] !== PREVIEW_SELECT_PREFIX) {
    return null;
  }
  const index = Number(parts[2]);
  if (!Number.isInteger(index) || index < 0) {
    return null;
  }
  return {
    token: parts[1],
    index,
  };
}

function buildPreviewControls(token, preview, index, editing = false) {
  const rows = [];
  if (preview.websiteUrl && isValidHttpUrl(preview.websiteUrl)) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(preview.linkLabel).setURL(preview.websiteUrl)
      )
    );
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREVIEW_BUTTON_PREFIX}:confirm:${token}:${index}`)
        .setLabel('Confirm')
        .setStyle(ButtonStyle.Success)
        .setDisabled(Boolean(preview.confirmed)),
      new ButtonBuilder()
        .setCustomId(`${PREVIEW_BUTTON_PREFIX}:edit:${token}:${index}`)
        .setLabel('Edit MVP')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(Boolean(preview.confirmed))
    )
  );

  if (editing && !preview.confirmed) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${PREVIEW_SELECT_PREFIX}:${token}:${index}`)
      .setPlaceholder('Select MVP player')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        preview.mvpCandidates.slice(0, 25).map((candidate) => ({
          label: `${candidate.name} (${candidate.teamName || 'Unknown Team'})`.slice(0, 100),
          description: `Score ${candidate.score} | G ${candidate.goals} A ${candidate.assists} S ${candidate.saves}`.slice(0, 100),
          value: candidate.id,
          default: candidate.id === preview.selectedMvpId,
        }))
      );
    rows.push(new ActionRowBuilder().addComponents(menu));
  }

  return rows;
}

function findCandidateById(preview, candidateId) {
  const found = (preview.mvpCandidates || []).find((candidate) => candidate.id === candidateId);
  if (found) {
    return found;
  }
  return (preview.mvpCandidates || [])[0] || null;
}

function pickDefaultMvpId(candidates, mvp) {
  const targetName = String(mvp?.name || '').trim().toLowerCase();
  const targetTeam = normalizeTeamKey(mvp?.teamName || '');
  const matched = candidates.find((candidate) => {
    const sameName = String(candidate.name || '').trim().toLowerCase() === targetName;
    if (!sameName) {
      return false;
    }
    if (!targetTeam) {
      return true;
    }
    return normalizeTeamKey(candidate.teamName) === targetTeam;
  });
  return String(matched?.id || candidates?.[0]?.id || '');
}

function buildMvpLine1(candidate) {
  return `${candidate.goals} Goals, ${candidate.assists} Assists, ${candidate.saves} Saves`;
}

function buildMvpLine2(candidate) {
  return `and ${candidate.shots} Shots!`;
}

function buildPreviewControlContent(preview) {
  const selected = findCandidateById(preview, preview.selectedMvpId);
  const mvpText = selected ? `${selected.name} (${selected.teamName || 'Unknown Team'})` : 'TBD';
  const base = `[PREVIEW] ${preview.league} match_id ${preview.matchId}\nTarget: <#${preview.targetChannelId}>\nCurrent MVP: ${mvpText}`;
  if (preview.confirmed) {
    return `${base}\nStatus: Confirmed and posted.`;
  }
  return `${base}\nUse Edit MVP to change before confirming.`;
}

async function sendLongEphemeralReply(interaction, text) {
  const MAX_LEN = 1900;
  const value = String(text || '');
  if (value.length <= MAX_LEN) {
    await interaction.editReply(value);
    return;
  }

  const chunks = [];
  let remaining = value;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < 1) {
      splitAt = MAX_LEN;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }

  await interaction.editReply(chunks[0]);
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({
      content: chunk,
      flags: MessageFlags.Ephemeral,
    });
  }
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

loadPreviewSessions();

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
      const previewChannel = await resolvePreviewChannel(interaction.guild, null);
      if (!previewChannel) {
        await interaction.editReply(
          `Preview channel not found. Create #${PREVIEW_CHANNEL_NAME} or set ${PREVIEW_CHANNEL_ENV} in .env.`
        );
        return;
      }

      const previewSessionToken = createPreviewSession({
        ownerId: interaction.user.id,
        previews: [],
      });
      const previewSession = getPreviewSession(previewSessionToken);
      if (!previewSession) {
        await interaction.editReply('Could not create preview session. Try again.');
        return;
      }

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
          summaryBlocks.push(
            `Skipped ${league} Week ${week}: final feed channel not found (expected #${league.toLowerCase()}-feed or ${league}_RESULT_FEED_CHANNEL).`
          );
          continue;
        }

        const leagueLogoPath = resolveLeagueLogoPath(league);
        const previewed = [];
        const skipped = [];
        const warnings = [];
        let usedInputStatsCount = 0;
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
          let summary = extractMatchStatsFromInputRows(inputStatsRows, match);
          if (!summary) {
            skipped.push(`match_id ${match.matchId}: missing sheet stats in PlayerInput/TeamInput`);
            continue;
          }
          usedInputStatsCount += 1;

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
          const winnerLogoPath = homeWon ? homeLogoPath : awayLogoPath;
          const loserLogoPath = homeWon ? awayLogoPath : homeLogoPath;
          const winnerColor = resolveTeamColor(winnerTeam) || '#e5e7eb';
          let mvpCandidates = buildMvpCandidatesFromInputRows(inputStatsRows, match);
          if (!mvpCandidates.length) {
            mvpCandidates = [
              toMvpCandidate({
                id: `summary:${league}:${match.matchId}`,
                name: summary?.mvp?.name,
                teamName: summary?.mvp?.teamName,
                goals: summary?.mvp?.goals,
                assists: summary?.mvp?.assists,
                saves: summary?.mvp?.saves,
                shots: summary?.mvp?.shots,
                score: summary?.mvp?.score,
              }),
            ];
          }
          const uniqueCandidates = [];
          const seenCandidates = new Set();
          for (const candidate of mvpCandidates) {
            const key = `${normalizeTeamKey(candidate.teamName)}|${candidate.name.toLowerCase()}`;
            if (seenCandidates.has(key)) {
              continue;
            }
            seenCandidates.add(key);
            uniqueCandidates.push(candidate);
          }
          uniqueCandidates.sort((a, b) => b.score - a.score);
          const selectedMvpId = pickDefaultMvpId(uniqueCandidates, summary?.mvp);
          const selectedMvp = uniqueCandidates.find((candidate) => candidate.id === selectedMvpId) || uniqueCandidates[0];

          try {
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
              mvpName: selectedMvp.name,
              mvpLine1: buildMvpLine1(selectedMvp),
              mvpLine2: buildMvpLine2(selectedMvp),
              mvpScore: selectedMvp.score,
              mvpAccentColor: resolveTeamColor(selectedMvp.teamName) || '#e5e7eb',
              mvpLeftAccentColor: winnerColor,
              leagueLogoPath,
            });
          } catch (error) {
            skipped.push(`match_id ${match.matchId}: card rendering failed (${error.message})`);
            continue;
          }

          const websiteUrl = normalizeWebsiteUrl({ ...match, league });
          const messageContent = `${winnerTeam} vs ${loserTeam} Week ${match.week} Result`;
          const weekText = String(match.week || '').replace(/^week\s*/i, '').trim() || String(week);
          const linkLabel = `${match.homeTeam} VS ${match.awayTeam} Week ${weekText} Website Link`.slice(0, 80);
          const previewIndex = previewSession.previews.length;
          const previewEntry = {
            league,
            week,
            matchId: match.matchId,
            matchWeek: match.week,
            messageContent,
            linkLabel,
            websiteUrl,
            targetChannelId: targetChannel.id,
            winnerColor,
            leagueLogoPath,
            mvpCandidates: uniqueCandidates,
            selectedMvpId,
            resultPng,
            mvpPng,
            confirmed: false,
            resultMessageId: '',
            controlMessageId: '',
          };
          previewSession.previews.push(previewEntry);
          savePreviewSessions();

          let resultMessage;
          let controlMessage;
          try {
            resultMessage = await previewChannel.send({
              content: `[PREVIEW] ${messageContent}\nTarget: <#${targetChannel.id}>`,
              files: [new AttachmentBuilder(resultPng, { name: `${league}-${match.matchId}-result.png` })],
            });
            controlMessage = await previewChannel.send({
              content: buildPreviewControlContent(previewEntry),
              files: [new AttachmentBuilder(mvpPng, { name: `${league}-${match.matchId}-mvp.png` })],
              components: buildPreviewControls(previewSessionToken, previewEntry, previewIndex, false),
            });
          } catch (error) {
            previewSession.previews.pop();
            savePreviewSessions();
            skipped.push(`match_id ${match.matchId}: preview post failed (${error.message})`);
            continue;
          }
          previewEntry.resultMessageId = resultMessage.id;
          previewEntry.controlMessageId = controlMessage.id;
          savePreviewSessions();
          await sleep(PREVIEW_POST_GAP_MS);

          if (displayRecords.adjusted) {
            warnings.push(`match_id ${match.matchId}: display record was adjusted from standings based on sheet result.`);
          }

          previewed.push(match.matchId);
        }

        const lines = [
          `Week preview finished for ${league} Week ${week} in #${previewChannel.name} (target #${targetChannel.name}).`,
          `Renderer: ${ACTIVE_RENDER_BACKEND}`,
          `Stats source: input=${usedInputStatsCount}`,
          `Previewed: ${previewed.length}`,
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

      await sendLongEphemeralReply(
        interaction,
        `${summaryBlocks.join('\n\n')}\n\nPreview session token: \`${previewSessionToken}\`\nUse the buttons in #${previewChannel.name} to edit MVP and confirm each post.`
      );
    } catch (error) {
      const message = `post_result failed: ${error?.message || 'Unknown error'}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message).catch(() => {});
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  },

  async handleButtonInteraction(interaction) {
    const parsed = parsePreviewButtonId(interaction.customId);
    if (!parsed) {
      return;
    }

    if (!isAdminAuthorized(interaction)) {
      await interaction.reply({
        content: 'You need admin access to use this action.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const session = getPreviewSession(parsed.token);
    if (!session) {
      await interaction.reply({
        content: 'This preview session expired. Run /post_result again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (session.ownerId !== interaction.user.id) {
      await interaction.reply({
        content: 'Only the admin who started this preview run can confirm or edit it.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const preview = session.previews?.[parsed.index];
    if (!preview) {
      await interaction.reply({
        content: 'This preview item no longer exists.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (parsed.action === 'edit') {
      if (preview.confirmed) {
        await interaction.reply({
          content: 'This match is already confirmed and posted.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.update({
        content: buildPreviewControlContent(preview),
        components: buildPreviewControls(parsed.token, preview, parsed.index, true),
      });
      return;
    }

    if (parsed.action !== 'confirm') {
      return;
    }

    if (preview.confirmed) {
      await interaction.reply({
        content: 'This match is already confirmed and posted.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const targetChannel = guild?.channels?.cache?.get(preview.targetChannelId) || (await guild?.channels?.fetch(preview.targetChannelId).catch(() => null));
    if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
      await interaction.editReply(`Target channel is missing or invalid for match_id ${preview.matchId}.`);
      return;
    }

    await targetChannel.send({
      content: preview.messageContent,
      files: [new AttachmentBuilder(preview.resultPng, { name: `${preview.league}-${preview.matchId}-result.png` })],
    });
    await sleep(POST_GAP_MS);

    const mvpComponents = [];
    if (preview.websiteUrl && isValidHttpUrl(preview.websiteUrl)) {
      mvpComponents.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(preview.linkLabel).setURL(preview.websiteUrl)
        )
      );
    }
    await targetChannel.send({
      files: [new AttachmentBuilder(preview.mvpPng, { name: `${preview.league}-${preview.matchId}-mvp.png` })],
      components: mvpComponents,
    });
    await sleep(POST_GAP_MS);

    preview.confirmed = true;
    savePreviewSessions();
    await interaction.message.edit({
      content: buildPreviewControlContent(preview),
      components: buildPreviewControls(parsed.token, preview, parsed.index, false),
    });
    await interaction.editReply(`Posted match_id ${preview.matchId} to <#${preview.targetChannelId}>.`);
  },

  async handleSelectMenu(interaction) {
    const parsed = parsePreviewSelectId(interaction.customId);
    if (!parsed) {
      return;
    }

    if (!isAdminAuthorized(interaction)) {
      await interaction.reply({
        content: 'You need admin access to use this action.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const session = getPreviewSession(parsed.token);
    if (!session) {
      await interaction.reply({
        content: 'This preview session expired. Run /post_result again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (session.ownerId !== interaction.user.id) {
      await interaction.reply({
        content: 'Only the admin who started this preview run can edit it.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const preview = session.previews?.[parsed.index];
    if (!preview || preview.confirmed) {
      await interaction.reply({
        content: 'This preview item is no longer editable.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const selectedId = String(interaction.values?.[0] || '').trim();
    const candidate = findCandidateById(preview, selectedId);
    if (!candidate) {
      await interaction.reply({
        content: 'Invalid MVP selection.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    preview.selectedMvpId = candidate.id;
    preview.mvpPng = await renderMvpCard({
      league: preview.league,
      mvpName: candidate.name,
      mvpLine1: buildMvpLine1(candidate),
      mvpLine2: buildMvpLine2(candidate),
      mvpScore: candidate.score,
      mvpAccentColor: resolveTeamColor(candidate.teamName) || '#e5e7eb',
      mvpLeftAccentColor: preview.winnerColor,
      leagueLogoPath: preview.leagueLogoPath,
    });
    savePreviewSessions();

    await interaction.update({
      content: buildPreviewControlContent(preview),
      files: [new AttachmentBuilder(preview.mvpPng, { name: `${preview.league}-${preview.matchId}-mvp.png` })],
      components: buildPreviewControls(parsed.token, preview, parsed.index, false),
    });
  },
};

