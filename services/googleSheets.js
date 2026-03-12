const { google } = require('googleapis');
const { slugifyTeamName } = require('../utils/slugify');

const SPREADSHEET_IDS = {
  CCS: process.env.CCS_SHEET_ID || '1BAFn_0G9yPrXzIRfxrnioBYqmtBByfDpums2nQuNyuw',
  CPL: process.env.CPL_SHEET_ID || '12IkXo6oXoUU7eS53DwbvBRZONbEMr1ZvhB2PLfxWIQs',
  CAS: process.env.CAS_SHEET_ID || '18VCsyi0E713z9ckVIwez8GFvR-Kt3SzC_ryFivMeQW0',
  CNL: process.env.CNL_SHEET_ID || '1k4dd_ZiRNk6R3EN8exAreZiFsijYVGXRYprUZWSjmTA',
};

const SHEET_NAME = 'RawSchedule';
const RAW_STANDINGS_SHEET_NAME = process.env.RAW_STANDINGS_SHEET_NAME || 'RawStandings';
const STATS_SHEET_NAME = process.env.STATS_SHEET_NAME || 'PlayerInput';
const TEAM_STATS_SHEET_NAME = process.env.TEAM_STATS_SHEET_NAME || 'TeamInput';
const STATS_SPREADSHEET_IDS = {
  CCS: process.env.CCS_STATS_SHEET_ID || SPREADSHEET_IDS.CCS,
  CPL: process.env.CPL_STATS_SHEET_ID || SPREADSHEET_IDS.CPL,
  CAS: process.env.CAS_STATS_SHEET_ID || SPREADSHEET_IDS.CAS,
  CNL: process.env.CNL_STATS_SHEET_ID || SPREADSHEET_IDS.CNL,
};
const STATS_HEADER_CACHE_TTL_MS = 5 * 60 * 1000;
const statsHeaderCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGoogleQuotaError(error) {
  const status = Number(error?.code || error?.status || error?.response?.status || 0);
  if (status === 429) {
    return true;
  }

  const rawReason = error?.errors?.[0]?.reason || error?.response?.data?.error?.status || '';
  const reason = String(rawReason || '').toLowerCase();
  if (reason.includes('ratelimit') || reason.includes('quota') || reason.includes('resource_exhausted')) {
    return true;
  }

  const message = String(error?.message || '').toLowerCase();
  return message.includes('quota exceeded') || message.includes('read requests per minute') || message.includes('rate limit');
}

async function sheetsValuesGetWithRetry(sheets, params, options = {}) {
  const maxAttempts = Number(options.maxAttempts || 6);
  const initialDelayMs = Number(options.initialDelayMs || 1500);

  let attempt = 0;
  let delay = initialDelayMs;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await sheets.spreadsheets.values.get(params);
    } catch (error) {
      const retryable = isGoogleQuotaError(error);
      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }
      // Add a small jitter to avoid synchronized retry bursts.
      const jitter = Math.floor(Math.random() * 400);
      await sleep(delay + jitter);
      delay = Math.min(delay * 2, 30000);
    }
  }

  throw new Error('Sheets read failed after retries.');
}

async function sheetsValuesAppendWithRetry(sheets, params, options = {}) {
  const maxAttempts = Number(options.maxAttempts || 6);
  const initialDelayMs = Number(options.initialDelayMs || 1500);

  let attempt = 0;
  let delay = initialDelayMs;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await sheets.spreadsheets.values.append(params);
    } catch (error) {
      const status = Number(error?.code || error?.status || error?.response?.status || 0);
      const retryable = isGoogleQuotaError(error) || status >= 500;
      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }
      const jitter = Math.floor(Math.random() * 400);
      await sleep(delay + jitter);
      delay = Math.min(delay * 2, 30000);
    }
  }

  throw new Error('Sheets append failed after retries.');
}

function getSheetsClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

