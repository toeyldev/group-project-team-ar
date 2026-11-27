import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  orderTargetChecklist as orderChecklist,
  floorPlan,
  navigate,
  resolveNavigationStart,
} from './targetNavigation.js';
import {
  deleteItem,
  ensureSchema,
  getTripPosition,
  insertItem,
  listItems,
  migrateAisles,
  pingDb,
  setTripPosition,
  type ItemStatus,
  updateItemStatus,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..', '..', 'web');
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', async (_req, res) => {
  try {
    await pingDb();
    res.json({ ok: true, service: 'aislevision', db: 'mysql' });
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e) });
  }
});

// Stateless map APIs also accept the website's locally cached checklist aisles.
app.get('/api/store-map', (_req, res) => res.json(floorPlan));
app.post('/api/navigation', (req, res) => {
  const aisles = req.body?.aisles;
  if (!Array.isArray(aisles) || aisles.length > 500 ||
      !aisles.every(id => id === null || (typeof id === 'string' && id.length <= 40))) {
    res.status(400).json({ error: 'aisles must contain up to 500 strings or nulls' });
    return;
  }
  const startAisle = req.body?.startAisle;
  if (startAisle !== undefined && startAisle !== null &&
      (typeof startAisle !== 'string' || startAisle.length > 40)) {
    res.status(400).json({ error: 'startAisle must be a string of up to 40 characters or null' });
    return;
  }
  res.json(navigate(aisles, undefined, startAisle));
});

app.get('/api/items', async (req, res) => {
  try {
    const startAisle = req.query?.startAisle;
    if (startAisle !== undefined && (typeof startAisle !== 'string' || startAisle.length > 40)) {
      res.status(400).json({ error: 'startAisle must be a string of up to 40 characters' });
      return;
    }
    // Without ?startAisle, route from the saved trip position shared by the glasses and website.
    const tripAisle = await getTripPosition();
    res.set('X-Trip-Start-Aisle', tripAisle ?? '');
    res.json(orderChecklist(await listItems(), startAisle ?? tripAisle));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/items', async (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    let status: ItemStatus = 'not_picked_up';
    if (req.body?.status === 'picked_up' || req.body?.status === 'not_picked_up') {
      status = req.body.status;
    }
    const row = await insertItem(name, status);
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

app.patch('/api/items/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const status = req.body?.status;
  if (status !== 'picked_up' && status !== 'not_picked_up') {
    res.status(400).json({ error: 'status must be picked_up or not_picked_up' });
    return;
  }
  const row = await updateItemStatus(id, status);
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // A pickup moves the shopper to that item's aisle; unmapped aisles and unchecking keep the position.
  if (status === 'picked_up') {
    const start = resolveNavigationStart(row.aisle);
    try {
      if (start.aisle) await setTripPosition(start.aisle);
    } catch (e) {
      console.warn('Could not save trip position; the pickup is still saved:', e);
    }
  }
  res.json(row);
});

app.delete('/api/items/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const ok = await deleteItem(id);
  if (!ok) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.status(204).send();
});

app.get('/api/trip', async (_req, res) => {
  try {
    res.json({ startAisle: await getTripPosition() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// "New trip" on the website moves the shopper back to the entrance for every client.
app.delete('/api/trip', async (_req, res) => {
  try {
    await setTripPosition(null);
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/', (_req, res) => {
  res.redirect(302, '/app.html');
});

app.use(express.static(webRoot));

async function main() {
  try {
    await ensureSchema();
    await migrateAisles();
  } catch (e) {
    console.error('\nCould not connect to MySQL, create tables, or migrate aisle mappings.');
    console.error('1) Install MySQL Server and start the service.');
    console.error('2) Create database `aislevision` (run server/mysql/workbench_setup.sql in Workbench).');
    console.error('3) Copy server/.env.example to server/.env and set MYSQL_PASSWORD.\n');
    console.error(e);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`AisleVision server http://localhost:${PORT}`);
    console.log(`Web app: http://localhost:${PORT}/app.html`);
    console.log(`MySQL: ${process.env.MYSQL_DATABASE ?? 'aislevision'} @ ${process.env.MYSQL_HOST ?? '127.0.0.1'}`);
  });
}

main();
