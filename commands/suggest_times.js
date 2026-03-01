const { MessageFlags, SlashCommandBuilder } = require('discord.js');

const { isAdminAuthorized, normalizeRoleName } = require('../utils/permissions');
const {
  DAY_KEYS,
  parseSchedulesFromText: sharedParseSchedulesFromText,
  isScheduleTemplateMessage: sharedIsScheduleTemplateMessage,
} = require('../utils/scheduleParser');
const DAY_LABELS = {
  tues: 'Tuesday',
  wed: 'Wednesday',
  thurs: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const DAY_ORDER = ['mon', 'tues', 'wed', 'thurs', 'fri', 'sat', 'sun'];
const DAY_ALIASES = {
  monday: 'mon',
  mon: 'mon',
  tuesday: 'tues',
  tues: 'tues',
  tue: 'tues',
  wednesday: 'wed',
  wedneday: 'wed',
  wendsday: 'wed',
  wensday: 'wed',
  wensdey: 'wed',
  wed: 'wed',
  thursday: 'thurs',
  thurday: 'thurs',
  thirsday: 'thurs',
  thurs: 'thurs',
  thu: 'thurs',
  friday: 'fri',
  fri: 'fri',
  saturday: 'sat',
  saturaday: 'sat',
  sat: 'sat',
  sunday: 'sun',
  sunnday: 'sun',
  sun: 'sun',
};

const UNAVAILABLE_WORDS = ['n/a', 'na', 'no', 'unavailable', 'not available', 'cant', "can't"];
const OPEN_WORDS = ['open', 'anytime', 'free all day', 'all day', 'available all day'];
const DISCOURAGED_WORD_PATTERNS = [
  /would\s+prefer\s+not/i,
  /would\s+not\s+prefer/i,
  /\bprefer\s+not\b/i,
];

function cleanChannelName(name) {
  return String(name || '').replace(/[\u2705]+$/u, '').replace(/confirmed$/i, '').trim();
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

function normalizeDayToken(value) {
  const key = String(value || '').trim().toLowerCase();
  return DAY_ALIASES[key] || null;
}

function expandDayRange(startDay, endDay) {
  const startIdx = DAY_ORDER.indexOf(startDay);
  const endIdx = DAY_ORDER.indexOf(endDay);
  if (startIdx < 0 || endIdx < 0) {
    return [];
  }

  if (startIdx <= endIdx) {
    return DAY_ORDER.slice(startIdx, endIdx + 1);
  }

  return [...DAY_ORDER.slice(startIdx), ...DAY_ORDER.slice(0, endIdx + 1)];
}

function parseTimePart(part) {
  const text = String(part || '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/\b(?:e|c|m|p)(?:s|d)?t\b/gi, '')
    .replace(/\b(?:eastern|central|mountain|pacific)\b/gi, '')
    .trim();
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

  if (!meridiem) {
    // Default to PM if not specified (league scheduling context).
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
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+to\s+/gi, '-')
    .replace(/@/g, '')
    .trim();
  const parts = cleaned.split('-').map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }

  const start = parseTimePart(parts[0]);
  const end = parseTimePart(parts[1]);
  if (start === null || end === null) {
    return null;
  }

  // Handle "6pm-12am" by treating end as end-of-day.
  const adjustedEnd = end <= start ? 24 * 60 : end;
  if (adjustedEnd <= start) {
    return null;
  }

  return { start, end: adjustedEnd };
}

function parseAvailabilityExpression(value) {
  const text = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\b(?:e|c|m|p)(?:s|d)?t\b/gi, '')
    .replace(/\b(?:eastern|central|mountain|pacific)\b/gi, '')
    .replace(/[.?!]+$/g, '')
    .replace(/\baftr\b/g, 'after')
    .replace(/\bafer\b/g, 'after')
    .replace(/\bfter\b/g, 'after')
    .replace(/\bbefor\b/g, 'before')
    .replace(/\bbefroe\b/g, 'before')
    .replace(/\bpreffer\b/g, 'prefer')
    .replace(/\bafernoon\b/g, 'afternoon')
    .replace(/\bavailble\b/g, 'available')
    .replace(/\bunavailble\b/g, 'unavailable');

  if (!text) {
    return null;
  }

  const discouraged = DISCOURAGED_WORD_PATTERNS.some((pattern) => pattern.test(text));
  const ranges = [];

  if (/\bmorning\b/i.test(text)) {
    return { unavailable: true };
  }

  if (/\bafternoon\b/i.test(text)) {
    return { ranges: [{ start: 17 * 60, end: 24 * 60, discouraged }] };
  }

  if (
    OPEN_WORDS.some((w) => text.includes(w)) ||
    /\bany\b/i.test(text) ||
    /\bfree\b/i.test(text)
  ) {
    return { ranges: [{ start: 0, end: 24 * 60, discouraged }] };
  }

  const afterRegex = /(?:after|aft(?:er)?)\s+(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)/gi;
  let afterMatch = afterRegex.exec(text);
  while (afterMatch) {
    const start = parseTimePart(afterMatch[1]);
    if (start !== null) {
      ranges.push({ start, end: 24 * 60, discouraged });
    }
    afterMatch = afterRegex.exec(text);
  }

  const plusAfterRegex = /(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)\s*\+/gi;
  let plusAfterMatch = plusAfterRegex.exec(text);
  while (plusAfterMatch) {
    const start = parseTimePart(plusAfterMatch[1]);
    if (start !== null) {
      ranges.push({ start, end: 24 * 60, discouraged });
    }
    plusAfterMatch = plusAfterRegex.exec(text);
  }

  const beforeRegex = /(?:before|bef(?:ore)?)\s+(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)/gi;
  let beforeMatch = beforeRegex.exec(text);
  while (beforeMatch) {
    const end = parseTimePart(beforeMatch[1]);
    if (end !== null) {
      ranges.push({ start: 0, end, discouraged });
    }
    beforeMatch = beforeRegex.exec(text);
  }

  const rangeRegex =
    /(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)\s*(?:-|to)\s*(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)/gi;
  let rangeMatch = rangeRegex.exec(text);
  while (rangeMatch) {
    const parsed = parseRange(`${rangeMatch[1]}-${rangeMatch[2]}`);
    if (parsed) {
      ranges.push({ ...parsed, discouraged });
    }
    rangeMatch = rangeRegex.exec(text);
  }

  if (ranges.length) {
    return { ranges };
  }

  // Handle comma-separated chunks with loose typing, e.g. "5-8, after 10" or "7pm, 9pm".
  if (text.includes(',')) {
    const chunks = text
      .split(',')
      .map((chunk) => chunk.trim())
      .filter(Boolean);

    for (const chunk of chunks) {
      const rangeMatch = chunk.match(
        /(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)\s*(?:-|to)\s*(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)/i
      );
      if (rangeMatch) {
        const parsed = parseRange(`${rangeMatch[1]}-${rangeMatch[2]}`);
        if (parsed) {
          ranges.push({ ...parsed, discouraged });
        }
        continue;
      }

      const afterChunk = chunk.match(/(?:after|aft(?:er)?)\s+(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)/i);
      if (afterChunk) {
        const start = parseTimePart(afterChunk[1]);
        if (start !== null) {
          ranges.push({ start, end: 24 * 60, discouraged });
        }
        continue;
      }

      const plusChunk = chunk.match(/(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)\s*\+/i);
      if (plusChunk) {
        const start = parseTimePart(plusChunk[1]);
        if (start !== null) {
          ranges.push({ start, end: 24 * 60, discouraged });
        }
        continue;
      }

      const beforeChunk = chunk.match(/(?:before|bef(?:ore)?)\s+(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)/i);
      if (beforeChunk) {
        const end = parseTimePart(beforeChunk[1]);
        if (end !== null) {
          ranges.push({ start: 0, end, discouraged });
        }
        continue;
      }

      // Plain time chunk like "7pm" => treat as a 1-hour available block.
      const single = parseTimePart(chunk);
      if (single !== null) {
        ranges.push({ start: single, end: Math.min(single + 60, 24 * 60), discouraged });
      }
    }

    if (ranges.length) {
      return { ranges };
    }
  }

  if (UNAVAILABLE_WORDS.some((w) => text.includes(w))) {
    return { unavailable: true };
  }

  const parsedDirect = parseRange(text);
  return parsedDirect ? { ranges: [{ ...parsedDirect, discouraged }] } : null;
}

function extractMentionedDays(value) {
  const text = String(value || '');
  const dayRegex =
    /\b(monday|mon|tuesday|tues?|wed(?:nesday)?|thurs?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi;
  const seen = new Set();
  const result = [];
  let match = dayRegex.exec(text);
  while (match) {
    const normalized = normalizeDayToken(match[1]);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
    match = dayRegex.exec(text);
  }
  return result;
}

function parseConversationalDayEntries(value) {
  const text = String(value || '').trim();
  const lowered = text.toLowerCase();
  if (!lowered) {
    return null;
  }

  const mentionedDays = extractMentionedDays(lowered).filter((d) => DAY_KEYS.includes(d));
  const hasAnyDayPhrase = /\b(any day|all week|anytime this week)\b/i.test(lowered);
  const hasExceptPhrase = /\b(except|besides|but not)\b/i.test(lowered);
  const hasPositiveCue = /\b(any|anytime|free|available|works?|good|looking good|fine)\b/i.test(lowered);
  const hasNegativeCue = /\b(unavailable|not available|cant|can't|busy|tough|no)\b/i.test(lowered);

  if (!hasAnyDayPhrase && !mentionedDays.length) {
    return null;
  }

  // "Any day except Sunday" -> all days available except listed days unavailable.
  if (hasAnyDayPhrase && hasExceptPhrase && mentionedDays.length) {
    return DAY_KEYS.map((day) => {
      if (mentionedDays.includes(day)) {
        return { day, unavailable: true };
      }
      return {
        day,
        ranges: [{ start: 0, end: 24 * 60, discouraged: false }],
      };
    });
  }

  // "Any day", "free all week" -> full availability on all tracked days.
  if (hasAnyDayPhrase && hasPositiveCue && !hasNegativeCue) {
    return DAY_KEYS.map((day) => ({
      day,
      ranges: [{ start: 0, end: 24 * 60, discouraged: false }],
    }));
  }

  if (!mentionedDays.length) {
    return null;
  }

  if (hasNegativeCue && !hasPositiveCue) {
    return mentionedDays.map((day) => ({ day, unavailable: true }));
  }

  if (hasPositiveCue) {
    return mentionedDays.map((day) => ({
      day,
      ranges: [{ start: 0, end: 24 * 60, discouraged: false }],
    }));
  }

  return null;
}

function hasAnyParsedDay(schedule) {
  return DAY_KEYS.some((d) => Boolean(schedule[d]));
}

function splitPotentialMultiDayLine(line) {
  const text = String(line || '');
  const dayRegex =
    /\b(monday|mon|tuesday|tues?|wed(?:nesday)?|thurs?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi;
  const matches = [...text.matchAll(dayRegex)];
  if (matches.length <= 1) {
    return [line];
  }

  const parts = [];
  let i = 0;
  while (i < matches.length) {
    const start = matches[i].index;
    let end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    let part = text.slice(start, end).trim();

    // If this chunk ends with a connector, join it with the next day chunk.
    // Example: "saturday and" + "sunday after 8" => "saturday and sunday after 8".
    if (
      i + 1 < matches.length &&
      /(?:-|to|till|through|thru|&|and)\s*$/i.test(part)
    ) {
      const nextEnd = i + 2 < matches.length ? matches[i + 2].index : text.length;
      end = nextEnd;
      part = text.slice(start, end).trim();
      i += 1;
    }

    if (part) {
      parts.push(part);
    }
    i += 1;
  }

  return parts.length ? parts : [line];
}

function looksLikeScheduleLine(line) {
  const trimmed = String(line || '').trim().toLowerCase();
  if (!trimmed) {
    return false;
  }

  const dayRegex = /\b(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi;
  const dayMentions = [...trimmed.matchAll(dayRegex)].length;
  const hasDayWord = dayMentions > 0;
  const hasSeparator = /[:\-]/.test(trimmed);
  if (hasDayWord && hasSeparator) {
    return true;
  }

  // Catch conversational schedule statements, e.g.
  // "any day except sunday", "busy wednesday night", "friday saturday works".
  const hasScheduleIntentWord =
    /\b(any|anytime|free|except|after|before|unavailable|available|cant|can't|busy|works?|good)\b/i.test(trimmed);
  if (hasDayWord && hasScheduleIntentWord) {
    return true;
  }

  return dayMentions >= 2;
}

function parseSchedulesFromText(text) {
  const schedules = [];
  let current = {};
  const lines = String(text || '').split(/\r?\n/);
  let matchedDayLines = 0;
  let handledDayLines = 0;
  let likelyScheduleLineCount = 0;

  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed) {
      continue;
    }

    if (looksLikeScheduleLine(trimmed)) {
      likelyScheduleLineCount += 1;
    }

    const candidateLines = splitPotentialMultiDayLine(trimmed);
    for (const candidateLine of candidateLines) {

      // Section labels like "Talen:" or "March:".
      if (/^[A-Za-z0-9_.-]+\s*:\s*$/.test(candidateLine)) {
        if (hasAnyParsedDay(current)) {
          schedules.push(current);
        }
        current = {};
        continue;
      }

      const match = candidateLine.match(
        /^\s*(?:[A-Za-z0-9_.-]+\s*:\s*)?(monday|mon|tuesday|tues?|wed(?:nesday)?|thurs?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)(?:\s*(?:-|to|till|through|thru|&|and)\s*(monday|mon|tuesday|tues?|wed(?:nesday)?|thurs?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?))?\s*[:\-]?\s*(.+)$/i
      );

      if (!match) {
        const conversationalEntries = parseConversationalDayEntries(candidateLine);
        if (conversationalEntries && conversationalEntries.length) {
          matchedDayLines += 1;
          for (const entry of conversationalEntries) {
            if (!DAY_KEYS.includes(entry.day)) {
              continue;
            }

            handledDayLines += 1;
            if (Object.prototype.hasOwnProperty.call(current, entry.day)) {
              if (hasAnyParsedDay(current)) {
                schedules.push(current);
              }
              current = {};
            }

            if (!entry.unavailable) {
              current[entry.day] = entry.ranges.map((range) => ({
                start: range.start,
                end: range.end,
                discouraged: Boolean(range.discouraged),
              }));
            }
          }
        }
        continue;
      }
      matchedDayLines += 1;

      const startDay = normalizeDayToken(match[1]);
      const endDay = normalizeDayToken(match[2]);
      const availabilityText = match[3].trim();
      const availability = parseAvailabilityExpression(availabilityText);
      if (!startDay || !availability) {
        continue;
      }

      const days = endDay ? expandDayRange(startDay, endDay) : [startDay];
      if (!days.length) {
        continue;
      }

      for (const day of days) {
        if (!DAY_KEYS.includes(day)) {
          continue;
        }

        handledDayLines += 1;
        if (Object.prototype.hasOwnProperty.call(current, day)) {
          if (hasAnyParsedDay(current)) {
            schedules.push(current);
          }
          current = {};
        }

        if (!availability.unavailable) {
          current[day] = availability.ranges.map((range) => ({
            start: range.start,
            end: range.end,
            discouraged: Boolean(range.discouraged),
          }));
        }
      }
    }
  }

  if (hasAnyParsedDay(current)) {
    schedules.push(current);
  }

  return {
    schedules,
    matchedDayLines,
    handledDayLines,
    likelyScheduleLineCount,
  };
}

function isScheduleTemplateMessage(text) {
  const lowered = String(text || '').toLowerCase();
  if (!lowered.trim()) {
    return false;
  }

  if (lowered.includes('please put your schedule in this format')) {
    return true;
  }

  if (lowered.includes('all in est please')) {
    return true;
  }

  const placeholderLines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
    .filter((line) =>
      /^(tues|tue|wed|thurs|thu|fri|sat|sun)\s*:\s*time\s*[-to]+\s*time$/i.test(line)
    );

  return placeholderLines.length >= 3;
}

function formatMinutesAsTime(totalMinutes) {
  const normalized = totalMinutes >= 24 * 60 ? totalMinutes % (24 * 60) : totalMinutes;
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = ((hour24 + 11) % 12) + 1;
  return `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

function computeOverlaps(userSchedules, options = {}) {
  const allowDiscouraged = Boolean(options.allowDiscouraged);
  const overlaps = [];
  for (const day of DAY_KEYS) {
    const perUserRanges = userSchedules.map((schedule) => schedule[day]).filter(Boolean);
    if (perUserRanges.length !== userSchedules.length) {
      continue;
    }

    const effectivePerUser = perUserRanges.map((ranges) =>
      allowDiscouraged ? ranges : ranges.filter((r) => !r.discouraged)
    );
    if (effectivePerUser.some((ranges) => !ranges.length)) {
      continue;
    }

    const points = [];
    for (const ranges of effectivePerUser) {
      for (const range of ranges) {
        points.push(range.start, range.end);
      }
    }
    const sortedPoints = [...new Set(points)].sort((a, b) => a - b);
    if (sortedPoints.length < 2) {
      continue;
    }

    const dayOverlaps = [];
    for (let i = 0; i < sortedPoints.length - 1; i += 1) {
      const start = sortedPoints[i];
      const end = sortedPoints[i + 1];
      if (end <= start) {
        continue;
      }

      const midpoint = (start + end) / 2;
      const allCovered = effectivePerUser.every((ranges) =>
        ranges.some((range) => midpoint >= range.start && midpoint < range.end)
      );
      if (!allCovered) {
        continue;
      }

      const previous = dayOverlaps[dayOverlaps.length - 1];
      if (previous && previous.end === start) {
        previous.end = end;
      } else {
        dayOverlaps.push({ day, start, end });
      }
    }

    for (const overlap of dayOverlaps) {
      if (overlap.end > overlap.start) {
        overlaps.push({ ...overlap, duration: overlap.end - overlap.start });
      }
    }
  }

  return overlaps.sort((a, b) => b.duration - a.duration);
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

function splitTranscriptIntoPseudoMessages(rawText, fallbackAuthorName) {
  const text = String(rawText || '');
  const lines = text.split(/\r?\n/);
  const chunks = [];

  const isRoleMetaLine = (value) => {
    const v = String(value || '').trim().toLowerCase();
    return /^role icon,/.test(v);
  };

  const extractInlineAuthor = (value) => {
    const line = String(value || '').trim();
    const match = line.match(/^(.+?)\s*role icon,/i);
    return match ? match[1].trim() : null;
  };

  const nextNonEmptyIndex = (start) => {
    for (let idx = start; idx < lines.length; idx += 1) {
      if (String(lines[idx] || '').trim()) {
        return idx;
      }
    }
    return -1;
  };

  const markers = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || '').trim();
    const nextIdx = nextNonEmptyIndex(i + 1);
    const nextLine = nextIdx >= 0 ? String(lines[nextIdx] || '').trim() : '';
    if (!line) {
      continue;
    }

    // Pattern from copied transcript:
    // Username
    // Role icon, Team — timestamp
    if (nextLine && isRoleMetaLine(nextLine)) {
      markers.push({
        authorName: line,
        markerLineIndex: i,
        contentStartIndex: nextIdx + 1,
      });
      i = nextIdx;
      continue;
    }

    // Collapsed copy/paste pattern:
    // UsernameRole icon, Team — timestamp
    const inlineAuthor = extractInlineAuthor(line);
    if (inlineAuthor) {
      markers.push({
        authorName: inlineAuthor,
        markerLineIndex: i,
        contentStartIndex: i + 1,
      });
      continue;
    }
  }

  if (!markers.length) {
    return [{ authorName: fallbackAuthorName || 'Unknown', content: text }];
  }

  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i];
    const nextMarker = markers[i + 1];
    const endIndex = nextMarker ? nextMarker.markerLineIndex : lines.length;
    const bodyLines = lines
      .slice(marker.contentStartIndex, endIndex)
      .filter((line) => !isRoleMetaLine(line));
    const bodyText = bodyLines.join('\n').trim();

    // For pasted transcript testing: tie any preface text before first marker
    // to that first detected author.
    if (i === 0 && marker.markerLineIndex > 0) {
      const prefaceText = lines
        .slice(0, marker.markerLineIndex)
        .filter((line) => !isRoleMetaLine(line))
        .join('\n')
        .trim();
      if (prefaceText) {
        chunks.push({ authorName: marker.authorName, content: prefaceText });
      }
    }

    if (bodyText) {
      chunks.push({ authorName: marker.authorName, content: bodyText });
    }
  }

  return chunks;
}

async function resolveTimeskeeperMention(guild) {
  const explicitId = process.env.CCS_TIMESKEEPER_ROLE_ID;
  if (explicitId) {
    return `<@&${explicitId}>`;
  }

  if (!guild.roles.cache.size) {
    await guild.roles.fetch();
  }

  const role = guild.roles.cache.find((r) => normalizeRoleName(r.name) === 'ccstimeskeeper');
  return role ? `<@&${role.id}>` : '@ccs timeskeeper';
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Analyze posted schedules in this matchup channel and suggest overlap times')
    .setDMPermission(false),

  async handleChatInput(interaction) {
    if (!interaction.guild || !interaction.channel || !interaction.channel.isTextBased?.()) {
      await interaction.reply({
        content: 'Use this in a server text channel.',
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
        content: 'Use this inside a matchup channel named like `team-a-at-team-b`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const messages = await fetchRecentMessages(interaction.channel, 300);
    const allSchedules = [];
    const parseStatusByUser = new Map();

    for (const message of messages) {
      if (message.author?.bot && message.author.id !== interaction.client.user.id) {
        continue;
      }

      const fallbackName = message.member?.displayName || message.author?.globalName || message.author?.username || 'Unknown';
      const pseudoMessages = splitTranscriptIntoPseudoMessages(message.content || '', fallbackName);

      for (const pseudo of pseudoMessages) {
        if (sharedIsScheduleTemplateMessage(pseudo.content)) {
          continue;
        }

        const parsedResult = sharedParseSchedulesFromText(pseudo.content);
        const parsedBlocks = parsedResult.schedules;
        const likelyLines = parsedResult.likelyScheduleLineCount;
        const handledLines = parsedResult.handledDayLines;
        const name = pseudo.authorName || 'Unknown';
        const currentStatus = parseStatusByUser.get(name) || {
          hadLikelyScheduleLines: false,
          hadAnyParsedSchedule: false,
          hadPartialParse: false,
        };

        if (likelyLines > 0) {
          currentStatus.hadLikelyScheduleLines = true;
        }
        if (parsedBlocks.length) {
          currentStatus.hadAnyParsedSchedule = true;
        }
        if (likelyLines > 0 && handledLines < likelyLines) {
          currentStatus.hadPartialParse = true;
        }
        parseStatusByUser.set(name, currentStatus);

        if (!parsedBlocks.length) {
          continue;
        }

        for (const block of parsedBlocks) {
          allSchedules.push(block);
        }
      }
    }

    if (!allSchedules.length) {
      await interaction.editReply('No valid player schedule posts were found yet in this channel.');
      return;
    }

    const partiallyParsedUsers = [...parseStatusByUser.entries()]
      .filter(([, status]) => status.hadPartialParse)
      .map(([name]) => name)
      .slice(0, 15);

    const confirmedUsers = [...parseStatusByUser.entries()]
      .filter(([, status]) => status.hadAnyParsedSchedule && status.hadLikelyScheduleLines && !status.hadPartialParse)
      .map(([name]) => name)
      .slice(0, 20);

    const confirmedNote = confirmedUsers.length
      ? `\nConfirmed schedule reads: ${confirmedUsers.join(', ')}`
      : '';
    const partialParseNote = partiallyParsedUsers.length
      ? `\nCould not fully read schedules from: ${partiallyParsedUsers.join(', ')}`
      : '';

    const preferredOverlaps = computeOverlaps(allSchedules, { allowDiscouraged: false });
    const fallbackOverlaps = preferredOverlaps.length ? preferredOverlaps : computeOverlaps(allSchedules, { allowDiscouraged: true });
    const usedDiscouragedFallback = !preferredOverlaps.length && fallbackOverlaps.length;

    const overlaps = fallbackOverlaps;
    if (!overlaps.length) {
      const timeskeeperMention = await resolveTimeskeeperMention(interaction.guild);
      await interaction.channel.send(
        `${timeskeeperMention} No overlapping availability found in this channel based on submitted player schedules.${confirmedNote}${partialParseNote}`
      );
      await interaction.editReply('No common overlap found. I pinged the CCS timeskeeper role.');
      return;
    }

    const top = overlaps.slice(0, 3);
    const lines = top.map((o) => `- ${DAY_LABELS[o.day]}: ${formatMinutesAsTime(o.start)} - ${formatMinutesAsTime(o.end)} EST`);

    const fallbackNote = usedDiscouragedFallback
      ? '\n(Used "would prefer not" / discouraged slots because no fully preferred overlap was found.)'
      : '';

    await interaction.channel.send(
      `Suggested best overlap times based on submitted schedules (${allSchedules.length} schedule blocks considered):\n${lines.join('\n')}${fallbackNote}${confirmedNote}${partialParseNote}`
    );
    await interaction.editReply('Posted best overlap suggestions in this channel.');
  },
};