function normalizeHeader(header) {
  return String(header || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function normalizeTeamKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamsLikelyMatch(a, b) {
  const left = normalizeTeamKey(a);
  const right = normalizeTeamKey(b);
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  return left.includes(right) || right.includes(left);
}

function colNumberToLetter(colNumber) {
  let value = colNumber;
  let result = '';

  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }

  return result;
}

function getStatsSpreadsheetId(league) {
  return STATS_SPREADSHEET_IDS[league];
}

async function getStatsSheetHeaders(sheets, spreadsheetId, sheetName) {
  const cacheKey = `${spreadsheetId}:${sheetName}`;
  const now = Date.now();
  const cached = statsHeaderCache.get(cacheKey);
  if (cached && cached.expiresAt > now && Array.isArray(cached.headers) && cached.headers.length) {
    return cached.headers;
  }

  const headerResponse = await sheetsValuesGetWithRetry(sheets, {
    spreadsheetId,
    range: `${sheetName}!1:1`,
  });
  const headers = headerResponse.data.values?.[0] || [];
  if (!headers.length) {
    throw new Error(`No header row found in ${sheetName}.`);
  }

  statsHeaderCache.set(cacheKey, {
    headers,
    expiresAt: now + STATS_HEADER_CACHE_TTL_MS,
  });
  return headers;
}

function getValueForHeader(row, header) {
  if (row[header] !== undefined && row[header] !== null) {
    return row[header];
  }

  const aliases = {
    avg_distance_to_team_mates_per_game: ['avg_distance_to_teammates_per_game'],
    avg_distance_to_teammates_per_game: ['avg_distance_to_team_mates_per_game'],
    avg_distance_to_ball_has_possession_per_game: ['avg_distance_to_ball_possession_per_game'],
    avg_distance_to_ball_possession_per_game: ['avg_distance_to_ball_has_possession_per_game'],
  };

  for (const alt of aliases[header] || []) {
    if (row[alt] !== undefined && row[alt] !== null) {
      return row[alt];
    }
  }

  return '';
}

async function getRawScheduleRows(league) {
  const spreadsheetId = SPREADSHEET_IDS[league];
  if (!spreadsheetId) {
    throw new Error(`Unsupported league: ${league}`);
  }

  const sheets = getSheetsClient();
  const response = await sheetsValuesGetWithRetry(sheets, {
    spreadsheetId,
    range: `${SHEET_NAME}!A1:Z`,
  });

  const values = response.data.values || [];
  if (values.length === 0) {
    return { headers: [], rows: [], spreadsheetId };
  }

  const headers = values[0].map(normalizeHeader);
  const rows = values.slice(1).map((row, index) => {
    const rowData = {};
    headers.forEach((header, colIdx) => {
      rowData[header] = row[colIdx] || '';
    });

    return {
      rowData,
      rowIndex: index + 2,
    };
  });

  return { headers, rows, spreadsheetId };
}

function cleanWeekValue(weekValue) {
  const text = String(weekValue || '').trim().toLowerCase();
  return text.replace(/^week\s*/i, '');
}

function hasMeaningfulScheduleValue(value) {
  const cleaned = String(value || '').trim().toLowerCase();
  return cleaned !== '' && cleaned !== 'tbd' && cleaned !== 'na' && cleaned !== 'n/a' && cleaned !== '-';
}

function findBallchasingColumnIndex(headers) {
  const preferred = normalizeHeader(process.env.BALLCHASING_COLUMN_HEADER || 'ballchasing_link');
  const candidates = [
    preferred,
    'ballchasing_link',
    'ballchasing_group_id',
    'ballchasing',
    'ballchasing_url',
    'replay_link',
    'replay_url',
  ];

  for (const key of candidates) {
    const idx = headers.indexOf(key);
    if (idx >= 0) {
      return idx + 1;
    }
  }

  return 0;
}

async function getMatchesByWeek(league, week) {
  const { rows } = await getRawScheduleRows(league);
  const targetWeek = cleanWeekValue(week);

  return rows
    .filter(({ rowData }) => cleanWeekValue(rowData.week) === targetWeek)
    .map(({ rowData, rowIndex }) => ({
      matchId: String(rowData.match_id || '').trim(),
      week: String(rowData.week || '').trim(),
      homeTeam: String(rowData.home_team || '').trim(),
      awayTeam: String(rowData.away_team || '').trim(),
      date: String(rowData.date || '').trim(),
      time: String(rowData.time || '').trim(),
      rowIndex,
    }))
    .filter((match) => match.matchId && match.homeTeam && match.awayTeam);
}

function tryParseNumber(value) {
  const n = Number(String(value ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeRowObject(headers, row, rowIndex) {
  const obj = { _rowIndex: rowIndex };
  headers.forEach((header, idx) => {
    obj[header] = row[idx] ?? '';
  });
  return obj;
}

function isLikelyHeaderRepeat(rowObj, requiredHeader) {
  const value = String(rowObj?.[requiredHeader] || '').trim().toLowerCase();
  return value === requiredHeader;
}

async function getOverallStandingsRecords(league) {
  const spreadsheetId = SPREADSHEET_IDS[league];
  if (!spreadsheetId) {
    throw new Error(`Unsupported league: ${league}`);
  }

  const sheets = getSheetsClient();
  const response = await sheetsValuesGetWithRetry(sheets, {
    spreadsheetId,
    range: `${RAW_STANDINGS_SHEET_NAME}!A16:Z27`,
  });

  const values = response.data.values || [];
  if (!values.length) {
    return new Map();
  }

  const records = new Map();
  for (const row of values) {
    if (!Array.isArray(row) || row.every((cell) => String(cell || '').trim() === '')) {
      continue;
    }

    // RawStandings overall block rows 16-27 use stable columns:
    // A=team, E=wins, F=losses.
    const teamName = String(row[0] || row[1] || '').trim();
    let wins = tryParseNumber(row[4]);
    let losses = tryParseNumber(row[5]);

    // Fallback for any variant layout.
    if (wins === null || losses === null) {
      const nums = row.map((cell) => tryParseNumber(cell)).filter((n) => n !== null);
      if (nums.length >= 3) {
        // Usually [matches, wins, losses, ...].
        wins = wins ?? nums[1];
        losses = losses ?? nums[2];
      } else if (nums.length >= 2) {
        wins = wins ?? nums[0];
        losses = losses ?? nums[1];
      }
    }

    if (!teamName || wins === null || losses === null) {
      continue;
    }

    records.set(normalizeTeamKey(teamName), {
      teamName,
      wins,
      losses,
    });
  }

  return records;
}

async function getInputStatsRows(league) {
  const spreadsheetId = getStatsSpreadsheetId(league);
  if (!spreadsheetId) {
    throw new Error(`Stats spreadsheet is not configured for league ${league}.`);
  }

  const sheets = getSheetsClient();
  const [playerRes, teamRes] = await Promise.all([
    sheetsValuesGetWithRetry(sheets, {
      spreadsheetId,
      range: `${STATS_SHEET_NAME}!A1:ZZ`,
    }),
    sheetsValuesGetWithRetry(sheets, {
      spreadsheetId,
      range: `${TEAM_STATS_SHEET_NAME}!A1:ZZ`,
    }),
  ]);

  const playerValues = playerRes.data.values || [];
  const teamValues = teamRes.data.values || [];

  const playerHeaders = (playerValues[0] || []).map(normalizeHeader);
  const teamHeaders = (teamValues[0] || []).map(normalizeHeader);

  const playerRows = playerValues
    .slice(1)
    .map((row, i) => normalizeRowObject(playerHeaders, row, i + 2))
    .filter((row) => !isLikelyHeaderRepeat(row, 'player_name'));

  const teamRows = teamValues
    .slice(1)
    .map((row, i) => normalizeRowObject(teamHeaders, row, i + 2))
    .filter((row) => !isLikelyHeaderRepeat(row, 'team_name'));

  return {
    playerRows,
    teamRows,
  };
}

function dedupeLatestByKey(rows, keyFn) {
  const out = [];
  const seen = new Set();
  const ordered = [...rows].sort((a, b) => Number(b._rowIndex || 0) - Number(a._rowIndex || 0));
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

function extractMatchStatsFromInputRows(inputRows, match) {
  const weekKey = cleanWeekValue(match?.week || '');
  const homeTeam = String(match?.homeTeam || '').trim();
  const awayTeam = String(match?.awayTeam || '').trim();
  const playerRows = Array.isArray(inputRows?.playerRows) ? inputRows.playerRows : [];
  const teamRows = Array.isArray(inputRows?.teamRows) ? inputRows.teamRows : [];

  const scopedPlayerRows = playerRows.filter((row) => {
    const teamName = String(row.team_name || '').trim();
    if (!teamName) {
      return false;
    }
    const sameWeek = cleanWeekValue(row.week) === weekKey;
    if (!sameWeek) {
      return false;
    }
    return teamsLikelyMatch(teamName, homeTeam) || teamsLikelyMatch(teamName, awayTeam);
  });

  const latestPlayerRows = dedupeLatestByKey(scopedPlayerRows, (row) => {
    return `${normalizeTeamKey(row.team_name)}|${String(row.player_name || '').trim().toLowerCase()}`;
  });

  const teamAggregate = new Map();
  for (const row of latestPlayerRows) {
    const key = normalizeTeamKey(row.team_name);
    if (!key) {
      continue;
    }
    if (!teamAggregate.has(key)) {
      teamAggregate.set(key, {
        teamName: String(row.team_name || '').trim(),
        wins: 0,
        players: [],
      });
    }
    const agg = teamAggregate.get(key);
    agg.players.push(row);
    const wins = Number(row.wins || 0);
    if (Number.isFinite(wins) && wins > agg.wins) {
      agg.wins = wins;
    }
  }

  const findTeamAgg = (teamName) => {
    for (const [key, value] of teamAggregate.entries()) {
      if (teamsLikelyMatch(key, teamName) || teamsLikelyMatch(value.teamName, teamName)) {
        return value;
      }
    }
    return null;
  };

  const homeAgg = findTeamAgg(homeTeam);
  const awayAgg = findTeamAgg(awayTeam);

  let homeWins = Number(homeAgg?.wins || 0);
  let awayWins = Number(awayAgg?.wins || 0);

  // TeamInput override when a usable row exists and looks like per-series data.
  const scopedTeamRows = teamRows.filter((row) => {
    const teamName = String(row.team_name || '').trim();
    if (!teamName) {
      return false;
    }
    const hasWeek = String(row.week || '').trim() !== '';
    if (hasWeek && cleanWeekValue(row.week) !== weekKey) {
      return false;
    }
    return teamsLikelyMatch(teamName, homeTeam) || teamsLikelyMatch(teamName, awayTeam);
  });
  const latestTeamRows = dedupeLatestByKey(scopedTeamRows, (row) => normalizeTeamKey(row.team_name));
  for (const row of latestTeamRows) {
    const wins = Number(row.wins || 0);
    const games = Number(row.games || 0);
    if (!Number.isFinite(wins)) {
      continue;
    }
    // Guardrail: ignore season cumulative rows (large games/wins), keep series-like rows only.
    const looksLikeSeriesRow = (Number.isFinite(games) && games > 0 && games <= 7) && wins <= 7;
    if (!looksLikeSeriesRow) {
      continue;
    }
    if (teamsLikelyMatch(row.team_name, homeTeam)) {
      homeWins = wins;
    } else if (teamsLikelyMatch(row.team_name, awayTeam)) {
      awayWins = wins;
    }
  }

  const winningKey = homeWins > awayWins ? normalizeTeamKey(homeTeam) : normalizeTeamKey(awayTeam);
  const winningAgg = [...teamAggregate.entries()].find(([key, value]) => {
    return teamsLikelyMatch(key, winningKey) || teamsLikelyMatch(value.teamName, winningKey);
  })?.[1] || null;

  const mvpPool = (winningAgg?.players || []).length ? winningAgg.players : latestPlayerRows;
  const mvp = [...mvpPool].sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0] || null;

  if (!latestPlayerRows.length || !mvp) {
    return null;
  }

  return {
    source: 'input_sheets',
    homeWins,
    awayWins,
    mvp: {
      name: String(mvp.player_name || 'TBD').trim() || 'TBD',
      teamName: String(mvp.team_name || '').trim(),
      goals: Number(mvp.goals || 0) || 0,
      assists: Number(mvp.assists || 0) || 0,
      saves: Number(mvp.saves || 0) || 0,
      shots: Number(mvp.shots || 0) || 0,
      score: Number(mvp.score || 0) || 0,
    },
  };
}

async function getMatchesByWeekDetailed(league, week) {
  const { rows } = await getRawScheduleRows(league);
  const targetWeek = cleanWeekValue(week);

  return rows
    .filter(({ rowData }) => cleanWeekValue(rowData.week) === targetWeek)
    .map(({ rowData, rowIndex }) => ({
      matchId: String(rowData.match_id || '').trim(),
      week: String(rowData.week || '').trim(),
      homeTeam: String(rowData.home_team || '').trim(),
      awayTeam: String(rowData.away_team || '').trim(),
      date: String(rowData.date || '').trim(),
      time: String(rowData.time || '').trim(),
      ballchasingLink: getBallchasingValueFromRow(rowData),
      websiteLink: getWebsiteValueFromRow(rowData),
      homeRecord: String(rowData.home_record || rowData.home_team_record || '').trim(),
      awayRecord: String(rowData.away_record || rowData.away_team_record || '').trim(),
      rowIndex,
    }))
    .filter((match) => match.matchId && match.homeTeam && match.awayTeam);
}

function getBallchasingValueFromRow(rowData) {
  return String(
    rowData.ballchasing_link ||
      rowData.ballchasing ||
      rowData.ballchasing_url ||
      rowData.replay_link ||
      rowData.replay_url ||
      rowData.ballchasing_group_id ||
      ''
  ).trim();
}

function getWebsiteValueFromRow(rowData) {
  return String(
    rowData.website_link ||
      rowData.website_url ||
      rowData.match_link ||
      rowData.match_url ||
      rowData.stats_link ||
      rowData.stats_url ||
      rowData.recaps_link ||
      rowData.recap_link ||
      ''
  ).trim();
}

async function getMatchById(league, matchId) {
  const { rows } = await getRawScheduleRows(league);
  const target = rows.find(({ rowData }) => String(rowData.match_id || '').trim() === String(matchId || '').trim());
  if (!target) {
    return null;
  }

  const rowData = target.rowData;
  return {
    matchId: String(rowData.match_id || '').trim(),
    week: String(rowData.week || '').trim(),
    homeTeam: String(rowData.home_team || '').trim(),
    awayTeam: String(rowData.away_team || '').trim(),
    date: String(rowData.date || '').trim(),
    time: String(rowData.time || '').trim(),
    ballchasingLink: getBallchasingValueFromRow(rowData),
    websiteLink: getWebsiteValueFromRow(rowData),
    homeRecord: String(rowData.home_record || rowData.home_team_record || '').trim(),
    awayRecord: String(rowData.away_record || rowData.away_team_record || '').trim(),
    rowIndex: target.rowIndex,
  };
}

async function getScheduledMatches(league) {
  const { rows } = await getRawScheduleRows(league);

  return rows
    .map(({ rowData, rowIndex }) => ({
      matchId: String(rowData.match_id || '').trim(),
      week: String(rowData.week || '').trim(),
      homeTeam: String(rowData.home_team || '').trim(),
      awayTeam: String(rowData.away_team || '').trim(),
      date: String(rowData.date || '').trim(),
      time: String(rowData.time || '').trim(),
      ballchasingValue: String(
        getBallchasingValueFromRow(rowData)
      ).trim(),
      rowIndex,
    }))
    .filter(
      (match) =>
        match.matchId &&
        match.homeTeam &&
        match.awayTeam &&
        hasMeaningfulScheduleValue(match.date) &&
        hasMeaningfulScheduleValue(match.time)
    );
}

function cleanChannelNameForMatch(value) {
  return String(value || '')
    .replace(/✅+$/u, '')
    .replace(/confirmed$/i, '')
    .trim();
}

function buildMatchupChannelName(homeTeam, awayTeam, orientation = 'AWAY_AT_HOME') {
  const homeSlug = slugifyTeamName(homeTeam);
  const awaySlug = slugifyTeamName(awayTeam);
  if (orientation === 'HOME_AT_AWAY') {
    return `${homeSlug}-at-${awaySlug}`;
  }
  return `${awaySlug}-at-${homeSlug}`;
}

function parseMatchIdFromChannelTopic(topic) {
  const text = String(topic || '').trim();
  if (!text) {
    return '';
  }

  const match = text.match(/(?:^|\|)match_id=([^|]+)/i);
  if (!match || !match[1]) {
    // Support plain topic format where the topic is the raw match_id.
    if (!text.includes('|')) {
      return text;
    }
    return '';
  }

  try {
    return decodeURIComponent(match[1]).trim();
  } catch (_) {
    return String(match[1]).trim();
  }
}

async function getMatchByChannel(league, channelOrName) {
  const channelName = typeof channelOrName === 'string' ? channelOrName : channelOrName?.name;
  const channelTopic = typeof channelOrName === 'string' ? '' : channelOrName?.topic;
  const targetName = cleanChannelNameForMatch(channelName);
  const { rows } = await getRawScheduleRows(league);

  const topicMatchId = parseMatchIdFromChannelTopic(channelTopic);
  if (topicMatchId) {
    const exact = rows.find(({ rowData }) => String(rowData.match_id || '').trim() === topicMatchId);
    if (exact) {
      return {
        matchId: String(exact.rowData.match_id || '').trim(),
        homeTeam: String(exact.rowData.home_team || '').trim(),
        awayTeam: String(exact.rowData.away_team || '').trim(),
        week: String(exact.rowData.week || '').trim(),
        date: String(exact.rowData.date || '').trim(),
        time: String(exact.rowData.time || '').trim(),
        rowIndex: exact.rowIndex,
      };
    }
  }

  const candidates = rows
    .map(({ rowData, rowIndex }) => {
      const matchId = String(rowData.match_id || '').trim();
      const homeTeam = String(rowData.home_team || '').trim();
      const awayTeam = String(rowData.away_team || '').trim();
      const week = String(rowData.week || '').trim();
      const date = String(rowData.date || '').trim();
      const time = String(rowData.time || '').trim();
      if (!matchId || !homeTeam || !awayTeam) {
        return null;
      }

      const expectedName = buildMatchupChannelName(homeTeam, awayTeam, 'AWAY_AT_HOME');
      if (expectedName !== targetName) {
        return null;
      }

      return {
        matchId,
        homeTeam,
        awayTeam,
        week,
        date,
        time,
        rowIndex,
      };
    })
    .filter(Boolean);

  if (!candidates.length) {
    return null;
  }

  const unscheduled = candidates.find(
    (item) => !hasMeaningfulScheduleValue(item.date) && !hasMeaningfulScheduleValue(item.time)
  );

  return unscheduled || candidates[0];
}

async function updateMatchDateTime(league, matchId, date, time, options = {}) {
  const { headers, rows, spreadsheetId } = await getRawScheduleRows(league);

  const dateColIndex = headers.indexOf('date') + 1;
  const timeColIndex = headers.indexOf('time') + 1;

  if (dateColIndex === 0 || timeColIndex === 0) {
    throw new Error('date/time columns were not found in RawSchedule.');
  }

  const target = rows.find(({ rowData }) => String(rowData.match_id || '').trim() === String(matchId).trim());
  if (!target) {
    throw new Error(`match_id not found: ${matchId}`);
  }

  const existingDate = String(target.rowData.date || '').trim();
  const existingTime = String(target.rowData.time || '').trim();
  const alreadyScheduled = hasMeaningfulScheduleValue(existingDate) && hasMeaningfulScheduleValue(existingTime);

  if (options.preventDuplicate && alreadyScheduled) {
    return {
      duplicate: true,
      existingDate,
      existingTime,
      match: {
        homeTeam: String(target.rowData.home_team || '').trim(),
        awayTeam: String(target.rowData.away_team || '').trim(),
      },
    };
  }

  const sheets = getSheetsClient();
  const rowIndex = target.rowIndex;
  const dateColLetter = colNumberToLetter(dateColIndex);
  const timeColLetter = colNumberToLetter(timeColIndex);

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        {
          range: `${SHEET_NAME}!${dateColLetter}${rowIndex}`,
          values: [[date]],
        },
        {
          range: `${SHEET_NAME}!${timeColLetter}${rowIndex}`,
          values: [[time]],
        },
      ],
    },
  });

  return {
    duplicate: false,
    match: {
      homeTeam: String(target.rowData.home_team || '').trim(),
      awayTeam: String(target.rowData.away_team || '').trim(),
      week: String(target.rowData.week || '').trim(),
      matchId: String(target.rowData.match_id || '').trim(),
    },
  };
}

