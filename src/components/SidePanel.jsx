function topSkillOf(p) {
  let best = null, max = 8;
  for (const [k, v] of Object.entries(p.skills || {})) if (v > max) { max = v; best = k; }
  return best;
}

// Compact view of what this agent has learned pays off, by context.
function learnedRows(p) {
  if (!p.qValues) return [];
  return Object.entries(p.qValues)
    .map(([k, v]) => ({ ctx: k.split(':')[0], action: k.split(':')[1], v }))
    .filter(r => Math.abs(r.v) > 0.3)
    .sort((a, b) => b.v - a.v)
    .slice(0, 6);
}

export function SidePanel({ people, selectedPerson, onSelect, onFollow, following, activePower }) {
  const sel = selectedPerson !== null ? people[selectedPerson] : null;
  // when resurrecting, the dead become clickable targets (and are highlighted)
  const resurrecting = activePower === 'resurrect';

  return (
    <div className="side-panel">
      <div className="panel-section">
        <div className="section-label">Villagers ({people.length})</div>
        {resurrecting && <div className="resurrect-hint">🌟 Click a fallen villager (✝) to raise them</div>}
        {people.map((p, i) => (
          <div
            key={p.name}
            className={`villager-row ${selectedPerson === i ? 'selected' : ''} ${p.alive === false ? 'dead' : ''} ${resurrecting && p.alive === false ? 'revivable' : ''}`}
            onClick={() => {
              if (p.alive === false) { if (resurrecting) onSelect(i); return; }
              onSelect(selectedPerson === i ? null : i);
            }}
          >
            <div className="villager-dot" style={{ background: `#${p.color.toString(16).padStart(6, '0')}` }} />
            <span className="villager-name">
              {p.name}
              {p.alive === false && ' ✝'}
              {p.lifeStage === 'baby' && p.alive !== false && ' 👶'}
              {p.lifeStage === 'child' && p.alive !== false && ' 🧒'}
            </span>
            <span className="villager-mood">{p.alive !== false ? moodEmoji(p.mood) : '💀'}</span>
          </div>
        ))}
      </div>

      <div className="panel-detail">
        {sel ? (
          <>
            <div className="villager-title" style={{ color: `#${sel.color.toString(16).padStart(6, '0')}` }}>
              {sel.name}
            </div>
            <div className="villager-subtitle">
              {sel.gender}, age {sel.age} · {sel.lifeStage}
              {sel.partner && <span className="partner-tag"> · ❤ {sel.partner}</span>}
              {sel.pregnant && <span className="pregnant-tag"> · expecting</span>}
            </div>
            {sel.model && (
              <div className="villager-model" title="The LLM this villager thinks with" style={{ fontSize: 9, opacity: 0.55, marginTop: 2 }}>
                🧠 {sel.model.split('/').pop()}
              </div>
            )}

            <Stat label="Mood" value={sel.mood} emoji={moodEmoji(sel.mood)} />
            <Stat label="Activity" value={sel.sleeping ? '💤 sleeping' : sel.eating ? '🍎 eating' : sel.sick ? '🤒 sick' : sel.activity} />
            <Stat label="Location" value={sel.currentLocation} />
            {sel.larder && (
              <Stat label="Food" value={`🥩${sel.larder.meat || 0} 🐟${sel.larder.fish || 0} 🫐${sel.larder.berries || 0} 🌾${sel.larder.crops || 0}`} />
            )}
            {sel.inventory && (
              <Stat label="Materials" value={`🪵${sel.inventory.wood || 0} 🪨${sel.inventory.stone || 0} 🌿${sel.inventory.thatch || 0}`} />
            )}
            {sel.home && <Stat label="Home" value={`🏠 ${sel.home.type || 'shelter'}`} />}
            {topSkillOf(sel) && <Stat label="Known for" value={`⭐ ${topSkillOf(sel)}`} />}
            {sel.buildProject && sel.buildProject.phase !== 'complete' && (
              <div className="build-tag">🏗 Building: {sel.buildProject.type} ({sel.buildProject.phase})</div>
            )}
            {sel.techRole && <Stat label="Role" value={`🛠 ${sel.techRole}`} />}
            {sel.prototype && (
              <div className="build-tag" style={{ background: 'rgba(180,140,40,0.18)' }}>
                💡 Experimenting: {sel.prototype.label} — {Math.round((sel.prototype.progress || 0) * 100)}% (attempt, {sel.prototype.attemptsLeft} to go)
              </div>
            )}
            {sel.knownTech && Object.keys(sel.knownTech).length > 0 && (
              <Stat label="Knows how to make" value={Object.keys(sel.knownTech).length + ' invention(s)'} />
            )}
            {sel.noticedResources && Object.keys(sel.noticedResources).length > 0 && (
              <Stat label="Noticed" value={Object.keys(sel.noticedResources).join(', ')} />
            )}
            {sel.awe > 0 && <Stat label="Awe" value={`🌌 ${Math.round(sel.awe)}`} />}
            {sel.sick && <div className="sick-tag">🤒 Ill — recovering</div>}
            {sel.griefTimer > 0 && <div className="grief-tag">😢 Grieving {sel.griefTarget}</div>}

            <div className="section-label" style={{ marginTop: 8 }}>Needs</div>
            <NeedBar label="Hunger" value={sel.hunger} color="#e08040" icon="🍖" />
            <NeedBar label="Tiredness" value={sel.tiredness} color="#6060c0" icon="😴" />
            <NeedBar label="Loneliness" value={sel.loneliness} color="#8060a0" icon="💔" />

            <button className="follow-btn" onClick={() => onFollow && onFollow(people.indexOf(sel))}>
              {following === people.indexOf(sel) ? '📍 Following' : '👁 Follow'}
            </button>

            {sel.skills && Object.values(sel.skills).some(v => v > 0) && (
              <>
                <div className="section-label" style={{ marginTop: 8 }}>Skills</div>
                {Object.entries(sel.skills).filter(([,v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([skill, val]) => (
                  <RelBar key={skill} label={skill} value={val} color="#a0a060" />
                ))}
              </>
            )}

            {learnedRows(sel).length > 0 && (
              <>
                <div className="section-label" style={{ marginTop: 8 }}>Learned (what pays off)</div>
                {learnedRows(sel).map((r, i) => (
                  <div key={i} className="learned-row" style={{ fontSize: 10, color: r.v > 0 ? '#80c080' : '#c08080', padding: '1px 0' }}>
                    {r.action} <span style={{ opacity: 0.5 }}>({r.ctx})</span> {r.v > 0 ? '↑' : '↓'}{Math.abs(r.v).toFixed(1)}
                  </div>
                ))}
              </>
            )}

            <div className="section-label" style={{ marginTop: 8 }}>Personality</div>
            <div className="traits-list">
              {sel.traits.map(t => <span key={t} className="trait-tag">{t}</span>)}
            </div>

            {sel.thought && (
              <>
                <div className="section-label" style={{ marginTop: 8 }}>Thinking</div>
                <div className="thought-text">"{sel.thought}"</div>
              </>
            )}

            {sel.ambitions?.length > 0 && (
              <>
                <div className="section-label" style={{ marginTop: 8 }}>Ambitions</div>
                {sel.ambitions.map((a, i) => (
                  <div key={i} className={`ambition-entry ${a.completed ? 'completed' : ''}`}>
                    {a.completed ? '✅' : '⬜'} {a.label}
                  </div>
                ))}
              </>
            )}

            {sel.children?.length > 0 && (
              <>
                <div className="section-label" style={{ marginTop: 8 }}>Children</div>
                {sel.children.map(c => (
                  <div key={c} className="child-entry">👶 {c}</div>
                ))}
              </>
            )}

            {sel.memories?.length > 0 && (
              <>
                <div className="section-label" style={{ marginTop: 8 }}>Memories</div>
                <div className="memories-list">
                  {sel.memories.slice(-5).reverse().map((m, i) => (
                    <div key={i} className="memory-entry">
                      <span className="memory-day">D{m.day}</span>
                      <span className="memory-text">{m.text}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="section-label" style={{ marginTop: 8 }}>Relationships</div>
            {Object.entries(sel.relationships)
              .sort((a, b) => (b[1].affection + b[1].attraction) - (a[1].affection + a[1].attraction))
              .map(([name, rel]) => (
              <div key={name} className="relationship-card">
                <div className="rel-name">
                  {name}
                  <span className="rel-stage">{stageEmoji(rel.stage)} {rel.stage.replace('_', ' ')}</span>
                </div>
                <RelBar label="Affection" value={rel.affection} color="#e06080" />
                <RelBar label="Trust" value={rel.trust} color="#60a0e0" />
                <RelBar label="Attraction" value={rel.attraction} color="#e060d0" />
                <RelBar label="Familiarity" value={rel.familiarity} color="#60c080" />
                {rel.jealousy > 10 && <RelBar label="Jealousy" value={rel.jealousy} color="#40aa40" />}
              </div>
            ))}
          </>
        ) : (
          <div className="no-selection">Click a villager to inspect</div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, emoji }) {
  return (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{emoji ? `${emoji} ${value}` : value}</span>
    </div>
  );
}

function NeedBar({ label, value, color, icon }) {
  const critical = value > 70;
  return (
    <div className="need-bar-container">
      <div className="need-bar-header">
        <span>{icon} {label}</span>
        <span className={critical ? 'need-critical' : ''}>{Math.round(value)}</span>
      </div>
      <div className="need-bar-track">
        <div className="need-bar-fill" style={{ width: `${value}%`, background: color }} />
      </div>
    </div>
  );
}

function RelBar({ label, value, color }) {
  return (
    <div className="rel-bar-container">
      <div className="rel-bar-header">
        <span>{label}</span>
        <span>{Math.round(value)}</span>
      </div>
      <div className="rel-bar-track">
        <div className="rel-bar-fill" style={{ width: `${value}%`, background: color }} />
      </div>
    </div>
  );
}

function moodEmoji(mood) {
  const map = {
    happy: '😊', neutral: '😐', sad: '😢', excited: '😄', thoughtful: '🤔',
    anxious: '😰', flirty: '😏', annoyed: '😤', lonely: '🥺', content: '😌',
    jealous: '😠', heartbroken: '💔', loving: '🥰',
  };
  return map[mood] || '😐';
}

function stageEmoji(stage) {
  const map = {
    stranger: '❓', acquaintance: '👋', friend: '🤝', close_friend: '💛',
    attracted: '💕', dating: '💑', partnered: '💍', rival: '⚡', enemy: '🔥',
  };
  return map[stage] || '';
}
