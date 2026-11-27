const LS_KEY = 'av_items';
const LS_NEXT = 'av_nextId';
const SERVER_SYNC_INTERVAL_MS = 2500;
// The server's list replaces this browser's list when it reconnects, so offline edits are not kept.
const OFFLINE_MESSAGE = 'Offline: this change is saved only in this browser and will be replaced by the server list when it reconnects.';

let items = [];
let nextId = 1;
let apiOnline = false;
let refreshInProgress = false;
let serverMutationInProgress = false;

function setStatus(message, isError = false) {
  const appStatus = document.getElementById('appStatus');
  if (!appStatus) return;
  if (appStatus.textContent !== message) appStatus.textContent = message;
  appStatus.classList.toggle('error', isError);
}

const AISLES_BY_ITEM = {
  'cup': 'E80',
  'bottle': 'Q19',
  'microwave': 'D74',
  'potted plant': 'B5',
  'keyboard': 'D36',
  'backpack': 'P26',
  'suitcase': 'D49',
  'sports ball': 'Q21',
  'baseball bat': 'Q21',
  'baseball glove': 'Q21',
  'tennis racket': 'Q19',
  'wine glass': 'E66',
  'fork': 'E73',
  'knife': 'E60',
  'spoon': 'E73',
  'bowl': 'E80',
  'banana': 'B49',
  'apple': 'B50',
  'sandwich': 'B43',
  'orange': 'B49',
  'broccoli': 'B57',
  'carrot': 'B57',
  'hot dog': 'B48',
  'pizza': 'B42',
  'donut': 'B31',
  'cake': 'B39',
  'chair': 'E83',
  'laptop': 'D27',
  'mouse': 'D36',
  'book': 'D48',
  'clock': 'E83',
  'teddy bear': 'P24',
  'hair drier': 'C20',
  'toothbrush': 'C27',
};

// Hide only these products, preserving all cached/database records and statuses.
const HIDDEN_ITEMS = new Set(['scissors', 'handbag', 'tv', 'remote', 'toaster', 'vase', 'tie', 'umbrella']);
function isActiveItem(item) {
  return !HIDDEN_ITEMS.has(item.name.trim().toLowerCase());
}
function activeItems() { return items.filter(isActiveItem); }

function aisleForItem(name) {
  const key = name.trim().toLowerCase();
  return Object.hasOwn(AISLES_BY_ITEM, key) ? AISLES_BY_ITEM[key] : null;
}

function serverRowToClient(row) {
  return {
    id: row.id,
    name: row.name,
    aisle: aisleForItem(row.name) ?? row.aisle,
    checked: row.status === 'picked_up',
    detected: false,
  };
}

async function tryHealth() {
  try {
    const r = await fetch('/api/health');
    return r.ok;
  } catch {
    return false;
  }
}

async function loadFromServer() {
  // The server routes from the shared trip position, so pickups on the glasses reorder this list too.
  const r = await fetch('/api/items');
  if (!r.ok) throw new Error('failed to load items');
  const rows = await r.json();
  const serverStart = r.headers?.get?.('X-Trip-Start-Aisle');
  const startChanged = typeof serverStart === 'string'
    && Boolean(window.StoreNavigation?.syncStart?.(serverStart));
  const detectedById = new Map(items.map((item) => [item.id, item.detected]));
  const nextItems = rows.map((row) => {
    const item = serverRowToClient(row);
    item.detected = detectedById.get(item.id) || false;
    return item;
  });
  const changed = startChanged || nextItems.length !== items.length || nextItems.some((item, index) => {
    const current = items[index];
    return !current
      || current.id !== item.id
      || current.name !== item.name
      || current.aisle !== item.aisle
      || current.checked !== item.checked
      || current.detected !== item.detected;
  });
  nextId = nextItems.length ? Math.max(...nextItems.map((item) => item.id)) + 1 : 1;
  if (changed) {
    items = nextItems;
    saveItems();
  }
  return changed;
}

function loadLocalOnly() {
  items = JSON.parse(localStorage.getItem(LS_KEY) || '[]').map((item) => ({
    ...item,
    aisle: aisleForItem(item.name) ?? item.aisle,
  }));
  nextId = parseInt(localStorage.getItem(LS_NEXT) || '1', 10);
}

