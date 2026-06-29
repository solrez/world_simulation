import { useState, useEffect, useRef } from 'react';
import { GameRenderer } from './renderer/GameRenderer.js';
import { createSimulation, simulateTick, findConversationGroup, runConversation, runAIAction, runIdeation, downloadConversationArchive, downloadFullWorldState, spawnAvatar, despawnAvatar, moveAvatar, getAvatar, avatarSpeak, performAvatarMiracle } from './engine/simulation.js';
import { perceive } from './engine/vision.js';
import { ConversationLog } from './components/ConversationLog.jsx';
import { applyGodPower } from './components/GodPowers.jsx';
import { RightPanel } from './components/RightPanel.jsx';
import './App.css';

const initialState = createSimulation();

const larderTotal = (l) => l ? Math.round((l.meat || 0) + (l.fish || 0) + (l.berries || 0) + (l.crops || 0)) : 0;

function App() {
  const [game, setGame] = useState(initialState);
  const [selectedPerson, setSelectedPerson] = useState(null);
  const [speed, setSpeed] = useState(1);
  const [paused, setPaused] = useState(false);
  const [activePower, setActivePower] = useState(null);
  const [following, setFollowing] = useState(null);
  const [matchmakeFirst, setMatchmakeFirst] = useState(null);
  // true once the dev server stops responding (e.g. Ctrl+C) — halts the sim
  const [serverDown, setServerDown] = useState(false);
  // {x,y} tile the player clicked to inspect for discovered resources (Phase 6)
  const [inspectedTile, setInspectedTile] = useState(null);
  // god avatar: whether one is active, and the in-progress chat draft
  const [avatarActive, setAvatarActive] = useState(false);
  const [avatarDraft, setAvatarDraft] = useState('');
  const keysRef = useRef({}); // held movement keys for the avatar
  // whisper: when set, shows a text box to type the divine words for this target idx
  const [whisperTarget, setWhisperTarget] = useState(null);
  const [whisperDraft, setWhisperDraft] = useState('');

  const gameRef = useRef(initialState);
  const rendererRef = useRef(null);
  const pixiRef = useRef(null);
  const activeConvoCount = useRef(0);
  const aiBusy = useRef(false); // guards the AI-action interval against overlap
  const selectedRef = useRef(null);
  // always-current selection handler so the renderer's once-bound click callback
  // calls the latest version (it closes over activePower/matchmake state).
  const handleSelectRef = useRef(null);

  useEffect(() => { selectedRef.current = selectedPerson; }, [selectedPerson]);

  useEffect(() => {
    gameRef.current = { ...gameRef.current, speed };
  }, [speed]);

  // heartbeat: if the dev server stops answering (Ctrl+C), halt the sim so the
  // browser tab doesn't keep running and calling the AI on its own.
  useEffect(() => {
    let misses = 0;
    const beat = async () => {
      try {
        const r = await fetch('/api/ping', { cache: 'no-store' });
        if (!r.ok) throw new Error('bad status');
        misses = 0;
        // only flip state on a recovery transition, not on every healthy ping
        setServerDown((down) => (down ? false : down));
      } catch {
        // two consecutive misses to avoid halting on a transient hiccup
        if (++misses >= 2) setServerDown((down) => (down ? down : true));
      }
    };
    beat();
    const id = setInterval(beat, 4000);
    return () => clearInterval(id);
  }, []);

  // pixi init
  useEffect(() => {
    if (!pixiRef.current) return;
    const renderer = new GameRenderer();
    rendererRef.current = renderer;
    let destroyed = false;
    const initRenderer = async () => {
      try {
        await renderer.init(pixiRef.current);
        if (destroyed) return;
        renderer.buildTerrain(gameRef.current.terrain);
        renderer.updateCharacters(gameRef.current.people);
        renderer.onTileClick = (tx, ty) => setInspectedTile({ x: tx, y: ty });
        // click a villager on the map → select them (handles god-power targeting too)
        renderer.onVillagerClick = (person) => {
          const idx = gameRef.current.people.indexOf(person);
          if (idx >= 0) handleSelectRef.current(idx);
        };
      } catch (e) { console.error('PixiJS init failed:', e); }
    };
    initRenderer();
    return () => { destroyed = true; renderer.destroy(); };
  }, []);

  // simulation tick
  useEffect(() => {
    if (serverDown) return;
    const interval = setInterval(() => {
      if (paused) return;
      const next = simulateTick(gameRef.current);
      gameRef.current = next;
      setGame({ ...next });

      if (rendererRef.current) {
        rendererRef.current.updateBuildings(next.buildings, next.people);
        rendererRef.current.updateCharacters(next.people);
        rendererRef.current.updateWildlife(next.wildlife);
        rendererRef.current.updateBubbles(next.activeConversations, next.people);
        rendererRef.current.updateCampfire();
        rendererRef.current.updateField(next.field);
        rendererRef.current.updateResourceNodes(next.resourceNodes);
        rendererRef.current.updateEnvironment(next);
        rendererRef.current.updateDayNight(next.timeOfDay, next.hour + next.minute / 60);
        rendererRef.current.updateWeather(next.weather);
        rendererRef.current.updateTrails(next.people);
        rendererRef.current.drawTrails();

        // follow camera
        if (following !== null) {
          const person = next.people[following];
          if (person && person.alive !== false) rendererRef.current.followPerson(person);
        }

        // vision overlay for the focused person (followed, else selected)
        const focusIdx = following !== null ? following : selectedRef.current;
        const focus = focusIdx !== null && focusIdx !== undefined ? next.people[focusIdx] : null;
        if (focus && focus.alive !== false) {
          const view = perceive(focus, next);
          rendererRef.current.drawSight(focus, view.radius, view.animals);
        } else {
          rendererRef.current.clearSight();
        }
      }
    }, 400 / speed);
    return () => clearInterval(interval);
  }, [speed, paused, following, serverDown]);

  // conversations
  useEffect(() => {
    if (paused || serverDown) return;
    const ac = new AbortController();
    const tryConvo = async () => {
      if (ac.signal.aborted || activeConvoCount.current >= 2) return;
      const group = findConversationGroup(gameRef.current.people);
      if (!group) return;
      activeConvoCount.current++;
      try {
        await runConversation(gameRef, group, () => {
          setGame({ ...gameRef.current });
          if (rendererRef.current) {
            rendererRef.current.updateCharacters(gameRef.current.people);
            rendererRef.current.updateBubbles(gameRef.current.activeConversations, gameRef.current.people);
          }
        }, ac.signal);
      } finally { activeConvoCount.current--; }
    };
    const convoInterval = setInterval(tryConvo, 4000 / speed);
    return () => { ac.abort(); clearInterval(convoInterval); };
  }, [speed, paused, serverDown]);

  // AI actions — the escalation gate flags who is "interesting" (pendingLLM);
  // we spend an LLM call only on them. When nobody is flagged, zero calls.
  useEffect(() => {
    if (paused || serverDown) return;
    const ac = new AbortController();
    const actionInterval = setInterval(async () => {
      if (ac.signal.aborted) return;
      // skip if a previous round's call is still in flight — otherwise a slow AI
      // call (near the 20s timeout) would let rounds stack up every 2s.
      if (aiBusy.current) return;
      const awake = p => p.alive !== false && !p.conversationId && !p.sleeping && !p.eating && p.lifeStage !== 'baby';
      // Ideation (Phase 3) gets first pick — it's rare and time-sensitive (a
      // frustrated, inventive moment). Falls through to normal actions otherwise.
      const ideators = gameRef.current.people.filter(p => p.pendingIdea && awake(p));
      aiBusy.current = true;
      try {
        if (ideators.length) {
          const idx = gameRef.current.people.indexOf(ideators[0]);
          await runIdeation(gameRef, idx, ac.signal);
          if (!ac.signal.aborted) setGame({ ...gameRef.current });
          return;
        }
        const candidates = gameRef.current.people.filter(p => p.pendingLLM && awake(p));
        if (!candidates.length) return; // nothing interesting — no LLM call this round
        // oldest-flagged first (they've waited longest)
        const person = candidates[0];
        const idx = gameRef.current.people.indexOf(person);
        await runAIAction(gameRef, idx, ac.signal);
        if (!ac.signal.aborted) setGame({ ...gameRef.current });
      } finally {
        aiBusy.current = false;
      }
    }, 2000 / speed); // can poll more often now that most rounds no-op
    return () => { ac.abort(); clearInterval(actionInterval); };
  }, [speed, paused, serverDown]);

  // ── God avatar: keyboard movement ──
  // While an avatar is active, WASD / arrow keys drive it around the map. We track
  // held keys and apply movement on a fast interval so motion is smooth. Keys are
  // ignored while typing in the chat box (so you can write 'w' without walking).
  useEffect(() => {
    if (!avatarActive) return;
    const isTyping = () => document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';
    const down = (e) => {
      if (isTyping()) return;
      const k = e.key.toLowerCase();
      if (['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(k)) {
        keysRef.current[k] = true; e.preventDefault();
      }
    };
    const up = (e) => { keysRef.current[e.key.toLowerCase()] = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    const move = setInterval(() => {
      const k = keysRef.current;
      let dx = 0, dy = 0;
      const step = 0.35;
      if (k['w'] || k['arrowup']) dy -= step;
      if (k['s'] || k['arrowdown']) dy += step;
      if (k['a'] || k['arrowleft']) dx -= step;
      if (k['d'] || k['arrowright']) dx += step;
      if (dx || dy) {
        moveAvatar(gameRef.current, dx, dy);
        const a = getAvatar(gameRef.current);
        if (a && rendererRef.current) rendererRef.current.followPerson(a);
        setGame({ ...gameRef.current });
      }
    }, 60);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); clearInterval(move); keysRef.current = {}; };
  }, [avatarActive]);

  // spawn / despawn the avatar
  const handleSpawnAvatar = (divine) => {
    gameRef.current = spawnAvatar(gameRef.current, { divine });
    setAvatarActive(true);
    setGame({ ...gameRef.current });
    const a = getAvatar(gameRef.current);
    if (a && rendererRef.current) rendererRef.current.followPerson(a);
  };
  const handleDespawnAvatar = () => {
    // despawnAvatar now handles convo cleanup + releasing listeners + the
    // villagers' "the stranger is gone" reaction, so call it directly.
    gameRef.current = despawnAvatar(gameRef.current);
    setAvatarActive(false);
    setAvatarDraft('');
    setGame({ ...gameRef.current });
  };

  // send the avatar's typed line → nearby villagers hear and reply
  const avatarSpeakRef = useRef(false);
  const handleAvatarSpeak = async () => {
    const text = avatarDraft.trim();
    if (!text || avatarSpeakRef.current) return;
    avatarSpeakRef.current = true;
    setAvatarDraft('');
    try {
      // avatarSpeak takes the gameRef object (it reads/reassigns gameRef.current),
      // NOT the state snapshot — passing .current made it operate on undefined.
      await avatarSpeak(gameRef, text, () => {
        setGame({ ...gameRef.current });
        if (rendererRef.current) rendererRef.current.updateBubbles(gameRef.current.activeConversations, gameRef.current.people);
      });
    } catch (e) {
      console.error('avatarSpeak failed:', e);
    } finally { avatarSpeakRef.current = false; }
  };

  // perform a visible miracle as the avatar — proof for villagers who doubt you
  const handleAvatarMiracle = () => {
    const n = performAvatarMiracle(gameRef);
    setGame({ ...gameRef.current });
    if (rendererRef.current) {
      rendererRef.current.updateCharacters(gameRef.current.people);
      rendererRef.current.updateBubbles(gameRef.current.activeConversations, gameRef.current.people);
    }
    if (n === 0) console.log('No one nearby witnessed the miracle.');
  };

  // god power handler
  const handleGodPower = (powerId, targetIdx) => {
    applyGodPower(powerId, targetIdx, gameRef);
    setGame({ ...gameRef.current });
    setActivePower(null);
  };

  // villager click — either apply power or select
  const handleSelectPerson = (idx) => {
    if (activePower === 'matchmake') {
      if (matchmakeFirst === null) {
        setMatchmakeFirst(idx);
      } else if (matchmakeFirst !== idx) {
        applyGodPower('matchmake_pair', { a: matchmakeFirst, b: idx }, gameRef);
        setGame({ ...gameRef.current });
        setActivePower(null);
        setMatchmakeFirst(null);
      }
      return;
    }
    if (activePower === 'whisper') {
      // open a box to type the divine words instead of applying immediately
      setWhisperTarget(idx);
      setWhisperDraft('');
      setActivePower(null);
      return;
    }
    if (activePower) {
      handleGodPower(activePower, idx);
    } else {
      setSelectedPerson(selectedPerson === idx ? null : idx);
    }
  };

  const handleSendWhisper = () => {
    const text = whisperDraft.trim();
    if (whisperTarget === null) return;
    applyGodPower('whisper', whisperTarget, gameRef, { text });
    setGame({ ...gameRef.current });
    setWhisperTarget(null);
    setWhisperDraft('');
  };
  // keep the renderer's once-bound click callback pointing at the latest handler
  useEffect(() => { handleSelectRef.current = handleSelectPerson; });

  // follow toggle
  const handleFollow = (idx) => {
    if (following === idx) {
      setFollowing(null);
      if (rendererRef.current) rendererRef.current._followTarget = null;
    } else {
      setFollowing(idx);
    }
  };

  const timeStr = `${String(game.hour).padStart(2, '0')}:${String(game.minute).padStart(2, '0')}`;
  const aliveCount = game.people.filter(p => p.alive !== false).length;

  return (
    <div className="app">
      <div className="header">
        <div className="header-left">
          <span className="title">Village Life</span>
          <span className="sep">|</span>
          <span className="header-stat">Day {game.day}</span>
          <span className="sep">·</span>
          <span className="header-stat">{timeStr}</span>
          <span className="sep">·</span>
          <span className="header-era">{game.timeOfDay}</span>
          <span className="sep">·</span>
          <span className={`header-stat ${game.weather !== 'clear' ? 'weather-active' : 'dim'}`}>
            {game.weather === 'storm' ? '⛈ storm' : game.weather === 'rainy' ? '🌧 rain' : game.weather === 'cloudy' ? '☁ cloudy' : '☀ clear'}
          </span>
          <span className="sep">·</span>
          <span className="header-stat dim">{aliveCount} alive</span>
          <span className="sep">·</span>
          <span className="header-stat">{game.season}</span>
          <span className="sep">·</span>
          <span className={`header-stat ${larderTotal(game.larder) < 10 ? 'food-critical' : ''}`}>🍖 {larderTotal(game.larder)}</span>
          <span className="sep">·</span>
          <span className="header-stat dim" title="Field crop status">
            🌾 {!game.field?.planted ? 'fallow' : game.field.stage >= 1 ? 'ripe!' : `${Math.round(game.field.stage * 100)}%`}
          </span>
        </div>
        <div className="header-right">
          <button className="hdr-btn export-btn" onClick={() => downloadConversationArchive()} title="Download all conversations as JSON">
            💬
          </button>
          <button className="hdr-btn export-btn" onClick={() => downloadFullWorldState(game)} title="Download full world state as JSON">
            🌍
          </button>
          <button className="hdr-btn" onClick={() => setPaused(!paused)}>
            {paused ? '▶ Play' : '⏸ Pause'}
          </button>
          {[1, 2, 3].map(s => (
            <button key={s} className={`hdr-btn ${speed === s ? 'active' : ''}`} onClick={() => setSpeed(s)}>
              {s}x
            </button>
          ))}
        </div>
      </div>

      <div className="main-area">
        <div className="map-container">
          <div className="pixi-container" ref={pixiRef} />
          {serverDown && (
            <div className="server-down-banner">
              ⏸ Dev server stopped — simulation halted. Restart <code>npm run dev</code> and reload.
            </div>
          )}
          {activePower && (
            <div className="god-power-indicator">
              {activePower === 'matchmake'
                ? matchmakeFirst !== null && game.people[matchmakeFirst]
                  ? `Matchmake: ${game.people[matchmakeFirst].name} + ? — click second villager`
                  : 'Matchmake: click first villager'
                : `Using: ${activePower} — click a villager`}
              <span className="cancel-link" onClick={() => { setActivePower(null); setMatchmakeFirst(null); }}> (cancel)</span>
            </div>
          )}
          {following !== null && (
            <div className="follow-indicator">
              Following: {game.people[following]?.name}
              <span className="cancel-link" onClick={() => setFollowing(null)}> (stop)</span>
            </div>
          )}

          {/* whisper composer — type the divine words for the chosen villager */}
          {whisperTarget !== null && (
            <div className="whisper-box">
              <div className="whisper-title">💭 Whisper to {game.people[whisperTarget]?.name}</div>
              <input
                className="whisper-input"
                autoFocus
                placeholder="The words you breathe into their mind…"
                value={whisperDraft}
                onChange={(e) => setWhisperDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSendWhisper(); if (e.key === 'Escape') { setWhisperTarget(null); setWhisperDraft(''); } }}
              />
              <div className="whisper-actions">
                <button className="hdr-btn" onClick={handleSendWhisper}>Whisper</button>
                <span className="cancel-link" onClick={() => { setWhisperTarget(null); setWhisperDraft(''); }}>cancel</span>
              </div>
            </div>
          )}

          {/* god avatar HUD — spawn, walk (WASD), and speak to villagers */}
          {!avatarActive ? (
            <div className="avatar-spawn">
              <span className="avatar-spawn-label">Walk among them:</span>
              <button className="hdr-btn" onClick={() => handleSpawnAvatar(false)} title="Appear as a mysterious stranger">🧍 Stranger</button>
              <button className="hdr-btn" onClick={() => handleSpawnAvatar(true)} title="Descend as an obvious deity">✨ Deity</button>
            </div>
          ) : (
            <div className="avatar-hud">
              <div className="avatar-hud-title">
                {getAvatar(game)?.divine ? '✨ Walking as a deity' : '🧍 Walking as a stranger'}
                <span className="avatar-move-hint"> · WASD / arrows to move</span>
                <span className="cancel-link" onClick={handleDespawnAvatar}> · leave</span>
              </div>
              <div className="avatar-chat">
                <input
                  className="avatar-input"
                  placeholder="Say something to those nearby… (Enter)"
                  value={avatarDraft}
                  onChange={(e) => setAvatarDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAvatarSpeak(); }}
                />
                <button className="hdr-btn" onClick={handleAvatarSpeak}>Speak</button>
                <button className="hdr-btn miracle-btn" onClick={handleAvatarMiracle} title="Perform a visible miracle for nearby villagers — proof of what you are">🌟 Miracle</button>
              </div>
            </div>
          )}
        </div>

        <RightPanel
          game={game}
          people={game.people}
          selectedPerson={selectedPerson}
          onSelect={handleSelectPerson}
          onFollow={handleFollow}
          following={following}
          inspectedTile={inspectedTile}
          onClearTile={() => setInspectedTile(null)}
          onUsePower={handleGodPower}
          activePower={activePower}
          onSelectPower={setActivePower}
        />
      </div>

      <ConversationLog
        activeConversations={game.activeConversations}
        pastConversations={game.conversations}
        people={game.people}
        events={game.events}
      />
    </div>
  );
}

export default App;
