import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { orderTargetChecklist as orderChecklist, resolveNavigationStart } from './targetNavigation.js';

test('GET /api/items passes database rows through ordering and keeps the array contract', async () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const handlerSource = source.slice(source.indexOf("app.get('/api/items'"), source.indexOf("app.post('/api/items'"));
  const rows = [
    { id: 1, name: 'Microwave', aisle: 'D74', status: 'not_picked_up' as const },
    { id: 2, name: 'Fork', aisle: 'E73', status: 'not_picked_up' as const },
    { id: 3, name: 'Banana', aisle: 'B49', status: 'picked_up' as const },
  ];
  let handler: (req: unknown, res: unknown) => Promise<void> = async () => assert.fail('route not registered');
  let tripPosition: string | null = null;
  vm.runInNewContext(handlerSource, {
    getTripPosition: async () => tripPosition,
    app: { get: (path: string, callback: typeof handler) => {
      assert.equal(path, '/api/items');
      handler = callback;
    } },
    listItems: async () => rows,
    orderChecklist,
  });
  let payload: unknown;
  const headers: Record<string, string> = {};
  const ok = { set: (name: string, value: string) => { headers[name] = value; }, json: (value: unknown) => { payload = value; } };
  await handler({}, ok);
  assert.deepEqual(payload, orderChecklist(rows));
  assert.equal(JSON.stringify(payload), JSON.stringify(orderChecklist(rows)));
  assert.equal(headers['X-Trip-Start-Aisle'], '');
  // With no query, the saved trip position (shared with the glasses) sets the route start.
  tripPosition = 'E73';
  await handler({}, ok);
  assert.deepEqual(payload, orderChecklist(rows, 'E73'));
  assert.equal(headers['X-Trip-Start-Aisle'], 'E73');
  await handler({ query: { startAisle: 'D74' } }, ok);
  assert.deepEqual(payload, orderChecklist(rows, 'D74'));
  for (const startAisle of [[], {}, 'x'.repeat(41)]) {
    let status = 200;
    const res = { status(code: number) { status = code; return this; }, set() {}, json() {} };
    await handler({ query: { startAisle } }, res);
    assert.equal(status, 400);
  }
});

test('PATCH picked_up saves the item aisle as the trip position; unmapped aisles and unchecking keep it', async () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const handlerSource = source.slice(source.indexOf("app.patch('/api/items/:id'"), source.indexOf("app.delete('/api/items/:id'"));
  const rows = new Map([
    [1, { id: 1, name: 'Laptop', aisle: 'D27', status: 'not_picked_up' }],
    [2, { id: 2, name: 'Tie', aisle: 'MN50', status: 'not_picked_up' }],
    [3, { id: 3, name: 'Cake', aisle: 'B39', status: 'not_picked_up' }],
  ]);
  let position: string | null = null;
  let failSave = false;
  let handler: (req: unknown, res: unknown) => Promise<void> = async () => assert.fail('route not registered');
  vm.runInNewContext(handlerSource, {
    app: { patch: (_path: string, callback: typeof handler) => { handler = callback; } },
    console: { warn() {} },
    resolveNavigationStart,
    setTripPosition: async (aisle: string | null) => { if (failSave) throw new Error('db down'); position = aisle; },
    updateItemStatus: async (id: number, status: string) => {
      const row = rows.get(id);
      if (row) row.status = status;
      return row;
    },
  });
  const patch = async (id: number, status: string) => {
    let body: unknown;
    await handler({ params: { id: String(id) }, body: { status } }, { status() { return this; }, json: (value: unknown) => { body = value; } });
    return body;
  };
  await patch(1, 'picked_up');
  assert.equal(position, 'D27');
  await patch(2, 'picked_up');
  assert.equal(position, 'D27', 'unmapped aisle does not move the shopper');
  await patch(1, 'not_picked_up');
  assert.equal(position, 'D27', 'unchecking does not move the shopper');
  failSave = true;
  assert.deepEqual(await patch(3, 'picked_up'), rows.get(3), 'pickup still succeeds if saving the position fails');
  assert.equal(position, 'D27');
});
