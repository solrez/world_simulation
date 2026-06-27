import { useState, useEffect, useRef } from 'react';
import { GameRenderer } from './renderer/GameRenderer.js';
import { createSimulation, simulateTick, findConversationGroup, runConversation, runAIAction, downloadConversationArchive, downloadFullWorldState } from './engine/simulation.js';
import { perceive } from './engine/vision.js';
import { SidePanel } from './components/SidePanel.jsx';
import { ConversationLog } from './components/ConversationLog.jsx';
import { GodPowers, applyGodPower } from './components/GodPowers.jsx';
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

  const gameRef = useRef(initialState);
  const rendererRef = useRef(null);
  const pixiRef = useRef(null);
  const activeConvoCount = useRef(0);
  const selectedRef = useRef(null);

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
        setServerDown(false);
      } catch {
        // two consecutive misses to avoid halting on a transient hiccup
        if (++misses >= 2) setServerDown(true);
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
      const candidates = gameRef.current.people.filter(p =>
        p.pendingLLM && p.alive !== false && !p.conversationId && !p.sleeping && !p.eating &&
        p.lifeStage !== 'baby'
      );
      if (!candidates.length) return; // nothing interesting — no LLM call this round
      // oldest-flagged first (they've waited longest)
      const person = candidates[0];
      const idx = gameRef.current.people.indexOf(person);
      await runAIAction(gameRef, idx, ac.signal);
      if (!ac.signal.aborted) setGame({ ...gameRef.current });
    }, 2000 / speed); // can poll more often now that most rounds no-op
    return () => { ac.abort(); clearInterval(actionInterval); };
  }, [speed, paused, serverDown]);

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
    if (activePower) {
      handleGodPower(activePower, idx);
    } else {
      setSelectedPerson(selectedPerson === idx ? null : idx);
    }
  };

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
                ? matchmakeFirst !== null
                  ? `Matchmake: ${game.people[matchmakeFirst]?.name} + ? — click second villager`
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
        </div>

        <div className="right-panel">
          <SidePanel
            people={game.people}
            selectedPerson={selectedPerson}
            onSelect={handleSelectPerson}
            onFollow={handleFollow}
            following={following}
          />
          <GodPowers
            people={game.people}
            onUsePower={handleGodPower}
            activePower={activePower}
            onSelectPower={setActivePower}
          />
        </div>
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
