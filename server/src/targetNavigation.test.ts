import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { floorPlan, navigate, targetMap, orderTargetChecklist } from './targetNavigation.js';
import { isWalkable } from './pathfinding/astar.js';
import type { GroceryRow } from './db.js';

const row = (id: number, aisle: string | null, done = false): GroceryRow => ({
  id, name: String(id), aisle, status: done ? 'picked_up' : 'not_picked_up',
});

test('Target example starts at entrance, reaches all stops and stays on connected corridor cells', () => {
  const route = navigate(['E73', 'D74', 'B49']);
  assert.equal(route.stops.length, 3);
  assert.deepEqual(route.path[0], floorPlan.entrance);
  assert.deepEqual(new Set(route.stops.map(stop => stop.aisle)), new Set(['E73', 'D74', 'B49']));
  for (const stop of route.stops) assert(route.path.some(p => p[0] === stop.point[0] && p[1] === stop.point[1]));
  route.path.forEach((p, i) => {
    assert(isWalkable(targetMap.grid, p));
    if (i) assert.equal(Math.abs(p[0] - route.path[i - 1][0]) + Math.abs(p[1] - route.path[i - 1][1]), 1);
  });
  assert.equal(route.stops.find(stop => stop.aisle === 'E73')?.approximate, true);
  assert.equal(route.stops.find(stop => stop.aisle === 'B49')?.approximate, false);
});

test('same aisle grouped; completed items last; order matches navigation after pickup/add/delete', () => {
  let items = [row(1, 'B49'), row(2, 'E73'), row(3, ' e73 '), row(4, 'D74')];
  const check = () => {
    const route = navigate(items.filter(item => item.status !== 'picked_up').map(item => item.aisle));
    const ordered = orderTargetChecklist(items);
    assert.deepEqual([...new Set(ordered.filter(item => item.status !== 'picked_up').map(item => item.aisle!.trim().toUpperCase()))], route.stops.map(stop => stop.aisle));
    assert.equal(ordered.length, items.length);
    return route;
  };
  assert.equal(check().stops.length, 3);
  items[1].status = 'picked_up';
  assert(check().stops.some(stop => stop.aisle === 'E73'));
  items[2].status = 'picked_up';
  assert(!check().stops.some(stop => stop.aisle === 'E73'));
  assert.deepEqual(orderTargetChecklist(items).slice(-2).map(item => item.id), [2, 3]);
  items.push(row(5, 'B57')); assert.equal(check().stops.length, 3);
  items = []; assert.deepEqual(check().path, []);
});

test('unmapped/null and unreachable stops are reported; reachable stops remain available', () => {
  const map = { ...targetMap, aisles: { ...targetMap.aisles, ISOLATED: [0, 0] as [number, number] } };
  const result = navigate(['Unknown', null, 'ISOLATED', 'E73'], map);
  assert.deepEqual(result.stops.map(stop => stop.aisle), ['E73']);
  assert.deepEqual(result.skipped, [{ aisle: '', reason: 'unmapped' }, { aisle: 'ISOLATED', reason: 'unreachable' }, { aisle: 'UNKNOWN', reason: 'unmapped' }]);
  assert.deepEqual(navigate(['Unknown']).path, []);
  assert.deepEqual(navigate([]).stops, []);
});

test('supports all configured access points and over eight unique aisles without factorial search', () => {
  const aisles = Object.keys(floorPlan.aisles);
  const result = navigate(aisles);
  assert.equal(result.stops.length, aisles.length);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(navigate(Array(42).fill('E73')).stops.map(stop => stop.aisle), ['E73']);
});

