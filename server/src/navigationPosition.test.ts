import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { floorPlan, navigate, orderTargetChecklist, resolveNavigationStart, targetMap } from './targetNavigation.js';
import { findPath, isWalkable } from './pathfinding/astar.js';
import type { GroceryRow } from './db.js';

const example = ['E66', 'D27', 'D36', 'B39', 'MN50'];
test('A* routes from entrance then E66 and D27, with matching checklist order and no entrance detour', () => {
  assert.deepEqual(navigate(example).start, { aisle: null, point: floorPlan.entrance });
  for (const from of ['E66', 'D27']) {
    const remaining = example.filter(aisle => aisle !== from);
    const route = navigate(remaining, targetMap, from);
    assert.deepEqual(route.start, { aisle: from, point: floorPlan.aisles[from] });
    assert.deepEqual(route.path[0], floorPlan.aisles[from]);
    assert(!route.path.some(p => p[0] === floorPlan.entrance[0] && p[1] === floorPlan.entrance[1]));
    route.path.forEach(p => assert(isWalkable(targetMap.grid, p)));
    // First stop is chosen using actual A* distance, not a fixed example order.
    const lengths = route.stops.map(stop => findPath(targetMap.grid, route.start.point, stop.point)!.length);
    assert.equal(lengths[0], Math.min(...lengths));
    const rows: GroceryRow[] = remaining.map((aisle, id) => ({ id, name: aisle, aisle, status: 'not_picked_up' }));
    const ordered = orderTargetChecklist(rows, from).filter(row => row.aisle !== 'MN50');
    assert.deepEqual(ordered.map(row => row.aisle), route.stops.map(stop => stop.aisle));
  }
  assert.deepEqual(navigate([], targetMap, 'D27').path, []);
  assert.deepEqual(navigate(['D27', 'D27'], targetMap, 'D27').path, [floorPlan.aisles.D27]);
  assert.equal(navigate(example, targetMap, 'MN50').start.aisle, null);
  const isolated = { ...targetMap, aisles: { ...targetMap.aisles, ISOLATED: [0, 0] as [number, number] } };
  assert.equal(navigate(example, isolated, 'ISOLATED').start.aisle, null);
});

class Node {
  attrs: Record<string, any> = {}; children: Node[] = []; dataset = {}; classList = { toggle() {} }; value = ''; textContent = ''; innerHTML = ''; className = '';
  events: Record<string, (...args: any[]) => any> = {};
  setAttribute(key: string, value: any) { this.attrs[key] = value; }
  getAttribute(key: string) { return this.attrs[key]; }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  appendChild(node: Node) { this.append(node); }
  replaceChildren() { this.children = []; }
  addEventListener(name: string, callback: any) { this.events[name] = callback; }
  querySelectorAll() { return []; }
}
const source = (file: string) => readFileSync(new URL(`../../web/js/${file}`, import.meta.url), 'utf8');
type FakeServer = { position: string | null };
async function browser(server: FakeServer = { position: null }) {
  const storage = new Map<string, string>();
  const nodes: Record<string, Node> = {};
  const node = (id: string) => nodes[id] ??= new Node();
  node('storeMapImage').attrs = { href: floorPlan.image, width: floorPlan.width, height: floorPlan.height };
  let domReady = async () => {};
  const requests: { url: string; body: any }[] = [];
  const pickups: string[] = [];
  let failPatch = false, failRefresh = false;
  const rows: GroceryRow[] = ['Wine glass', 'Laptop', 'Mouse', 'Cake', 'Tie', 'Laptop'].map((name, i) => ({
    id: i + 1, name, aisle: ['E66', 'D27', 'D36', 'B39', 'MN50', 'D27'][i], status: 'not_picked_up',
  }));
  // Same rule as PATCH /api/items/:id: a pickup in a mapped aisle moves the shared position.
  const pickUp = (id: number, status: GroceryRow['status']) => {
    const row = rows.find(row => row.id === id)!;
    row.status = status;
    const start = resolveNavigationStart(row.aisle);
    if (status === 'picked_up' && start.aisle) server.position = start.aisle;
    return row;
  };
  const context = vm.createContext({ console: { error() {} }, window: { setInterval() {} }, document: {
    getElementById: node, createElement: () => new Node(), createElementNS: () => new Node(),
    addEventListener(_event: string, callback: any) { domReady = callback; },
  }, localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  alert() {}, fetch: async (url: string, options?: any) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    requests.push({ url, body });
    let value: unknown;
    if (url === '/api/health') value = { ok: true };
    else if (url === '/api/store-map') value = floorPlan;
    else if (url === '/api/navigation') {
      value = navigate(body.aisles, targetMap, body.startAisle);
      if (body.aisles.length === 0 && body.startAisle) pickups.push(body.startAisle);
    } else if (url === '/api/trip' && options?.method === 'DELETE') {
      server.position = null;
      return { ok: true, json: async () => null };
    } else if (options?.method === 'PATCH') {
      if (failPatch) return { ok: false };
      value = pickUp(Number(url.split('/').pop()), body.status);
    } else if (url === '/api/items') {
      if (failRefresh) throw new Error('refresh failed');
      value = orderTargetChecklist(rows, server.position);
      const header = server.position ?? '';
      return { ok: true, headers: { get: (name: string) => name === 'X-Trip-Start-Aisle' ? header : null }, json: async () => structuredClone(value) };
    } else throw new Error(`Unexpected request ${url}`);
    return { ok: true, headers: { get: () => null }, json: async () => structuredClone(value) };
  } });
  vm.runInContext(source('store-navigation.js'), context);
  vm.runInContext(source('app.js'), context);
  await domReady();
  const run = (code: string) => vm.runInContext(code, context);
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
  await flush();
  return { run, flush, nodes, requests, pickups, storage, server, rows, pickUp, failPatch: () => { failPatch = true; }, failRefresh: () => { failRefresh = true; } };
}

