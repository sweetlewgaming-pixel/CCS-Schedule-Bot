const fs = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');

const { getScheduledMatches } = require('./googleSheets');
const { getRoleIdByTeamName } = require('../utils/teamRoles');
const { CATEGORY_NAMES } = require('./scheduleChannels');
const { slugifyTeamName } = require('../utils/slugify');

const LEAGUES = ['CCS', 'CPL', 'CAS', 'CNL'];
const POLL_INTERVAL_MS = 60 * 1000;
const REMINDER_GRACE_MINUTES = 2;
const STATE_PATH = path.join(__dirname, '..', 'data', 'reminder-state.json');
const REMINDER_TIME_MODE = String(process.env.REMINDER_TIME_MODE || 'PM').trim().toUpperCase();
const DEFAULT_REMINDER_RULES = [
  { type: 'h2', offsetMinutes: 2 * 60 },
  { type: 'start', offsetMinutes: 0 },
];
const REMINDER_MATCH_OVERRIDES_RAW = String(process.env.REMINDER_MATCH_OVERRIDES || '').trim();
const MATCH_CACHE_TTL_MS = Math.max(60 * 1000, Number(process.env.REMINDER_MATCH_CACHE_MS || 3 * 60 * 1000));
const QUOTA_BACKOFF_MS = Math.max(60 * 1000, Number(process.env.REMINDER_QUOTA_BACKOFF_MS || 2 * 60 * 1000));
const QUEUE_REFRESH_MS = Math.max(60 * 1000, Number(process.env.REMINDER_QUEUE_REFRESH_MS || 10 * 60 * 1000));
const leagueMatchCache = new Map();
const leagueQuotaBackoffUntil = new Map();
let reminderQueue = [];
let reminderQueueRefreshAt = 0;

function normalizeMatchId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeOverrideRules(rawOffsets) {
  const parsedOffsets = String(rawOffsets || '')
    .split(',')
    .map((part) => Number(String(part || '').trim()))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.floor(value));

  if (!parsedOffsets.length) {
    return null;
  }

  const uniqueSorted = [...new Set(parsedOffsets)].sort((a, b) => b - a);
  return uniqueSorted.map((offsetMinutes) => ({
    type: offsetMinutes === 0 ? 'start' : `m${offsetMinutes}`,
    offsetMinutes,
  }));
}

function parseMatchReminderOverrides(rawValue) {
  if (!rawValue) {
    return new Map();
  }

  const overrides = new Map();
  const entries = rawValue.split(';');

  for (const entry of entries) {
    const [rawMatchId, rawOffsets] = String(entry || '').split('=');
    const matchId = normalizeMatchId(rawMatchId);
    const rules = normalizeOverrideRules(rawOffsets);
    if (!matchId || !rules) {
      continue;
    }
    overrides.set(matchId, rules);
  }

  return overrides;
}

const MATCH_REMINDER_OVERRIDES = parseMatchReminderOverrides(REMINDER_MATCH_OVERRIDES_RAW);
const MATCH_REMINDER_MESSAGE_OVERRIDES = new Map([
  [
    'ccs-w5-shockwave-vs-stars',
    {
      h12: 'Reminder: welp, you idiots decided this was a good idea. Match time is tomorrow at {time}.',
      m30: "Reminder: wakey wakey...don't be that guy that sleeps in and misses your match. Game time is {time}.",
    },
  ],
]);

function ensureStateDir() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
}

function loadState() {
  try {
    ensureStateDir();
    if (!fs.existsSync(STATE_PATH)) {
      return { posted: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.posted !== 'object') {
      return { posted: {} };
    }
    return parsed;
  } catch (_) {
    return { posted: {} };
  }
}

function saveState(state) {
  ensureStateDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function getNowInEastern() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });

  const parts = fmt.formatToParts(new Date());
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = Number(part.value);
    }
  }

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour === 24 ? 0 : values.hour,
    minute: values.minute,
  };
}

