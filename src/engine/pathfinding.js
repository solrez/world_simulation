// Grid A* pathfinding so villagers route around water instead of walking
// through it. Operates on tile coordinates; callers convert to/from world.

import { MAP_W, MAP_H, TERRAIN } from '../utils/constants.js';

// Build a boolean walkable grid from terrain. Water is the only blocker today;
// add more tile types here if buildings/rocks ever become solid.
export function buildWalkableGrid(terrain) {
  const grid = [];
  for (let y = 0; y < MAP_H; y++) {
    const row = [];
    for (let x = 0; x < MAP_W; x++) {
      row.push(terrain[y][x].type !== TERRAIN.WATER);
    }
    grid.push(row);
  }
  return grid;
}

export function isWalkable(grid, x, y) {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false;
  return grid[y][x];
}

// Nearest walkable tile to (x,y) via a small spiral — used when a target lands
// on/near water so we still produce a reachable goal.
export function nearestWalkable(grid, x, y) {
  const cx = Math.round(x), cy = Math.round(y);
  if (isWalkable(grid, cx, cy)) return { x: cx, y: cy };
  for (let r = 1; r <= 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring only
        if (isWalkable(grid, cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy };
      }
    }
  }
  return null;
}

const key = (x, y) => y * MAP_W + x;
// 8-directional movement; diagonals cost ~1.414
const NEIGHBORS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414],
];

function heuristic(ax, ay, bx, by) {
  // octile distance (admissible for 8-way movement)
  const dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
  return (dx + dy) + (1.414 - 2) * Math.min(dx, dy);
}

// A* on the tile grid. Returns an array of {x,y} waypoints from start to goal
// (excluding the start tile), or null if unreachable. Goal/start are snapped to
// the nearest walkable tile if they fall on water.
export function findPath(grid, start, goal) {
  const s = nearestWalkable(grid, start.x, start.y);
  const g = nearestWalkable(grid, goal.x, goal.y);
  if (!s || !g) return null;
  if (s.x === g.x && s.y === g.y) return [];

  const open = [{ x: s.x, y: s.y, f: 0 }];
  const cameFrom = new Map();
  const gScore = new Map([[key(s.x, s.y), 0]]);
  const closed = new Set();

  while (open.length) {
    // pop lowest f (small grid → linear scan is fine)
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    const ck = key(cur.x, cur.y);
    if (cur.x === g.x && cur.y === g.y) return reconstruct(cameFrom, cur);
    if (closed.has(ck)) continue;
    closed.add(ck);

    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!isWalkable(grid, nx, ny)) continue;
      // prevent cutting diagonally through a water corner
      if (dx !== 0 && dy !== 0 && (!isWalkable(grid, cur.x + dx, cur.y) || !isWalkable(grid, cur.x, cur.y + dy))) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const tentative = (gScore.get(ck) ?? Infinity) + cost;
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        cameFrom.set(nk, cur);
        gScore.set(nk, tentative);
        open.push({ x: nx, y: ny, f: tentative + heuristic(nx, ny, g.x, g.y) });
      }
    }
  }
  return null; // unreachable
}

function reconstruct(cameFrom, end) {
  const path = [{ x: end.x, y: end.y }];
  let cur = end;
  while (cameFrom.has(key(cur.x, cur.y))) {
    cur = cameFrom.get(key(cur.x, cur.y));
    path.push({ x: cur.x, y: cur.y });
  }
  path.reverse();
  path.shift(); // drop the start tile
  return path;
}