test('pickup events save position on the server, reorder from that aisle, and retain it for duplicate/unsupported/uncheck/delete/add', async () => {
  const b = await browser();
  assert.equal(b.run('window.StoreNavigation.getStartAisle()'), null);
  await b.run('toggleCheck(1)'); await b.flush();
  assert.equal(b.run('window.StoreNavigation.getStartAisle()'), 'E66');
  assert.equal(b.nodes.navigationStart.attrs.cx, floorPlan.aisles.E66[0]);
  assert.equal(b.nodes.navigationStart.attrs.cy, floorPlan.aisles.E66[1]);
  assert.match(b.nodes.navigationStartLabel.textContent, /E66/);
  assert.equal(b.nodes.storeMapRoute.children[1].attrs.points.split(' ')[0], floorPlan.aisles.E66.join(','));
  assert.equal(b.server.position, 'E66');
  assert(b.requests.every(req => !req.url.includes('startAisle')), 'the website no longer sends its own position');
  await b.run('toggleCheck(2)'); await b.flush();
  assert.equal(b.run('window.StoreNavigation.getStartAisle()'), 'D27');
  // A pending duplicate at the current point keeps its stop number visible above the start marker.
  const nextMarker = b.nodes.storeMapRoute.children[2].children.find(node => node.attrs.r === 7)!;
  assert.notEqual(nextMarker.attrs.cy, floorPlan.aisles.D27[1]);
  await b.run('toggleCheck(6)'); // same aisle
  await b.run('toggleCheck(5)'); // unsupported MN50
  await b.run('toggleCheck(1)'); // uncheck old item
  await b.flush();
  assert.equal(b.run('window.StoreNavigation.getStartAisle()'), 'D27');
  b.run('apiOnline=false'); // Remaining UI operations need no mocked database mutations.
  await b.run('clearChecked()'); await b.run('deleteItem(1)');
  await b.run("addItem('Fork')"); await b.flush();
  assert.equal(b.run('window.StoreNavigation.getStartAisle()'), 'D27');
  assert.equal([...b.requests].reverse().find(req => req.url === '/api/navigation')!.body.startAisle, 'D27');
  const displayed = JSON.parse(b.run('JSON.stringify(activeItems().filter(i=>!i.checked).map(i=>i.aisle))'));
  const expected = navigate(displayed, targetMap, 'D27');
  assert.deepEqual(displayed, expected.stops.map(stop => stop.aisle));
  // A fresh page (or another device) gets the position from the server, not from browser storage.
  const reloaded = await browser(b.server);
  assert.equal(reloaded.run('window.StoreNavigation.getStartAisle()'), 'D27');
  assert.match(reloaded.nodes.navigationStartLabel.textContent, /D27/);
  assert(![...b.storage.keys(), ...reloaded.storage.keys()].some(key => key.includes('position')));
  await reloaded.nodes.newTrip.events.click(); await reloaded.flush();
  assert.equal(reloaded.run('window.StoreNavigation.getStartAisle()'), null);
  assert.equal(reloaded.server.position, null);
  assert.match(reloaded.nodes.navigationStartLabel.textContent, /entrance/);
  const resetReload = await browser(reloaded.server);
  assert.equal(resetReload.run('window.StoreNavigation.getStartAisle()'), null);
});

