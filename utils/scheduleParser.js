const DAY_KEYS = ['tues', 'wed', 'thurs', 'fri', 'sat', 'sun'];
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
const DISCOURAGED_WORD_PATTERNS = [/would\s+prefer\s+not/i, /would\s+not\s+prefer/i, /\bprefer\s+not\b/i];

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

  if (OPEN_WORDS.some((w) => text.includes(w)) || /\bany\b/i.test(text) || /\bfree\b/i.test(text)) {
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

  if (text.includes(',')) {
    const chunks = text.split(',').map((chunk) => chunk.trim()).filter(Boolean);
    for (const chunk of chunks) {
      const chunkRange = chunk.match(
        /(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)\s*(?:-|to)\s*(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)/i
      );
      if (chunkRange) {
        const parsed = parseRange(`${chunkRange[1]}-${chunkRange[2]}`);
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

  if (hasAnyDayPhrase && hasExceptPhrase && mentionedDays.length) {
    return DAY_KEYS.map((day) =>
      mentionedDays.includes(day)
        ? { day, unavailable: true }
        : { day, ranges: [{ start: 0, end: 24 * 60, discouraged: false }] }
    );
  }

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
    return mentionedDays.map((day) => ({ day, ranges: [{ start: 0, end: 24 * 60, discouraged: false }] }));
  }

  return null;
}

function hasAnyParsedDay(schedule) {
  return DAY_KEYS.some((d) => Object.prototype.hasOwnProperty.call(schedule, d));
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

    if (i + 1 < matches.length && /(?:-|to|till|through|thru|&|and)\s*$/i.test(part)) {
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

            current[entry.day] = entry.unavailable
              ? []
              : entry.ranges.map((range) => ({
                  start: range.start,
                  end: range.end,
                  discouraged: Boolean(range.discouraged),
                }));
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

        current[day] = availability.unavailable
          ? []
          : availability.ranges.map((range) => ({
              start: range.start,
              end: range.end,
              discouraged: Boolean(range.discouraged),
            }));
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

  if (lowered.includes('please put your schedule in this format') || lowered.includes('all in est please')) {
    return true;
  }

  const placeholderLines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
    .filter((line) => /^(tues|tue|wed|thurs|thu|fri|sat|sun)\s*:\s*time\s*[-to]+\s*time$/i.test(line));

  return placeholderLines.length >= 3;
}

module.exports = {
  DAY_KEYS,
  parseSchedulesFromText,
  isScheduleTemplateMessage,
};
