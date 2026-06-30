// ── Terrain generation ──
// Builds the static tile map: a pond + stream water feature, dirt clearings and
// tilled plots at key locations, scattered wildflower meadows, and trodden paths
// connecting the village hubs. Pure function of the imported map constants.

import { LOCATIONS, MAP_W, MAP_H, TERRAIN } from '../utils/constants.js';

export function generateTerrain() {
  const map = [];
  const pond = LOCATIONS.POND;
  const fishing = LOCATIONS.FISHING_SPOT;
  // a meandering stream runs diagonally and feeds the pond — drawn as a sine
  // wave in x as it descends, giving the bigger map a natural water feature.
  const streamX = (y) => Math.round(pond.x - 6 + Math.sin(y * 0.4) * 3 - (MAP_H - y) * 0.15);
  for (let y = 0; y < MAP_H; y++) {
    const row = [];
    for (let x = 0; x < MAP_W; x++) {
      let type = TERRAIN.GRASS;
      // a larger pond centred on the POND location (radius scales with the map)
      const px = x - pond.x, py = y - pond.y;
      if (px * px + py * py < 14) type = TERRAIN.WATER;
      // a second smaller pool by the fishing spot
      const qx = x - fishing.x, qy = y - fishing.y;
      if (qx * qx + qy * qy < 5) type = TERRAIN.WATER;
      // the stream (only in the lower half so it reads as feeding the pond)
      if (y > MAP_H * 0.45 && y < pond.y && x === streamX(y)) type = TERRAIN.WATER;
      // dirt clearing at the campfire hub
      const dx = x - LOCATIONS.CAMPFIRE.x, dy = y - LOCATIONS.CAMPFIRE.y;
      if (Math.sqrt(dx * dx + dy * dy) < 2) type = TERRAIN.DIRT;
      // tilled field plot around the Field location
      const fx = x - LOCATIONS.FIELD.x, fy = y - LOCATIONS.FIELD.y;
      if (Math.abs(fx) <= 3 && Math.abs(fy) <= 2) type = TERRAIN.DIRT;
      // rocky/dirt ground around Rock Seat (where copper hides)
      const rx = x - LOCATIONS.ROCK_SEAT.x, ry = y - LOCATIONS.ROCK_SEAT.y;
      if (rx * rx + ry * ry < 8 && type === TERRAIN.GRASS) type = TERRAIN.DIRT;
      // wildflower meadows: denser near the Meadow location, sparse elsewhere
      const mx = x - LOCATIONS.MEADOW.x, my = y - LOCATIONS.MEADOW.y;
      const nearMeadow = mx * mx + my * my < 20;
      if (type === TERRAIN.GRASS) {
        if (nearMeadow && (x + y * 3) % 4 === 0) type = TERRAIN.FLOWERS;
        else if ((x + y * 7) % 17 === 0) type = TERRAIN.FLOWERS;
      }
      row.push({ type, variant: (x * 31 + y * 17) % 3 });
    }
    map.push(row);
  }
  const pathPairs = [
    [LOCATIONS.CAMPFIRE, LOCATIONS.WELL], [LOCATIONS.CAMPFIRE, LOCATIONS.TREE_GROVE],
    [LOCATIONS.CAMPFIRE, LOCATIONS.MEADOW], [LOCATIONS.WELL, LOCATIONS.POND],
    [LOCATIONS.CAMPFIRE, LOCATIONS.ROCK_SEAT], [LOCATIONS.CAMPFIRE, LOCATIONS.BERRY_BUSH],
    [LOCATIONS.WELL, LOCATIONS.FISHING_SPOT],
    [LOCATIONS.CAMPFIRE, LOCATIONS.FIELD],
    [LOCATIONS.BERRY_BUSH, LOCATIONS.MEADOW], [LOCATIONS.ROCK_SEAT, LOCATIONS.WELL],
  ];
  for (const [a, b] of pathPairs) {
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const ppx = Math.round(a.x + (b.x - a.x) * t);
      const ppy = Math.round(a.y + (b.y - a.y) * t);
      if (ppx >= 0 && ppx < MAP_W && ppy >= 0 && ppy < MAP_H && map[ppy][ppx].type !== TERRAIN.WATER)
        map[ppy][ppx].type = TERRAIN.PATH;
    }
  }
  return map;
}