test('stateless endpoints validate input and return image geometry and routes', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const handlers: Record<string, (req: any, res: any) => void> = {};
  vm.runInNewContext(source.slice(source.indexOf("app.get('/api/store-map'"), source.indexOf("app.get('/api/items'")), {
    app: { get: (url: string, fn: any) => { handlers[url] = fn; }, post: (url: string, fn: any) => { handlers[url] = fn; } }, floorPlan, navigate,
  });
  let code = 200, body: any;
  const res = { status(value: number) { code = value; return this; }, json(value: any) { body = value; } };
  handlers['/api/store-map']({}, res); assert.equal(body.width, 492);
  for (const aisles of [undefined, [3], Array(501).fill('E73'), ['x'.repeat(41)]]) {
    handlers['/api/navigation']({ body: { aisles } }, res); assert.equal(code, 400);
  }
  handlers['/api/navigation']({ body: { aisles: ['E73', 'D74', 'B49'] } }, res);
  assert.equal(body.stops.length, 3);
  for (const startAisle of [42, [], {}, 'x'.repeat(41)]) {
    handlers['/api/navigation']({ body: { aisles: ['D27'], startAisle } }, res);
    assert.equal(code, 400);
  }
  handlers['/api/navigation']({ body: { aisles: ['D27', 'MN50'], startAisle: 'E66' } }, res);
  assert.equal(body.start.aisle, 'E66');
  assert.deepEqual(body.path[0], floorPlan.aisles.E66);
});

class FakeNode {
  attrs: Record<string, any> = {}; children: FakeNode[] = []; textContent = ''; innerHTML = ''; dataset = {};
  listeners: Record<string, (event: any) => void> = {};
  setAttribute(key: string, value: any) { this.attrs[key] = value; }
  getAttribute(key: string) { return this.attrs[key]; }
  append(...nodes: FakeNode[]) { this.children.push(...nodes); }
  appendChild(node: FakeNode) { this.append(node); }
  replaceChildren() { this.children = []; }
  addEventListener(event: string, fn: any) { this.listeners[event] = fn; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { width: 492, height: 540 }; }
  setPointerCapture() {}
}

function createMapNodes(): Record<string, FakeNode> {
  const storeMap = new FakeNode(), storeMapImage = new FakeNode(), storeMapRoute = new FakeNode();
  storeMapImage.attrs = { href: floorPlan.image, width: floorPlan.width, height: floorPlan.height };
  storeMap.append(storeMapImage, storeMapRoute);
  return { storeMap, storeMapImage, storeMapRoute };
}

test('website draws red SVG line, clears on empty list, and shares image/overlay zoom coordinates', async () => {
  const nodes = createMapNodes();
  const getNode = (id: string) => nodes[id] ??= new FakeNode();
  const context = vm.createContext({ console: { error() {} }, window: {}, document: {
    getElementById: getNode, createElementNS: () => new FakeNode(),
  }, fetch: async (url: string, options?: any) => ({ ok: true, json: async () => url === '/api/store-map' ? floorPlan : navigate(JSON.parse(options.body).aisles) }) });
  vm.runInContext(readFileSync(new URL('../../web/js/store-navigation.js', import.meta.url), 'utf8'), context);
  await vm.runInContext(`window.StoreNavigation.update([{ name: 'Fork', aisle: 'E73' }, { name: 'Microwave', aisle: 'D74' }, { name: 'Banana', aisle: 'B49' }], () => {})`, context);
  const svg = getNode('storeMap'), layer = svg.children[1];
  assert.equal(svg.children[0].attrs.href, floorPlan.image);
  assert.equal(layer.children[1].attrs.stroke, '#dc0000');
  assert.equal(layer.children[1].attrs['stroke-width'], 4);
  assert.equal(layer.children.length, 5); // white halo + red line + three markers
  assert.match(getNode('mapStatus').textContent, /Next:.*3 aisle stops/);
  svg.listeners.wheel({ preventDefault() {}, deltaY: -1 });
  assert.notEqual(svg.attrs.viewBox, '0 0 492 540');
  assert.equal(svg.children[0].attrs.transform, undefined);
  await vm.runInContext(`window.StoreNavigation.update([], () => {})`, context);
  assert.equal(layer.children.length, 0);
  assert.match(getNode('mapStatus').textContent, /No mapped destinations/);
});

test('website checklist matches returned map order and groups completed rows at bottom', () => {
  const nodes = createMapNodes();
  const context = vm.createContext({ window: { StoreNavigation: { update(items: any[], callback: any) {
    callback(navigate(items.filter(item => !item.checked).map(item => item.aisle)));
  } } }, document: { addEventListener() {}, getElementById: (id: string) => nodes[id] ??= new FakeNode(), createElement: () => new FakeNode() }, localStorage: { setItem() {} } });
  vm.runInContext(readFileSync(new URL('../../web/js/app.js', import.meta.url), 'utf8'), context);
  vm.runInContext(`items = [{id:1,name:'Banana',aisle:'B49',checked:false},{id:2,name:'Fork',aisle:'E73',checked:true},{id:3,name:'Microwave',aisle:'D74',checked:false}]; renderList();`, context);
  assert.equal(vm.runInContext('items[items.length - 1].id', context), 2);
  assert.equal(vm.runInContext('items[0].stopNumber', context), 1);
  assert.equal(vm.runInContext('items[0].aisle', context), navigate(['B49', 'D74']).stops[0].aisle);
});