function parseDateAndTimeEST(dateText, timeText) {
  const dateMatch = String(dateText || '').trim().match(/^([1-9]|1[0-2])\/([1-9]|[12][0-9]|3[01])$/);
  if (!dateMatch) {
    return null;
  }

  const timeMatch = String(timeText || '').trim().match(/^(1[0-2]|[1-9])(?::([0-5][0-9]))?\s*(am|pm)?$/i);
  if (!timeMatch) {
    return null;
  }

  const month = Number(dateMatch[1]);
  const day = Number(dateMatch[2]);
  const hour12 = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] || 0);
  const meridiem = String(timeMatch[3] || REMINDER_TIME_MODE).trim().toUpperCase();
  const hour24 =
    meridiem === 'AM'
      ? hour12 === 12
        ? 0
        : hour12
      : hour12 === 12
        ? 12
        : hour12 + 12; // Default PM mode

  return {
    month,
    day,
    hour: hour24,
    minute,
  };
}

function formatTimePmEst(timeText) {
  const parsed = parseDateAndTimeEST('1/1', timeText);
  if (!parsed) {
    return `${String(timeText || '').trim()} EST`;
  }

  const hour12 = parsed.hour === 0 ? 12 : parsed.hour > 12 ? parsed.hour - 12 : parsed.hour;
  const mm = String(parsed.minute).padStart(2, '0');
  const meridiem = parsed.hour >= 12 ? 'PM' : 'AM';
  return `${hour12}:${mm} ${meridiem} EST`;
}

function buildReminderKey(year, league, match, reminderType) {
  const normalizedTime = String(match.time || '').trim();
  const normalizedDate = String(match.date || '').trim();
  return `${year}|${league}|${match.matchId}|${normalizedDate}|${normalizedTime}|${reminderType}`;
}

function toDayIndex(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function minutesFromEstParts(parts) {
  return toDayIndex(parts.year, parts.month, parts.day) * 1440 + parts.hour * 60 + parts.minute;
}

function minutesForMatchInCurrentYear(nowParts, parsedMatchTime) {
  return toDayIndex(nowParts.year, parsedMatchTime.month, parsedMatchTime.day) * 1440 +
    parsedMatchTime.hour * 60 +
    parsedMatchTime.minute;
}

function hasMatchBeenPlayed(match) {
  const value = String(match.ballchasingValue || '').trim().toLowerCase();
  if (!value) {
    return false;
  }

  return !['tbd', 'na', 'n/a', '-'].includes(value);
}

async function mentionForTeam(guild, teamName) {
  const roleId = await getRoleIdByTeamName(guild, teamName);
  return {
    roleId,
    mention: roleId ? `<@&${roleId}>` : `@${teamName}`,
  };
}

function getReminderRulesForMatch(match) {
  const matchIdKey = normalizeMatchId(match.matchId);
  return MATCH_REMINDER_OVERRIDES.get(matchIdKey) || DEFAULT_REMINDER_RULES;
}

function formatReminderMessageTemplate(template, formattedTime) {
  return String(template || '').replace(/\{time\}/gi, formattedTime);
}

function getMatchReminderMessageOverride(match, reminderType, formattedTime) {
  const matchIdKey = normalizeMatchId(match.matchId);
  const override = MATCH_REMINDER_MESSAGE_OVERRIDES.get(matchIdKey);
  if (!override) {
    return '';
  }
  const template = String(override[reminderType] || '').trim();
  if (!template) {
    return '';
  }
  return formatReminderMessageTemplate(template, formattedTime);
}

async function getUploadCommandMention(guild) {
  try {
    if (guild?.commands?.fetch) {
      const guildCommands = await guild.commands.fetch();
      const guildCommand = guildCommands.find((command) => command.name === 'upload');
      if (guildCommand) {
        return `</upload:${guildCommand.id}>`;
      }
    }

    if (guild?.client?.application?.commands?.fetch) {
      const globalCommands = await guild.client.application.commands.fetch();
      const globalCommand = globalCommands.find((command) => command.name === 'upload');
      if (globalCommand) {
        return `</upload:${globalCommand.id}>`;
      }
    }
  } catch (_) {
    // Fall through to plain command text.
  }

  return '`/upload`';
}

async function findMatchChannelByMatchId(guild, league, matchId) {
  const categoryName = String(CATEGORY_NAMES[league] || '').trim().toLowerCase();
  if (!categoryName) {
    return null;
  }

  return (
    guild.channels.cache.find((channel) => {
      if (channel.type !== ChannelType.GuildText) {
        return false;
      }

      const parent = channel.parent;
      const parentName = String(parent?.name || '').trim().toLowerCase();
      if (parentName !== categoryName) {
        return false;
      }

      const topic = String(channel.topic || '').trim();
      if (!topic) {
        return false;
      }

      if (topic === matchId) {
        return true;
      }

      const topicMatch = topic.match(/(?:^|\|)match_id=([^|]+)/i);
      if (!topicMatch || !topicMatch[1]) {
        return false;
      }

      try {
        return decodeURIComponent(topicMatch[1]).trim() === matchId;
      } catch (_) {
        return String(topicMatch[1]).trim() === matchId;
      }
    }) || null
  );
}

function buildMatchupChannelCandidates(homeTeam, awayTeam) {
  const awayAtHome = `${slugifyTeamName(awayTeam)}-at-${slugifyTeamName(homeTeam)}`;
  const homeAtAway = `${slugifyTeamName(homeTeam)}-at-${slugifyTeamName(awayTeam)}`;
  return new Set([awayAtHome, homeAtAway]);
}

function normalizeMatchupChannelName(name) {
  return String(name || '')
    .trim()
    .replace(/[\u2705]+$/u, '')
    .replace(/âœ…+$/u, '')
    .replace(/confirmed$/i, '')
    .trim();
}

async function findMatchChannelByTeams(guild, league, homeTeam, awayTeam) {
  const categoryName = String(CATEGORY_NAMES[league] || '').trim().toLowerCase();
  if (!categoryName) {
    return null;
  }

  const candidates = buildMatchupChannelCandidates(homeTeam, awayTeam);
  return (
    guild.channels.cache.find((channel) => {
      if (channel.type !== ChannelType.GuildText) {
        return false;
      }
      const parentName = String(channel.parent?.name || '').trim().toLowerCase();
      const normalizedChannelName = normalizeMatchupChannelName(channel.name);
      return parentName === categoryName && candidates.has(normalizedChannelName);
    }) || null
  );
}

function isQuotaLikeError(error) {
  const status = Number(error?.code || error?.status || error?.response?.status || 0);
  const message = String(error?.message || '').toLowerCase();
  return (
    status === 429 ||
    message.includes('quota exceeded') ||
    message.includes('read requests per minute') ||
    message.includes('rate limit')
  );
}

function getCachedMatchesForLeague(league) {
  const cached = leagueMatchCache.get(league);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    leagueMatchCache.delete(league);
    return null;
  }
  return cached.matches;
}

