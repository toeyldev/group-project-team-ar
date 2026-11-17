const LS_KEY = 'av_items';
const LS_NEXT = 'av_nextId';

let items = [];
let nextId = 1;
let apiOnline = false;

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
  const from = window.StoreNavigation?.getStartAisle?.();
  const r = await fetch('/api/items' + (from ? `?startAisle=${encodeURIComponent(from)}` : ''));
  if (!r.ok) throw new Error('failed to load items');
  const rows = await r.json();
  items = rows.map(serverRowToClient);
  nextId = items.length ? Math.max(...items.map((i) => i.id)) + 1 : 1;
  saveItems();
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

async function addItem() {
  const input = document.getElementById('itemInput');
  const raw = input.value.trim();
  if (!raw) return;
  if (!isActiveItem({ name: raw })) {
    alert('This item is unavailable because its aisle is not mapped. Choose another item.');
    return;
  }
  const name = raw.charAt(0).toUpperCase() + raw.slice(1);

  if (apiOnline) {
    try {
      const r = await fetch('/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error('post failed');
      await loadFromServer();
      input.value = '';
      renderList();
      return;
    } catch {
      alert('Could not add or refresh the checklist. Refresh before retrying.');
      return;
    }
  }

  items.push({ id: nextId++, name, aisle: aisleForItem(name), checked: false, detected: false });
  localStorage.setItem(LS_NEXT, String(nextId));
  input.value = '';
  renderList();
}

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('commonItemSelect').addEventListener('change', (e) => {
    const sel = e.target;
    const v = sel.value;
    if (!v || !isActiveItem({ name: v })) return;
    document.getElementById('itemInput').value = v;
    sel.selectedIndex = 0;
    document.getElementById('itemInput').focus();
  });

  document.getElementById('itemInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addItem();
  });
  document.getElementById('addBtn').addEventListener('click', () => addItem());
  document.getElementById('clearPickedBtn').addEventListener('click', () => clearChecked());
  document.getElementById('refreshBtn').addEventListener('click', () => refreshFromServer());
  document.getElementById('newTrip').addEventListener('click', () => {
    window.StoreNavigation?.resetTrip();
    renderList();
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
});

async function toggleCheck(id, detected = false) {
  const item = items.find((i) => i.id === id);
  if (!item || !isActiveItem(item)) return;
  const newChecked = !item.checked;
  const status = newChecked ? 'picked_up' : 'not_picked_up';

  if (apiOnline) {
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
    } catch {
      alert('Could not update or refresh the checklist. Refresh before retrying.');
      return;
    }
  }

  item.checked = newChecked;
  if (detected) item.detected = true;
  if (newChecked) await window.StoreNavigation?.recordPickup(item.aisle);
  renderList();
}

async function deleteItem(id) {
  if (!activeItems().some(item => item.id === id)) return;
  if (apiOnline) {
    try {
      const r = await fetch(`/api/items/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('delete failed');
      await loadFromServer();
      renderList();
      return;
    } catch {
      alert('Could not delete or refresh the checklist. Refresh before retrying.');
      return;
    }
  }
  items = items.filter((i) => i.id !== id);
  renderList();
}

async function clearChecked() {
  const toRemove = activeItems().filter((i) => i.checked);
  if (apiOnline) {
    try {
      for (const i of toRemove) {
        const r = await fetch(`/api/items/${i.id}`, { method: 'DELETE' });
        if (!r.ok) throw new Error('delete failed');
      }
    } catch {
      alert('Some items could not be removed. Refreshing the checklist.');
    }
    await refreshFromServer();
    return;
  }
  items = items.filter((i) => !i.checked || !isActiveItem(i));
  renderList();
}

async function refreshFromServer() {
  if (!apiOnline) return;
  try {
    await loadFromServer();
    renderList();
  } catch {
    apiOnline = false;
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