async function updateMatchBallchasingLink(league, matchId, link, options = {}) {
  const { headers, rows, spreadsheetId } = await getRawScheduleRows(league);
  const linkColIndex = findBallchasingColumnIndex(headers);
  if (linkColIndex === 0) {
    throw new Error(
      'Ballchasing column not found in RawSchedule. Add a header like "ballchasing_link" or set BALLCHASING_COLUMN_HEADER.'
    );
  }

  const target = rows.find(({ rowData }) => String(rowData.match_id || '').trim() === String(matchId).trim());
  if (!target) {
    throw new Error(`match_id not found: ${matchId}`);
  }

  const existingLink = String(
    target.rowData.ballchasing_link ||
      target.rowData.ballchasing ||
      target.rowData.ballchasing_url ||
      target.rowData.replay_link ||
      target.rowData.replay_url ||
      ''
  ).trim();

  if (options.preventDuplicate && hasMeaningfulScheduleValue(existingLink)) {
    return {
      duplicate: true,
      existingLink,
      match: {
        homeTeam: String(target.rowData.home_team || '').trim(),
        awayTeam: String(target.rowData.away_team || '').trim(),
      },
    };
  }

  if (options.dryRun) {
    return {
      duplicate: false,
      match: {
        homeTeam: String(target.rowData.home_team || '').trim(),
        awayTeam: String(target.rowData.away_team || '').trim(),
        week: String(target.rowData.week || '').trim(),
        matchId: String(target.rowData.match_id || '').trim(),
      },
    };
  }

  const sheets = getSheetsClient();
  const rowIndex = target.rowIndex;
  const linkColLetter = colNumberToLetter(linkColIndex);

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        {
          range: `${SHEET_NAME}!${linkColLetter}${rowIndex}`,
          values: [[link]],
        },
      ],
    },
  });

  return {
    duplicate: false,
    match: {
      homeTeam: String(target.rowData.home_team || '').trim(),
      awayTeam: String(target.rowData.away_team || '').trim(),
      week: String(target.rowData.week || '').trim(),
      matchId: String(target.rowData.match_id || '').trim(),
    },
  };
}