async function fetchMatchesByLeague() {
  const matchesByLeague = new Map();
  for (const league of LEAGUES) {
    const backoffUntil = Number(leagueQuotaBackoffUntil.get(league) || 0);
    if (backoffUntil > Date.now()) {
      matchesByLeague.set(league, getCachedMatchesForLeague(league) || []);
      continue;
    }

    const cachedMatches = getCachedMatchesForLeague(league);
    if (cachedMatches) {
      matchesByLeague.set(league, cachedMatches);
      continue;
    }

    let fetched = [];
    try {
      fetched = await getScheduledMatches(league);
      leagueMatchCache.set(league, {
        matches: fetched,
        expiresAt: Date.now() + MATCH_CACHE_TTL_MS,
      });
      leagueQuotaBackoffUntil.delete(league);
    } catch (error) {
      console.error(`Reminder poll failed reading ${league} schedule:`, error.message);
      if (isQuotaLikeError(error)) {
        leagueQuotaBackoffUntil.set(league, Date.now() + QUOTA_BACKOFF_MS);
      }
      fetched = getCachedMatchesForLeague(league) || [];
    }

    matchesByLeague.set(league, fetched);
  }

  return matchesByLeague;
}

function buildReminderQueue(nowParts, matchesByLeague) {
  const nowTotal = minutesFromEstParts(nowParts);
  const queue = [];

  for (const league of LEAGUES) {
    const matches = matchesByLeague.get(league) || [];
    for (const match of matches) {
      if (hasMatchBeenPlayed(match)) {
        continue;
      }

      const parsed = parseDateAndTimeEST(match.date, match.time);
      if (!parsed) {
        continue;
      }

      const matchTotal = minutesForMatchInCurrentYear(nowParts, parsed);
      const reminderRules = getReminderRulesForMatch(match);
      for (const rule of reminderRules) {
        const triggerTotal = matchTotal - rule.offsetMinutes;
        if (triggerTotal < nowTotal - REMINDER_GRACE_MINUTES) {
          continue;
        }

        queue.push({
          league,
          match,
          rule,
          triggerTotal,
        });
      }
    }
  }

  queue.sort((a, b) => a.triggerTotal - b.triggerTotal);
  return queue;
}

