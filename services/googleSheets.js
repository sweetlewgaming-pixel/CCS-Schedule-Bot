const { google } = require('googleapis');
const { slugifyTeamName } = require('../utils/slugify');

const SPREADSHEET_IDS = {
  CCS: process.env.CCS_SHEET_ID || '1BAFn_0G9yPrXzIRfxrnioBYqmtBByfDpums2nQuNyuw',
  CPL: process.env.CPL_SHEET_ID || '12IkXo6oXoUU7eS53DwbvBRZONbEMr1ZvhB2PLfxWIQs',
  CAS: process.env.CAS_SHEET_ID || '18VCsyi0E713z9ckVIwez8GFvR-Kt3SzC_ryFivMeQW0',
  CNL: process.env.CNL_SHEET_ID || '1k4dd_ZiRNk6R3EN8exAreZiFsijYVGXRYprUZWSjmTA',
};

const SHEET_NAME = 'RawSchedule';

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

async function getRawScheduleRows(league) {
  const spreadsheetId = SPREADSHEET_IDS[league];
  if (!spreadsheetId) {
    throw new Error(`Unsupported league: ${league}`);
  }

  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
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

function cleanChannelNameForMatch(value) {
  return String(value || '')
    .replace(/✅+$/u, '')
    .replace(/confirmed$/i, '')
    .trim();
}

function buildMatchupChannelCandidates(homeTeam, awayTeam) {
  const homeSlug = slugifyTeamName(homeTeam);
  const awaySlug = slugifyTeamName(awayTeam);
  const awayAtHome = `${awaySlug}-at-${homeSlug}`;
  const homeAtAway = `${homeSlug}-at-${awaySlug}`;
  return new Set([awayAtHome, homeAtAway]);
}

async function getMatchByChannel(league, channelName) {
  const targetName = cleanChannelNameForMatch(channelName);
  const { rows } = await getRawScheduleRows(league);

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

      const names = buildMatchupChannelCandidates(homeTeam, awayTeam);
      if (!names.has(targetName)) {
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
  getMatchesByWeek,
  getMatchByChannel,
  updateMatchDateTime,
  updateMatchBallchasingLink,
  updateMatchForfeitResult,
};
