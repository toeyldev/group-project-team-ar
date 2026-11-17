const LS_KEY = 'av_items';
const LS_NEXT = 'av_nextId';
const SERVER_SYNC_INTERVAL_MS = 2500;

let items = [];
let nextId = 1;
let apiOnline = false;
let refreshInProgress = false;
let serverMutationInProgress = false;

const commonItemSelect = document.getElementById('commonItemSelect');
const appStatus = document.getElementById('appStatus');

function setStatus(message, isError = false) {
  if (appStatus.textContent !== message) appStatus.textContent = message;
  appStatus.classList.toggle('error', isError);
}

function serverRowToClient(row) {
  return {
    id: row.id,
    name: row.name,
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
  const r = await fetch('/api/items');
  if (!r.ok) throw new Error('failed to load items');
  const rows = await r.json();
  const detectedById = new Map(items.map((item) => [item.id, item.detected]));
  const nextItems = rows.map((row) => {
    const item = serverRowToClient(row);
    item.detected = detectedById.get(item.id) || false;
    return item;
  });
  const changed = nextItems.length !== items.length || nextItems.some((item, index) => {
    const current = items[index];
    return !current
      || current.id !== item.id
      || current.name !== item.name
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
  items = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
  nextId = parseInt(localStorage.getItem(LS_NEXT) || '1', 10);
}

function seedDemoItems() {
  ['Milk', 'Eggs', 'Bread'].forEach((name) => {
    items.push({
      id: nextId++,
      name,
      checked: false,
      detected: false,
    });
  });
  localStorage.setItem(LS_NEXT, String(nextId));
}

function renderList() {
  const ul = document.getElementById('shoppingList');
  ul.innerHTML = '';
  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'list-item' + (item.detected ? ' detected' : '');
    li.dataset.id = item.id;
    const statusLabel = item.checked ? 'Picked up' : 'Not picked up';
    const statusClass = item.checked ? 'fulfilled' : 'pending';
    li.innerHTML = `
      <div class="item-check ${item.checked ? 'checked' : ''}" data-action="toggle" data-id="${item.id}"></div>
      <span class="item-name ${item.checked ? 'strikethrough' : ''}">${item.name}</span>
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
  const total = items.length;
  const done = items.filter((i) => i.checked).length;
  document.getElementById('itemCount').textContent =
    total === 0 ? '0 items' : `${done}/${total} picked up`;
}

async function addItem(name) {
  const isCatalogItem = Array.from(commonItemSelect.options)
    .some((option) => option.value === name);
  if (!isCatalogItem) {
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

  items.push({ id: nextId++, name, checked: false, detected: false });
  localStorage.setItem(LS_NEXT, String(nextId));
  renderList();
  setStatus(`${name} added locally. It will not appear on glasses until the server reconnects.`, true);
}

document.addEventListener('DOMContentLoaded', async () => {
  commonItemSelect.addEventListener('change', () => {
    const name = commonItemSelect.value;
    commonItemSelect.selectedIndex = 0;
    if (name) addItem(name);
  });
  document.getElementById('clearPickedBtn').addEventListener('click', () => clearChecked());
  document.getElementById('refreshBtn').addEventListener('click', () => refreshFromServer());

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

async function toggleCheck(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
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
      await loadFromServer();
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
  renderList();
  setStatus('Working offline. Changes will not reach glasses until the server reconnects.', true);
}

async function deleteItem(id) {
  const item = items.find((current) => current.id === id);
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
  setStatus('Working offline. Changes will not reach glasses until the server reconnects.', true);
}

async function clearChecked() {
  const toRemove = items.filter((i) => i.checked);
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
  items = items.filter((i) => !i.checked);
  renderList();
  setStatus('Working offline. Changes will not reach glasses until the server reconnects.', true);
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

window.appItems = () => items;
window.markDetected = async (name) => {
  const item = items.find((i) => i.name.toLowerCase() === name.toLowerCase());
  if (item && !item.checked) {
    item.detected = true;
    item.checked = true;
    if (apiOnline) {
      serverMutationInProgress = true;
      try {
        const r = await fetch(`/api/items/${item.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'picked_up' }),
        });
        if (!r.ok) throw new Error('update failed');
        await loadFromServer();
      } catch (error) {
        apiOnline = false;
        setStatus(`Could not update ${item.name}: ${error.message}`, true);
        return;
      } finally {
        serverMutationInProgress = false;
      }
    }
    renderList();
  }
};

window.addItem = addItem;
window.toggleCheck = toggleCheck;
window.deleteItem = deleteItem;
window.clearChecked = clearChecked;
window.refreshFromServer = refreshFromServer;
