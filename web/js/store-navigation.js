/* Image and route share one SVG coordinate system and one pan/zoom viewBox. */
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  let svg, plan, routeLayer, view, drag, revision = 0;
  // The server saves the position when any client (website or glasses) marks an item picked up.
  // This copy follows the X-Trip-Start-Aisle header on each checklist load.
  let startAisle = null;
  function savePosition(aisle) {
    startAisle = aisle;
  }
  let pickupQueue = Promise.resolve(), tripRevision = 0;
  function showStart(start) {
    const [x, y] = start.point;
    const marker = document.getElementById('navigationStart');
    marker.setAttribute('cx', x); marker.setAttribute('cy', y);
    const label = document.getElementById('navigationStartLabel');
    label.setAttribute('x', x + 8); label.setAttribute('y', y - 8);
    label.textContent = start.aisle ? `You are here · ${start.aisle}` : 'Start · entrance';
  }
  const element = (tag, attrs = {}, text) => {
    const node = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function applyView() { svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`); }
  function reset() { view = { x: 0, y: 0, w: plan.width, h: plan.height }; applyView(); }
  function zoom(factor) {
    const width = Math.min(plan.width, Math.max(plan.width / 6, view.w * factor));
    const height = width * plan.height / plan.width;
    view.x += (view.w - width) / 2; view.y += (view.h - height) / 2;
    view.w = width; view.h = height; applyView();
  }
  function initView() {
    svg = document.getElementById('storeMap');
    const image = document.getElementById('storeMapImage');
    plan = { width: Number(image.getAttribute('width')), height: Number(image.getAttribute('height')) };
    routeLayer = document.getElementById('storeMapRoute');
    reset();
    document.getElementById('zoomIn').onclick = () => zoom(0.75);
    document.getElementById('zoomOut').onclick = () => zoom(1.33);
    document.getElementById('resetMap').onclick = reset;
    svg.addEventListener('wheel', event => { event.preventDefault(); zoom(event.deltaY > 0 ? 1.15 : 0.87); }, { passive: false });
    svg.addEventListener('pointerdown', event => {
      drag = { x: event.clientX, y: event.clientY, view: { ...view } };
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener('pointermove', event => {
      if (!drag) return;
      const rect = svg.getBoundingClientRect();
      // meet preserves aspect ratio, including any letterbox space.
      const scale = Math.min(rect.width / view.w, rect.height / view.h);
      view.x = drag.view.x - (event.clientX - drag.x) / scale;
      view.y = drag.view.y - (event.clientY - drag.y) / scale;
      applyView();
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) svg.addEventListener(event, () => { drag = null; });
    svg.addEventListener('keydown', event => {
      const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
      if (delta) { event.preventDefault(); view.x += delta[0]; view.y += delta[1]; applyView(); }
      if (event.key === '+') zoom(0.75);
      if (event.key === '-') zoom(1.33);
      if (event.key === '0') reset();
    });
  }
  async function init() {
    // The reference image and controls remain usable even if an older server lacks routing.
    if (!svg) initView();
    const response = await fetch('/api/store-map');
    if (!response.ok) throw apiError(response, '/api/store-map');
    const metadata = await response.json();
    if (metadata.width !== plan.width || metadata.height !== plan.height ||
        metadata.image !== document.getElementById('storeMapImage').getAttribute('href')) {
      throw new Error('Floor-plan assets do not match the server. Reload the page.');
    }
    plan.entrance = metadata.entrance;
  }
  function apiError(response, endpoint) {
    return new Error(response.status === 404
      ? `Navigation API missing (${endpoint}, HTTP 404). Restart the Node server from this feature branch, then refresh.`
      : `Navigation unavailable (${endpoint}, HTTP ${response.status}). Refresh to retry.`);
  }
  let ready;
  function ensureReady() {
    if (!ready) ready = init().catch(error => { ready = null; throw error; });
    return ready;
  }
  async function requestRoute(aisles, from = startAisle) {
    const response = await fetch('/api/navigation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aisles, startAisle: from }),
    });
    if (!response.ok) throw apiError(response, '/api/navigation');
    return response.json();
  }
  window.StoreNavigation = {
    getStartAisle: () => startAisle,
    // Adopt the server's position; returns true when it changed so the route is redrawn.
    syncStart(aisle) {
      const next = typeof aisle === 'string' && aisle.trim() && aisle.trim().length <= 40
        ? aisle.trim().toUpperCase() : null;
      if (next === startAisle) return false;
      savePosition(next);
      ++revision; // Invalidate any route calculated from the old position.
      return true;
    },
    // Serialize successful pickup events; display order never determines position.
    recordPickup(aisle) {
      const trip = tripRevision;
      const candidate = typeof aisle === 'string' ? aisle.trim().toUpperCase() : '';
      if (!candidate || candidate.length > 40) return Promise.resolve();
      pickupQueue = pickupQueue.then(async () => {
        if (trip !== tripRevision) return;
        await ensureReady();
        const result = await requestRoute([], candidate);
        if (trip === tripRevision && result.start?.aisle === candidate) {
          savePosition(candidate);
          ++revision; // Invalidate any route calculated before this pickup.
          routeLayer?.replaceChildren();
          showStart(result.start);
        }
      }).catch(error => console.error('Could not update navigation position:', error));
      return pickupQueue;
    },
    resetTrip() {
      ++tripRevision; ++revision;
      savePosition(null);
      routeLayer?.replaceChildren();
      if (plan?.entrance) showStart({ aisle: null, point: plan.entrance });
      return fetch('/api/trip', { method: 'DELETE' })
        .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); })
        .catch(error => console.error('Could not reset the trip on the server:', error));
    },
    async update(items, onRoute) {
      const version = ++revision;
      const message = document.getElementById('mapStatus');
      routeLayer?.replaceChildren();
      message.textContent = 'Updating route…';
      try {
        await ensureReady();
        if (version !== revision) return;
        const route = await requestRoute(items.filter(item => !item.checked).map(item => item.aisle ?? null));
        if (version !== revision) return;
        // Keep the server's position as is; the route already falls back to the entrance if it is unknown.
        if (route.start) showStart(route.start);
        routeLayer.replaceChildren();
        if (route.path.length > 1) {
          const points = route.path.map(point => point.join(',')).join(' ');
          routeLayer.append(element('polyline', { points, fill: 'none', stroke: 'white', 'stroke-width': 7, 'stroke-linejoin': 'round' }));
          routeLayer.append(element('polyline', { points, fill: 'none', stroke: '#dc0000', 'stroke-width': 4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
        }
        route.stops.forEach((stop, index) => {
          const [x, y] = stop.point;
          // Offset adjacent access-point markers while retaining a connector to the true point.
          const nearStart = route.start && Math.hypot(route.start.point[0] - x, route.start.point[1] - y) < 18 ? 1 : 0;
          const crowded = nearStart + route.stops.slice(0, index).filter(other => Math.hypot(other.point[0] - x, other.point[1] - y) < 18).length;
          const markerY = y - crowded * 19;
          const group = element('g');
          group.append(element('title', {}, `${index + 1}. ${stop.aisle}${stop.approximate ? ' — approximate area' : ' — aisle access point'}`));
          group.append(element('line', { x1: x, y1: y, x2: x, y2: markerY, stroke: '#dc0000', 'stroke-width': 1.5 }));
          group.append(element('circle', { cx: x, cy: markerY, r: 7, fill: index === 0 ? '#991b1b' : '#dc0000', stroke: index === 0 ? '#facc15' : 'white', 'stroke-width': 2 }));
          group.append(element('text', { x, y: markerY + 2.5, 'text-anchor': 'middle', fill: 'white', 'font-size': 7, 'font-weight': 700 }, String(index + 1)));
          group.append(element('text', { x: x + 9, y: markerY - 7, class: 'map-label' }, `${stop.aisle}${stop.approximate ? ' ≈' : ''}`));
          routeLayer.append(group);
        });
        const next = route.stops[0];
        const names = next ? items.filter(item => !item.checked && (item.aisle ?? '').trim().toUpperCase() === next.aisle).map(item => item.name).join(', ') : '';
        message.textContent = next ? `Next: ${names} · ${next.aisle}. ${route.stops.length} aisle stops.` : 'No mapped destinations remaining.';
        if (route.skipped.length) message.textContent += ` Not routed: ${route.skipped.map(stop => `${stop.aisle || 'No aisle'} (${stop.reason})`).join(', ')}.`;
        onRoute(route);
      } catch (error) {
        if (version !== revision) return;
        routeLayer?.replaceChildren();
        message.textContent = `Navigation unavailable. ${error instanceof Error ? error.message : 'Refresh to retry.'} Your checklist is still available.`;
        console.error('Store navigation failed:', error);
      }
    },
  };
})();