async function refreshReminderQueueIfNeeded(nowParts, force = false) {
  if (!force && Date.now() < reminderQueueRefreshAt && reminderQueue.length) {
    return;
  }

  const matchesByLeague = await fetchMatchesByLeague();
  reminderQueue = buildReminderQueue(nowParts, matchesByLeague);
  reminderQueueRefreshAt = Date.now() + QUEUE_REFRESH_MS;
}

async function postQueuedReminderForGuild(guild, queueItem, nowYear, state) {
  const { league, match, rule } = queueItem;
  const key = buildReminderKey(nowYear, league, match, rule.type);
  if (state.posted[key]) {
    return false;
  }

  let channel = await findMatchChannelByMatchId(guild, league, match.matchId);
  if (!channel) {
    channel = await findMatchChannelByTeams(guild, league, match.homeTeam, match.awayTeam);
  }
  if (!channel) {
    console.log(`Reminder skip: channel not found for ${league} ${match.matchId} (${match.awayTeam} at ${match.homeTeam})`);
    return false;
  }

  const mentionAData = await mentionForTeam(guild, match.awayTeam);
  const mentionBData = await mentionForTeam(guild, match.homeTeam);
  const mentionA = mentionAData.mention;
  const mentionB = mentionBData.mention;
  const roleMentions = [mentionAData.roleId, mentionBData.roleId].filter(Boolean);
  const formattedTime = formatTimePmEst(match.time);

  let message = '';
  if (rule.offsetMinutes > 0) {
    const customOverride = getMatchReminderMessageOverride(match, rule.type, formattedTime);
    if (customOverride) {
      message = `${mentionA} ${mentionB} ${customOverride}`;
    } else {
      message = `${mentionA} ${mentionB} Reminder: you have a match today at ${formattedTime}.`;
    }
  } else {
    const uploadCommandMention = await getUploadCommandMention(guild);
    message = `${mentionA} ${mentionB} Match time is now: ${formattedTime}. Good luck! **Please use ${uploadCommandMention} in this channel to post your ballchasing link when you have finished the match.**`;
  }

  await channel.send({
    content: message,
    allowedMentions: {
      parse: ['users'],
      roles: roleMentions,
    },
  });

  state.posted[key] = Date.now();
  return true;
}

async function pollMatchReminders(client) {
  const state = loadState();
  const now = getNowInEastern();
  const nowTotal = minutesFromEstParts(now);
  let stateChanged = false;

  await refreshReminderQueueIfNeeded(now, reminderQueue.length === 0);

  for (const guild of client.guilds.cache.values()) {
    await guild.channels.fetch();
    for (const queueItem of reminderQueue) {
      if (queueItem.triggerTotal > nowTotal) {
        break;
      }
      if (queueItem.triggerTotal < nowTotal - REMINDER_GRACE_MINUTES) {
        continue;
      }
      const sent = await postQueuedReminderForGuild(guild, queueItem, now.year, state);
      if (sent) {
        stateChanged = true;
      }
    }
  }

  reminderQueue = reminderQueue.filter((queueItem) => queueItem.triggerTotal > nowTotal);

  if (stateChanged) {
    saveState(state);
  }
}

function startMatchReminderService(client) {
  let running = false;
  let timer = null;

  const run = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await pollMatchReminders(client);
    } catch (error) {
      console.error('Reminder poll error:', error);
    } finally {
      running = false;
    }
  };

  const scheduleNextMinuteTick = () => {
    const now = Date.now();
    const msUntilNextMinute = POLL_INTERVAL_MS - (now % POLL_INTERVAL_MS);
    timer = setTimeout(async () => {
      await run();
      scheduleNextMinuteTick();
    }, msUntilNextMinute);
  };

  run();
  scheduleNextMinuteTick();

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

module.exports = {
  startMatchReminderService,
};
