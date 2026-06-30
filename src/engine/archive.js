// ── Conversation Archive & world-state export ──
// Conversations are persisted to localStorage (capped backup) and appended to
// disk via the dev server's API. Plus the full-world-state snapshot export. No
// engine dependencies — pure browser/disk IO.

const ARCHIVE_KEY = 'village_life_conversation_archive';

export function saveConversationToArchive(record) {
  // save to localStorage as backup
  try {
    const existing = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]');
    existing.push(record);
    if (existing.length > 500) existing.splice(0, existing.length - 500);
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(existing));
  } catch (e) {
    console.warn('localStorage save failed:', e);
  }

  // save to disk via server API (appends to data/conversations.jsonl)
  fetch('/api/save-conversation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  }).catch(() => {}); // silent fail if server not available
}

export function getConversationArchive() {
  try {
    return JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]');
  } catch { return []; }
}

export async function getConversationArchiveFromDisk() {
  try {
    const resp = await fetch('/api/conversations');
    if (resp.ok) return resp.json();
  } catch { /* server unavailable — fall back to localStorage below */ }
  return getConversationArchive(); // fallback to localStorage
}

export function downloadConversationArchive() {
  // fetch from disk first, fallback to localStorage
  fetch('/api/conversations')
    .then(r => r.ok ? r.json() : getConversationArchive())
    .catch(() => getConversationArchive())
    .then(archive => {
      const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `village_conversations_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
}

export function downloadFullWorldState(gameState) {
  const data = {
    exportDate: new Date().toISOString(),
    people: gameState.people.map(p => ({
      name: p.name, gender: p.gender, age: p.age, alive: p.alive,
      traits: p.traits, values: p.values, background: p.background,
      mood: p.mood, partner: p.partner, children: p.children, parents: p.parents,
      skills: p.skills, inventory: p.inventory,
      memories: p.memories, conversationLog: p.conversationLog,
      relationships: Object.fromEntries(
        Object.entries(p.relationships).map(([name, r]) => [name, { stage: r.stage, affection: r.affection, trust: r.trust, attraction: r.attraction, familiarity: r.familiarity }])
      ),
      ambitions: p.ambitions,
    })),
    stats: gameState.stats,
    day: gameState.day, season: gameState.season,
    larder: gameState.larder,
    buildings: gameState.buildings,
    events: gameState.events.slice(-50),
  };

  // save to disk
  fetch('/api/save-world', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).catch(() => {});

  // also download
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `village_world_state_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