test('late navigation responses cannot overwrite newer checklist routes; failures clear the line', async () => {
  const nodes = createMapNodes();
  let resolveOld: (value: any) => void = () => {};
  let requests = 0;
  const context = vm.createContext({ console: { error() {} }, window: {}, document: {
    getElementById: (id: string) => nodes[id] ??= new FakeNode(), createElementNS: () => new FakeNode(),
  }, fetch: async (url: string) => {
    if (url === '/api/store-map') return { ok: true, json: async () => floorPlan };
    requests++;
    if (requests === 1) return { ok: true, json: () => new Promise(resolve => { resolveOld = resolve; }) };
    if (requests === 3) throw new Error('offline');
    return { ok: true, json: async () => navigate([]) };
  } });
  vm.runInContext(readFileSync(new URL('../../web/js/store-navigation.js', import.meta.url), 'utf8'), context);
  const old = vm.runInContext(`window.StoreNavigation.update([{aisle:'E73'}], () => { throw Error('stale callback'); })`, context);
  await new Promise(resolve => setImmediate(resolve));
  await vm.runInContext('window.StoreNavigation.update([], () => {})', context);
  resolveOld(navigate(['E73'])); await old;
  assert.equal(nodes.storeMap.children[1].children.length, 0);
  assert.match(nodes.mapStatus.textContent, /No mapped destinations/);
  await vm.runInContext('window.StoreNavigation.update([], () => {})', context);
  assert.match(nodes.mapStatus.textContent, /Navigation unavailable/);
  assert.equal(nodes.storeMap.children[1].children.length, 0);
});

test('missing map API retains floor plan and controls, reports restart action and retries safely', async () => {
  const nodes = createMapNodes();
  let available = false;
  const errors: unknown[] = [];
  const context = vm.createContext({ console: { error: (...args: unknown[]) => errors.push(args) }, window: {}, document: {
    getElementById: (id: string) => nodes[id] ??= new FakeNode(), createElementNS: () => new FakeNode(),
  }, fetch: async (url: string, options?: any) => ({ ok: available, status: available ? 200 : 404,
    json: async () => url === '/api/store-map' ? floorPlan : navigate(JSON.parse(options.body).aisles),
  }) });
  vm.runInContext(readFileSync(new URL('../../web/js/store-navigation.js', import.meta.url), 'utf8'), context);
  await vm.runInContext('window.StoreNavigation.update([], () => {})', context);
  assert.match(nodes.mapStatus.textContent, /Restart the Node server/);
  assert.equal(nodes.storeMap.children[0], nodes.storeMapImage);
  assert.equal(nodes.storeMapImage.attrs.href, floorPlan.image);
  assert.equal(errors.length, 1);
  (nodes.zoomIn as any).onclick(); assert.notEqual(nodes.storeMap.attrs.viewBox, '0 0 492 540');
  (nodes.resetMap as any).onclick(); assert.equal(nodes.storeMap.attrs.viewBox, '0 0 492 540');
  available = true;
  await vm.runInContext("window.StoreNavigation.update([{name:'Fork',aisle:'E73'}], () => {})", context);
  assert.equal(nodes.storeMap.children.length, 2); // no duplicated image/layer after retry
  assert.equal(nodes.storeMapRoute.children[1].attrs.stroke, '#dc0000');
});

test('current six-item checklist routes three supported stops and excludes unsupported aisles', () => {
  const input = ['B49', 'D74', 'D74', 'E73', 'UT50', 'D69'];
  const route = navigate(input);
  assert.equal(route.stops.length, 3);
  assert.equal(route.stops.filter(stop => stop.aisle === 'D74').length, 1);
  assert.deepEqual(route.skipped, [{ aisle: 'D69', reason: 'unmapped' }, { aisle: 'UT50', reason: 'unmapped' }]);
  route.path.forEach(p => assert(isWalkable(targetMap.grid, p)));
});
