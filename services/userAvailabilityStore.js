const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = path.join(process.cwd(), '.data');
const STORE_PATH = path.join(DATA_DIR, 'availability-store.json');

async function ensureStoreFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch {
    await fs.writeFile(STORE_PATH, '{}', 'utf8');
  }
}

async function readStore() {
  await ensureStoreFile();
  const raw = await fs.readFile(STORE_PATH, 'utf8');
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

async function writeStore(data) {
  await ensureStoreFile();
  await fs.writeFile(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function buildKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function buildWeeklyKey(guildId, channelId, userId, weekKey) {
  return `${guildId}:${channelId}:${userId}:${weekKey}`;
}

function getEstDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const pick = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
  };
}

function buildCurrentWeekKeyEST(date = new Date()) {
  const { year, month, day } = getEstDateParts(date);
  const estMidnightUtcMs = Date.UTC(year, month - 1, day);
  const estDate = new Date(estMidnightUtcMs);
  const dayOfWeek = estDate.getUTCDay(); // 0=Sun..6=Sat
  const sundayOffset = dayOfWeek;
  const sundayUtc = new Date(estMidnightUtcMs - sundayOffset * 24 * 60 * 60 * 1000);
  const y = sundayUtc.getUTCFullYear();
  const m = String(sundayUtc.getUTCMonth() + 1).padStart(2, '0');
  const d = String(sundayUtc.getUTCDate()).padStart(2, '0');
  return `week-${y}-${m}-${d}`;
}

async function getLastAvailability(guildId, userId) {
  if (!guildId || !userId) {
    return null;
  }
  const store = await readStore();
  return store[buildKey(guildId, userId)] || null;
}

async function saveLastAvailability(guildId, userId, payload) {
  if (!guildId || !userId || !payload) {
    return;
  }
  const store = await readStore();
  store[buildKey(guildId, userId)] = {
    dayState: payload.dayState,
    notes: payload.notes || '',
    updatedAt: new Date().toISOString(),
  };
  await writeStore(store);
}

async function getWeeklyAvailability(guildId, channelId, userId, weekKey = buildCurrentWeekKeyEST()) {
  if (!guildId || !channelId || !userId || !weekKey) {
    return null;
  }

  const store = await readStore();
  return store[buildWeeklyKey(guildId, channelId, userId, weekKey)] || null;
}

async function saveWeeklyAvailability(guildId, channelId, userId, weekKey, payload) {
  if (!guildId || !channelId || !userId || !weekKey || !payload) {
    return;
  }

  const store = await readStore();
  store[buildWeeklyKey(guildId, channelId, userId, weekKey)] = {
    dayState: payload.dayState,
    messageId: payload.messageId || null,
    updatedAt: new Date().toISOString(),
  };
  await writeStore(store);
}

module.exports = {
  getLastAvailability,
  saveLastAvailability,
  getWeeklyAvailability,
  saveWeeklyAvailability,
  buildCurrentWeekKeyEST,
};
