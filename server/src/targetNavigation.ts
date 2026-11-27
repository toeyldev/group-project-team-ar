import { readFileSync } from 'node:fs';
import { findPath, type Point } from './pathfinding/astar.js';
import type { StoreMap } from './pathfinding/storeMap.js';
import type { GroceryRow } from './db.js';

type FloorPlan = {
  name: string; width: number; height: number; image: string; entrance: Point;
  corridors: Point[][]; aisles: Record<string, Point>; approximate: string[]; notice: string;
};
export const floorPlan = JSON.parse(readFileSync(new URL('../data/target_store_map.json', import.meta.url), 'utf8')) as FloorPlan;

export function buildNavigationMap(plan: FloorPlan): StoreMap {
  const grid = Array.from({ length: plan.height }, () => Array<number>(plan.width).fill(1));
  for (const line of plan.corridors) {
    for (let i = 1; i < line.length; i++) {
      const [a, b] = [line[i - 1], line[i]];
      if (a[0] !== b[0] && a[1] !== b[1]) throw new Error('Corridors must be axis aligned');
      const distance = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
      for (let step = 0; step <= distance; step++) {
        const x = a[0] + Math.sign(b[0] - a[0]) * step;
        const y = a[1] + Math.sign(b[1] - a[1]) * step;
        if (!grid[y] || x < 0 || x >= plan.width) throw new Error('Corridor outside image');
        grid[y][x] = 0;
      }
    }
  }
  return { name: plan.name, grid, entrance: plan.entrance, checkout: plan.entrance, aisles: plan.aisles };
}
export const targetMap = buildNavigationMap(floorPlan);
export const normalizeAisle = (aisle: string | null) => (aisle ?? '').trim().toUpperCase();

/** Deterministic nearest-neighbor itinerary measured by A*, never straight-line distance. */
export function resolveNavigationStart(startAisle: string | null = null, map = targetMap) {
  const aisle = normalizeAisle(startAisle);
  const point = Object.hasOwn(map.aisles, aisle) ? map.aisles[aisle] : null;
  return point && findPath(map.grid, map.entrance, point)
    ? { aisle, point }
    : { aisle: null, point: map.entrance };
}

export function navigate(aisleIds: (string | null)[], map = targetMap, startAisle: string | null = null) {
  const start = resolveNavigationStart(startAisle, map);
  const pending = [...new Set(aisleIds.map(normalizeAisle))].sort();
  const skipped: { aisle: string; reason: string }[] = [];
  const remaining = pending.filter(aisle => {
    const reason = !Object.hasOwn(map.aisles, aisle) ? 'unmapped' :
      !findPath(map.grid, start.point, map.aisles[aisle]) ? 'unreachable' : '';
    if (reason) skipped.push({ aisle, reason });
    return !reason;
  });
  let at = start.point;
  const path: Point[] = [];
  const stops: { aisle: string; point: Point; approximate: boolean }[] = [];
  while (remaining.length) {
    const legs = remaining.map(aisle => ({ aisle, path: findPath(map.grid, at, map.aisles[aisle])! }));
    legs.sort((a, b) => a.path.length - b.path.length || a.aisle.localeCompare(b.aisle));
    const leg = legs[0];
    if (!path.length) path.push(at);
    path.push(...leg.path.slice(1));
    at = map.aisles[leg.aisle];
    stops.push({ aisle: leg.aisle, point: at, approximate: floorPlan.approximate.includes(leg.aisle) });
    remaining.splice(remaining.indexOf(leg.aisle), 1);
  }
  return { start, path, stops, skipped, totalSteps: Math.max(0, path.length - 1) };
}

export function orderTargetChecklist(items: readonly GroceryRow[], startAisle: string | null = null): GroceryRow[] {
  const route = navigate(items.filter(item => item.status !== 'picked_up').map(item => item.aisle), targetMap, startAisle);
  const order = route.stops.map(stop => stop.aisle);
  return [...items.filter(item => item.status !== 'picked_up').sort((a, b) => {
    const rank = (aisle: string | null) => { const i = order.indexOf(normalizeAisle(aisle)); return i < 0 ? order.length : i; };
    return rank(a.aisle) - rank(b.aisle);
  }), ...items.filter(item => item.status === 'picked_up')];
}
