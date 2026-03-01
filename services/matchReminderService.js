const fs = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');

const { getScheduledMatches } = require('./googleSheets');
const { getRoleIdByTeamName } = require('../utils/teamRoles');
const { CATEGORY_NAMES } = require('./scheduleChannels');
const { slugifyTeamName } = require('../utils/slugify');

const LEAGUES = ['CCS', 'CPL', 'CAS', 'CNL'];
const POLL_INTERVAL_MS = 60 * 1000;
const STATE_PATH = path.join(__dirname, '..', 'data', 'reminder-state.json');

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
    hour: values.hour,
    minute: values.minute,
  };
}

function parseDateAndTimeEST(dateText, timeText) {
  const dateMatch = String(dateText || '').trim().match(/^([1-9]|1[0-2])\/([1-9]|[12][0-9]|3[01])$/);
  if (!dateMatch) {
    return null;
  }

  const timeMatch = String(timeText || '').trim().match(/^(1[0-2]|[1-9])(?::([0-5][0-9]))?$/);
  if (!timeMatch) {
    return null;
  }

  const month = Number(dateMatch[1]);
  const day = Number(dateMatch[2]);
  const hour12 = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] || 0);
  const hour24 = hour12 === 12 ? 12 : hour12 + 12; // PM only

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
    return `${String(timeText || '').trim()} PM EST`;
  }

  const hour12 = parsed.hour === 12 ? 12 : parsed.hour - 12;
  const mm = String(parsed.minute).padStart(2, '0');
  return `${hour12}:${mm} PM EST`;
}

function buildReminderKey(year, league, match) {
  const normalizedTime = String(match.time || '').trim();
  const normalizedDate = String(match.date || '').trim();
  return `${year}|${league}|${match.matchId}|${normalizedDate}|${normalizedTime}`;
}

async function mentionForTeam(guild, teamName) {
  const roleId = await getRoleIdByTeamName(guild, teamName);
  return roleId ? `<@&${roleId}>` : `@${teamName}`;
}

async function findMatchChannelByMatchId(guild, league, matchId) {
  await guild.channels.fetch();

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
  return new Set([
    awayAtHome,
    `${awayAtHome}✅`,
    `${awayAtHome}confirmed`,
    homeAtAway,
    `${homeAtAway}✅`,
    `${homeAtAway}confirmed`,
  ]);
}

async function findMatchChannelByTeams(guild, league, homeTeam, awayTeam) {
  await guild.channels.fetch();
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
      return parentName === categoryName && candidates.has(String(channel.name || '').trim());
    }) || null
  );
}

async function pollMatchReminders(client) {
  const state = loadState();
  const now = getNowInEastern();
  let stateChanged = false;

  for (const guild of client.guilds.cache.values()) {
    for (const league of LEAGUES) {
      let matches = [];
      try {
        matches = await getScheduledMatches(league);
      } catch (error) {
        console.error(`Reminder poll failed reading ${league} schedule:`, error.message);
        continue;
      }

      for (const match of matches) {
        const parsed = parseDateAndTimeEST(match.date, match.time);
        if (!parsed) {
          continue;
        }

        if (
          parsed.month !== now.month ||
          parsed.day !== now.day ||
          parsed.hour !== now.hour ||
          parsed.minute !== now.minute
        ) {
          continue;
        }

        const key = buildReminderKey(now.year, league, match);
        if (state.posted[key]) {
          continue;
        }

        let channel = await findMatchChannelByMatchId(guild, league, match.matchId);
        if (!channel) {
          channel = await findMatchChannelByTeams(guild, league, match.homeTeam, match.awayTeam);
        }
        if (!channel) {
          console.log(
            `Reminder skip: channel not found for ${league} ${match.matchId} (${match.awayTeam} at ${match.homeTeam})`
          );
          continue;
        }

        const mentionA = await mentionForTeam(guild, match.awayTeam);
        const mentionB = await mentionForTeam(guild, match.homeTeam);
        const message = `${mentionA} ${mentionB} MATCH TIME IS NOW: ${formatTimePmEst(
          match.time
        )}. GOOD LUCK! PLEASE USE /UPLOAD TO POST YOUR BALLCHASING LINK WHEN YOU HAVE FINISHED THE MATCH.`;

        await channel.send(message);
        state.posted[key] = Date.now();
        stateChanged = true;
      }
    }
  }

  if (stateChanged) {
    saveState(state);
  }
}

function startMatchReminderService(client) {
  let running = false;

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

  run();
  setInterval(run, POLL_INTERVAL_MS);
}

module.exports = {
  startMatchReminderService,
};