async function appendPlayerInputRows(league, playerRows) {
  return appendStatsRows(league, STATS_SHEET_NAME, playerRows, {
    includeHeaderRow: true,
    includeSpacerRow: false,
  });
}

async function appendTeamInputRows(league, teamRows) {
  return appendStatsRows(league, TEAM_STATS_SHEET_NAME, teamRows, {
    includeHeaderRow: true,
    includeSpacerRow: false,
  });
}

async function appendStatsRows(league, sheetName, rowsToAppend, options = {}) {
  const spreadsheetId = getStatsSpreadsheetId(league);
  if (!spreadsheetId) {
    throw new Error(`Stats spreadsheet is not configured for league ${league}.`);
  }

  if (!Array.isArray(rowsToAppend) || rowsToAppend.length === 0) {
    return { insertedRows: 0, insertedPlayers: 0, startRow: 0 };
  }

  const includeHeaderRow = options.includeHeaderRow !== false;
  const includeSpacerRow = options.includeSpacerRow !== false;

  const sheets = getSheetsClient();
  const headers = await getStatsSheetHeaders(sheets, spreadsheetId, sheetName);
  const normalizedHeaders = headers.map(normalizeHeader);
  const values = [];
  if (includeSpacerRow) {
    values.push(['']);
  }
  if (includeHeaderRow) {
    values.push(headers);
  }
  for (const row of rowsToAppend) {
    values.push(
      normalizedHeaders.map((header) => {
        return getValueForHeader(row, header);
      })
    );
  }

  const response = await sheetsValuesAppendWithRetry(sheets, {
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values,
    },
  });

  const updatedRange = String(response.data?.updates?.updatedRange || '');
  const startMatch = updatedRange.match(/![A-Z]+(\d+):/);
  const startRow = startMatch ? Number(startMatch[1]) : 0;

  return {
    insertedRows: rowsToAppend.length,
    insertedPlayers: rowsToAppend.length,
    startRow,
    endRow: startRow > 0 ? startRow + rowsToAppend.length - 1 : 0,
    sheetName,
  };
}