test('detection completion records position; failed pickup does not move it; successful PATCH survives failed refresh', async () => {
  const detected = await browser();
  await detected.run("window.markDetected('Wine glass')"); await detected.flush();
  assert.equal(detected.run('window.StoreNavigation.getStartAisle()'), 'E66');
  assert.equal(detected.run('items.find(i=>i.id===1).detected'), true);
  detected.failPatch(); await detected.run('toggleCheck(2)');
  assert.equal(detected.run('window.StoreNavigation.getStartAisle()'), 'E66');
  const failedRefresh = await browser();
  failedRefresh.failRefresh(); await failedRefresh.run('toggleCheck(2)');
  assert.equal(failedRefresh.run('window.StoreNavigation.getStartAisle()'), 'D27');
});

test('unknown server position falls back to the entrance; queued completions respect event order and trip reset', async () => {
  const b = await browser({ position: 'MISSING' });
  assert.match(b.nodes.navigationStartLabel.textContent, /entrance/);
  assert.match(b.nodes.mapStatus.textContent, /aisle stops/);
  await b.run("Promise.all([window.StoreNavigation.recordPickup('E66'), window.StoreNavigation.recordPickup('D27'), window.StoreNavigation.recordPickup('MN50')])");
  assert.equal(b.run('window.StoreNavigation.getStartAisle()'), 'D27');
  await b.run("(async()=>{const pending=window.StoreNavigation.recordPickup('D36');window.StoreNavigation.resetTrip();await pending;})()");
  assert.equal(b.run('window.StoreNavigation.getStartAisle()'), null);
  b.run('items=[];renderList()'); await b.flush();
  assert.equal(b.nodes.storeMapRoute.children.length, 0);
});


test('blank, oversized or unmapped server positions do not block checklist/map loading', async () => {
  for (const position of ['', 'x'.repeat(41), 'MN50']) {
    const b = await browser({ position });
    assert.match(b.nodes.navigationStartLabel.textContent, /entrance/);
    assert.match(b.nodes.mapStatus.textContent, /aisle stops/);
  }
});

test('a pickup on the glasses moves the website route on the next refresh', async () => {
  const b = await browser();
  assert.equal(b.run('window.StoreNavigation.getStartAisle()'), null);
  b.pickUp(2, 'picked_up'); // the Lens PATCHes the server directly; the website is not involved
  await b.run('refreshFromServer()'); await b.flush();
  assert.equal(b.run('window.StoreNavigation.getStartAisle()'), 'D27');
  assert.match(b.nodes.navigationStartLabel.textContent, /D27/);
  const shown = JSON.parse(b.run('JSON.stringify(items.map(i => i.id))'));
  assert.deepEqual(shown, orderTargetChecklist(b.rows, 'D27').map(row => row.id));
  // Picking up an unmapped item on the glasses keeps the last mapped position.
  b.pickUp(5, 'picked_up');
  await b.run('refreshFromServer()'); await b.flush();
  assert.equal(b.run('window.StoreNavigation.getStartAisle()'), 'D27');
});