function seedDemoItems() {
  ['Banana', 'Fork', 'Microwave'].forEach((name) => {
    items.push({
      id: nextId++,
      name,
      aisle: aisleForItem(name),
      checked: false,
      detected: false,
    });
  });
  localStorage.setItem(LS_NEXT, String(nextId));
}

function escapeItemText(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderList(routeReady = false) {
  // Always keep completed rows at the bottom, including cached/offline lists.
  items.sort((a, b) => Number(a.checked) - Number(b.checked));
  if (!routeReady) {
    items.forEach(item => { delete item.stopNumber; });
    window.StoreNavigation?.update(activeItems(), route => {
      const order = route.stops.map(stop => stop.aisle);
      const rank = item => { const i = order.indexOf((item.aisle ?? '').trim().toUpperCase()); return i < 0 ? order.length : i; };
      items.sort((a, b) => Number(a.checked) - Number(b.checked) || (a.checked ? 0 : rank(a) - rank(b)));
      items.forEach(item => { item.stopNumber = item.checked || rank(item) === order.length ? null : rank(item) + 1; });
      renderList(true);
    });
  }
  const ul = document.getElementById('shoppingList');
  ul.innerHTML = '';
  activeItems().forEach((item) => {
    const li = document.createElement('li');
    li.className = 'list-item' + (item.detected ? ' detected' : '') + (item.stopNumber === 1 ? ' next-stop' : '');
    li.dataset.id = item.id;
    const statusLabel = item.checked ? 'Picked up' : 'Not picked up';
    const statusClass = item.checked ? 'fulfilled' : 'pending';
    const aisleLabel = escapeItemText(item.aisle || 'N/A');
    li.innerHTML = `
      <div class="item-check ${item.checked ? 'checked' : ''}" data-action="toggle" data-id="${item.id}"></div>
      <span class="item-name ${item.checked ? 'strikethrough' : ''}">${escapeItemText(item.name)}</span>
      <span class="item-aisle">${item.stopNumber ? `Stop ${item.stopNumber} · ` : ''}Aisle ${aisleLabel}</span>
      <span class="item-status-badge ${statusClass}">${statusLabel}</span>
      <button type="button" class="item-delete" data-action="delete" data-id="${item.id}" title="Remove">✕</button>
    `;
    ul.appendChild(li);
  });
  ul.querySelectorAll('[data-action="toggle"]').forEach((el) => {
    el.addEventListener('click', () => toggleCheck(Number(el.dataset.id)));
  });
  ul.querySelectorAll('[data-action="delete"]').forEach((el) => {
    el.addEventListener('click', () => deleteItem(Number(el.dataset.id)));
  });
  updateCount();
  saveItems();
}

function updateCount() {
  const active = activeItems();
  const total = active.length;
  const done = active.filter((i) => i.checked).length;
  document.getElementById('itemCount').textContent =
    total === 0 ? '0 items' : `${done}/${total} picked up`;
}

async function addItem(name) {
  // Every dropdown item has a mapped aisle, so this also rejects stale or hidden values.
  if (typeof name !== 'string' || !aisleForItem(name) || !isActiveItem({ name })) {
    setStatus('Choose an item from the menu.', true);
    return;
  }

  if (apiOnline) {
    serverMutationInProgress = true;
    try {
      const r = await fetch('/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error('post failed');
      await loadFromServer();
      renderList();
      setStatus(`${name} added. Changes from glasses sync automatically.`);
      return;
    } catch (error) {
      apiOnline = false;
      setStatus(`Could not add ${name}: ${error.message}`, true);
      return;
    } finally {
      serverMutationInProgress = false;
    }
  }

  items.push({ id: nextId++, name, aisle: aisleForItem(name), checked: false, detected: false });
  localStorage.setItem(LS_NEXT, String(nextId));
  renderList();
  setStatus(OFFLINE_MESSAGE, true);
}

document.addEventListener('DOMContentLoaded', async () => {
  const commonItemSelect = document.getElementById('commonItemSelect');
  commonItemSelect.addEventListener('change', () => {
    const name = commonItemSelect.value;
    commonItemSelect.selectedIndex = 0;
    if (name) return addItem(name);
  });
  document.getElementById('clearPickedBtn').addEventListener('click', () => clearChecked());
  document.getElementById('refreshBtn').addEventListener('click', () => refreshFromServer());
  document.getElementById('newTrip').addEventListener('click', async () => {
    const reset = window.StoreNavigation?.resetTrip();
    renderList();
    await reset;
    await refreshFromServer();
  });

  apiOnline = await tryHealth();

  if (apiOnline) {
    try {
      await loadFromServer();
    } catch {
      apiOnline = false;
      loadLocalOnly();
    }
  } else {
    loadLocalOnly();
  }

  if (!apiOnline && items.length === 0) {
    seedDemoItems();
  }

  renderList();
  setStatus(
    apiOnline
      ? 'Connected. Changes from glasses update automatically.'
      : 'Server unavailable. Showing this browser’s saved list; changes will not reach glasses.',
    !apiOnline
  );
  window.setInterval(() => {
    if (document.visibilityState !== 'hidden') refreshFromServer();
  }, SERVER_SYNC_INTERVAL_MS);
});

async function toggleCheck(id, detected = false) {
  const item = items.find((i) => i.id === id);
  if (!item || !isActiveItem(item)) return;
  const newChecked = !item.checked;
  const status = newChecked ? 'picked_up' : 'not_picked_up';

  if (apiOnline) {
    serverMutationInProgress = true;
    try {
      const r = await fetch(`/api/items/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) throw new Error('patch failed');
      if (newChecked) await window.StoreNavigation?.recordPickup(item.aisle);
      await loadFromServer();
      if (detected) {
        const refreshed = items.find(i => i.id === id);
        if (refreshed) refreshed.detected = true;
      }
      renderList();
      return;
    } catch (error) {
      apiOnline = false;
      setStatus(`Could not update ${item.name}: ${error.message}`, true);
      return;
    } finally {
      serverMutationInProgress = false;
    }
  }

  item.checked = newChecked;
  if (detected) item.detected = true;
  if (newChecked) await window.StoreNavigation?.recordPickup(item.aisle);
  renderList();
  setStatus(OFFLINE_MESSAGE, true);
}

async function deleteItem(id) {
  const item = activeItems().find((current) => current.id === id);
  if (!item) return;

  if (apiOnline) {
    serverMutationInProgress = true;
    try {
      const r = await fetch(`/api/items/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('delete failed');
      await loadFromServer();
      renderList();
      return;
    } catch (error) {
      apiOnline = false;
      setStatus(`Could not remove ${item.name}: ${error.message}`, true);
      return;
    } finally {
      serverMutationInProgress = false;
    }
  }
  items = items.filter((i) => i.id !== id);
  renderList();
  setStatus(OFFLINE_MESSAGE, true);
}

async function clearChecked() {
  const toRemove = activeItems().filter((i) => i.checked);
  if (apiOnline) {
    serverMutationInProgress = true;
    try {
      for (const item of toRemove) {
        const r = await fetch(`/api/items/${item.id}`, { method: 'DELETE' });
        if (!r.ok) throw new Error(`delete failed for ${item.name}`);
      }
      await loadFromServer();
      renderList();
      return;
    } catch (error) {
      apiOnline = false;
      setStatus(`Could not remove all picked-up items: ${error.message}`, true);
      return;
    } finally {
      serverMutationInProgress = false;
    }
  }
  items = items.filter((i) => !i.checked || !isActiveItem(i));
  renderList();
  setStatus(OFFLINE_MESSAGE, true);
}

async function refreshFromServer() {
  if (refreshInProgress || serverMutationInProgress) return;
  refreshInProgress = true;
  try {
    if (!apiOnline) {
      apiOnline = await tryHealth();
      if (!apiOnline) throw new Error('Checklist server is unavailable');
    }
    const changed = await loadFromServer();
    if (changed) renderList();
    setStatus('Connected. Changes from glasses update automatically.');
  } catch (error) {
    apiOnline = false;
    setStatus(`Unable to sync with the server: ${error.message}`, true);
  } finally {
    refreshInProgress = false;
  }
}

function saveItems() {
  localStorage.setItem(LS_KEY, JSON.stringify(items));
}

window.appItems = () => activeItems();
window.markDetected = async (name) => {
  const item = items.find((i) => i.name.toLowerCase() === name.toLowerCase());
  if (item && isActiveItem(item) && !item.checked) await toggleCheck(item.id, true);
};

window.addItem = addItem;
window.toggleCheck = toggleCheck;
window.deleteItem = deleteItem;
window.clearChecked = clearChecked;
window.refreshFromServer = refreshFromServer;