async function updateMatchForfeitResult(league, matchId, winnerCode, options = {}) {
  const normalizedWinner = String(winnerCode || '').trim().toUpperCase();
  if (!['A', 'H'].includes(normalizedWinner)) {
    throw new Error('winnerCode must be "A" (away) or "H" (home).');
  }

  const valueToWrite = `${normalizedWinner} FF`;
  const { headers, rows, spreadsheetId } = await getRawScheduleRows(league);
  const linkColIndex = findBallchasingColumnIndex(headers);
  if (linkColIndex === 0) {
    throw new Error(
      'Ballchasing column not found in RawSchedule. Add a header like "ballchasing_link" or set BALLCHASING_COLUMN_HEADER.'
    );
  }

  const target = rows.find(({ rowData }) => String(rowData.match_id || '').trim() === String(matchId).trim());
  if (!target) {
    throw new Error(`match_id not found: ${matchId}`);
  }

  const existingValue = String(
    target.rowData.ballchasing_link ||
      target.rowData.ballchasing ||
      target.rowData.ballchasing_url ||
      target.rowData.replay_link ||
      target.rowData.replay_url ||
      ''
  ).trim();

  if (options.preventDuplicate && hasMeaningfulScheduleValue(existingValue)) {
    return {
      duplicate: true,
      existingValue,
      match: {
        homeTeam: String(target.rowData.home_team || '').trim(),
        awayTeam: String(target.rowData.away_team || '').trim(),
        week: String(target.rowData.week || '').trim(),
        matchId: String(target.rowData.match_id || '').trim(),
      },
    };
  }

  const sheets = getSheetsClient();
  const rowIndex = target.rowIndex;
  const colLetter = colNumberToLetter(linkColIndex);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        {
          range: `${SHEET_NAME}!${colLetter}${rowIndex}`,
          values: [[valueToWrite]],
        },
      ],
    },
  });

  return {
    duplicate: false,
    valueWritten: valueToWrite,
    match: {
      homeTeam: String(target.rowData.home_team || '').trim(),
      awayTeam: String(target.rowData.away_team || '').trim(),
      week: String(target.rowData.week || '').trim(),
      matchId: String(target.rowData.match_id || '').trim(),
    },
  };
}

module.exports = {
  normalizeTeamKey,
  teamsLikelyMatch,
  getMatchesByWeek,
  getMatchesByWeekDetailed,
  getMatchById,
  getOverallStandingsRecords,
  getInputStatsRows,
  extractMatchStatsFromInputRows,
  getScheduledMatches,
  getMatchByChannel,
  updateMatchDateTime,
  updateMatchBallchasingLink,
  updateMatchForfeitResult,
  appendPlayerInputRows,
  appendTeamInputRows,
};
