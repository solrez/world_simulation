export function SidePanel({ people, selectedPerson, onSelect, onFollow, following }) {
  const sel = selectedPerson !== null ? people[selectedPerson] : null;

  return (
    <div className="side-panel">
      <div className="panel-section">
        <div className="section-label">Villagers ({people.length})</div>
        {people.map((p, i) => (
          <div
            key={p.name}
            className={`villager-row ${selectedPerson === i ? 'selected' : ''} ${p.alive === false ? 'dead' : ''}`}
            onClick={() => p.alive !== false && onSelect(selectedPerson === i ? null : i)}
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

            <Stat label="Mood" value={sel.mood} emoji={moodEmoji(sel.mood)} />
            <Stat label="Activity" value={sel.sleeping ? '💤 sleeping' : sel.eating ? '🍎 eating' : sel.sick ? '🤒 sick' : sel.activity} />
            <Stat label="Location" value={sel.currentLocation} />
            {sel.inventory && (
              <Stat label="Inventory" value={`🍖${sel.inventory.food} 🪵${sel.inventory.wood || 0} 🪨${sel.inventory.stone || 0} 🌾${sel.inventory.thatch || 0}`} />
            )}
            {sel.buildProject && sel.buildProject.phase !== 'complete' && (
              <div className="build-tag">🏗 Building: {sel.buildProject.type} ({sel.buildProject.phase})</div>
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
                {Object.entries(sel.skills).filter(([,v]) => v > 0).map(([skill, val]) => (
                  <RelBar key={skill} label={skill} value={val} color="#a0a060" />
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
