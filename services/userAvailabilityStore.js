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

module.exports = {
  getLastAvailability,
  saveLastAvailability,
};
