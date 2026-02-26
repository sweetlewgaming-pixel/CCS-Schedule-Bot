const { MessageFlags, SlashCommandBuilder } = require('discord.js');

const { slugifyTeamName } = require('../utils/slugify');
const { isAdminAuthorized, normalizeRoleName } = require('../utils/permissions');

const DAY_KEYS = ['tues', 'wed', 'thurs', 'fri', 'sat', 'sun'];
const DAY_LABELS = {
  tues: 'Tuesday',
  wed: 'Wednesday',
  thurs: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

function cleanChannelName(name) {
  return String(name || '').replace(/✅+$/u, '').replace(/confirmed$/i, '').trim();
}

function parseMatchupSlugsFromChannel(channelName) {
  const cleaned = cleanChannelName(channelName);
  const parts = cleaned.split('-at-');
  if (parts.length !== 2) {
    return null;
  }

  return {
    leftSlug: parts[0].trim(),
    rightSlug: parts[1].trim(),
  };
}

function parseTimePart(part) {
  const text = String(part || '').trim().toLowerCase();
  const match = text.match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/i);
  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] || '0');
  const meridiem = match[3];

  if (hour < 1 || hour > 12) {
    return null;
  }

  // No AM/PM provided: assume evening EST for league scheduling.
  if (!meridiem) {
    if (hour !== 12) {
      hour += 12;
    }
  } else if (meridiem.toLowerCase() === 'am') {
    if (hour === 12) {
      hour = 0;
    }
  } else if (meridiem.toLowerCase() === 'pm') {
    if (hour !== 12) {
      hour += 12;
    }
  }

  return hour * 60 + minute;
}

function parseRange(value) {
  const cleaned = String(value || '')
    .replace(/[–—]/g, '-')
    .replace(/\s+to\s+/gi, '-')
    .trim();
  const pieces = cleaned.split('-').map((s) => s.trim()).filter(Boolean);
  if (pieces.length !== 2) {
    return null;
  }

  const start = parseTimePart(pieces[0]);
  const end = parseTimePart(pieces[1]);
  if (start === null || end === null || end <= start) {
    return null;
  }

  return { start, end };
}

function parseSchedulesFromText(text) {
  const schedules = [];
  let current = {};
  const lines = String(text || '').split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^\s*(tues?|tuesday|wed(?:nesday)?|thurs?|thursday|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s*:\s*(.+)$/i);
    if (!match) {
      continue;
    }

    const rawDay = match[1].toLowerCase();
    const rawRange = match[2].trim();
    const key =
      rawDay.startsWith('tu') ? 'tues' :
      rawDay.startsWith('we') ? 'wed' :
      rawDay.startsWith('th') ? 'thurs' :
      rawDay.startsWith('fr') ? 'fri' :
      rawDay.startsWith('sa') ? 'sat' :
      rawDay.startsWith('su') ? 'sun' : null;

    if (!key) {
      continue;
    }

    // If a day repeats in the same message, treat it as a new schedule block.
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      if (hasAnyParsedDay(current)) {
        schedules.push(current);
      }
      current = {};
    }

    const range = parseRange(rawRange);
    if (range) {
      current[key] = range;
    }
  }

  if (hasAnyParsedDay(current)) {
    schedules.push(current);
  }

  return schedules;
}

function hasAnyParsedDay(schedule) {
  return DAY_KEYS.some((d) => Boolean(schedule[d]));
}

function formatMinutesAsTime(totalMinutes) {
  const hour24 = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = ((hour24 + 11) % 12) + 1;
  return `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

function computeOverlaps(userSchedules) {
  const overlaps = [];
  for (const day of DAY_KEYS) {
    const ranges = userSchedules.map((schedule) => schedule[day]).filter(Boolean);
    if (ranges.length !== userSchedules.length) {
      continue;
    }

    const start = Math.max(...ranges.map((r) => r.start));
    const end = Math.min(...ranges.map((r) => r.end));
    if (end > start) {
      overlaps.push({ day, start, end, duration: end - start });
    }
  }

  return overlaps.sort((a, b) => b.duration - a.duration);
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

async function fetchRecentMessages(channel, max = 300) {
  const all = [];
  let before;
  while (all.length < max) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) {
      break;
    }
    const values = [...batch.values()];
    all.push(...values);
    before = values[values.length - 1].id;
    if (batch.size < 100) {
      break;
    }
  }
  return all;
}

async function resolveTimeskeeperMention(guild) {
  const explicitId = process.env.CCS_TIMESKEEPER_ROLE_ID;
  if (explicitId) {
    return `<@&${explicitId}>`;
  }

  if (!guild.roles.cache.size) {
    await guild.roles.fetch();
  }
  const role = guild.roles.cache.find((r) => {
    const normalized = normalizeRoleName(r.name);
    return normalized === 'ccstimeskeeper';
  });
  return role ? `<@&${role.id}>` : '@ccs timeskeeper';
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('suggest_times')
    .setDescription('Analyze posted schedules in this matchup channel and suggest overlap times')
    .setDMPermission(false),

  async handleChatInput(interaction) {
    if (!interaction.guild || !interaction.channel || !interaction.channel.isTextBased?.()) {
      await interaction.reply({ content: 'Use this in a server text channel.', flags: MessageFlags.Ephemeral });
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
        content: 'Use this inside a matchup channel named like `team-a-at-team-b`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const messages = await fetchRecentMessages(interaction.channel, 300);
    const allSchedules = [];

    for (const message of messages) {
      if (message.author?.bot) {
        continue;
      }
      const parsedBlocks = parseSchedulesFromText(message.content || '');
      if (!parsedBlocks.length) {
        continue;
      }

      for (const block of parsedBlocks) {
        allSchedules.push(block);
      }
    }

    const userSchedules = allSchedules;
    if (!userSchedules.length) {
      await interaction.editReply('No valid player schedule posts were found yet in this channel.');
      return;
    }

    const overlaps = computeOverlaps(userSchedules);
    if (!overlaps.length) {
      const timeskeeperMention = await resolveTimeskeeperMention(interaction.guild);
      await interaction.channel.send(
        `${timeskeeperMention} No overlapping availability found in this channel based on submitted player schedules.`
      );
      await interaction.editReply('No common overlap found. I pinged the CCS timeskeeper role.');
      return;
    }

    const top = overlaps.slice(0, 3);
    const lines = top.map(
      (o) =>
        `- ${DAY_LABELS[o.day]}: ${formatMinutesAsTime(o.start)} - ${formatMinutesAsTime(o.end)} EST`
    );

    await interaction.channel.send(
      `Suggested best overlap times based on submitted schedules (${userSchedules.length} schedule blocks considered):\n${lines.join('\n')}`
    );
    await interaction.editReply('Posted best overlap suggestions in this channel.');
  },
};
