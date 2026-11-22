import type { GroceryRow } from './db.js';
import { planRoute } from './pathfinding/routePlanner.js';
import { loadStoreMap } from './pathfinding/storeMap.js';

const METERS_PER_STEP = 1;
const WALKING_METERS_PER_SECOND = 1;
const CHECKOUT_SECONDS = 120;
const MAX_ROUTE_AISLES = 8;

const DEMO_PRICES_IN_CENTS: Readonly<Record<string, number>> = {
  fork: 199,
  spoon: 199,
  microwave: 7999,
  orange: 99,
};

type TripItem = Pick<GroceryRow, 'name' | 'aisle'>;

export function estimateTrip(items: readonly TripItem[]) {
  const map = loadStoreMap();
  const aisleIds = new Set<string>();
  const unroutableItems = new Set<string>();
  const unpricedItems = new Set<string>();
  let subtotalCents = 0;
  let pricedItemCount = 0;

  for (const item of items) {
    const aisleId = item.aisle?.trim().toUpperCase() ?? '';
    if (Object.hasOwn(map.aisles, aisleId)) {
      aisleIds.add(aisleId);
    } else {
      unroutableItems.add(item.name);
    }

    const priceKey = item.name.trim().toLowerCase();
    if (Object.hasOwn(DEMO_PRICES_IN_CENTS, priceKey)) {
      subtotalCents += DEMO_PRICES_IN_CENTS[priceKey];
      pricedItemCount += 1;
    } else {
      unpricedItems.add(item.name);
    }
  }

  let walkingSeconds: number | null = null;
  let timeUnavailableReason: string | null = null;

  if (items.length > 0) {
    if (unroutableItems.size > 0) {
      timeUnavailableReason =
        `Missing map locations for ${[...unroutableItems].join(', ')}.`;
    } else if (aisleIds.size > MAX_ROUTE_AISLES) {
      timeUnavailableReason =
        `The demo planner supports up to ${MAX_ROUTE_AISLES} aisles.`;
    } else {
      const route = planRoute(map, [...aisleIds], map.entrance, true);
      if (route) {
        const distanceMeters = route.totalSteps * METERS_PER_STEP;
        walkingSeconds = Math.ceil(distanceMeters / WALKING_METERS_PER_SECOND);
      } else {
        timeUnavailableReason = 'No walkable route through all stops to checkout.';
      }
    }
  }

  return {
    itemCount: items.length,
    walkingSeconds,
    checkoutSeconds: CHECKOUT_SECONDS,
    totalSeconds: walkingSeconds === null ? null : walkingSeconds + CHECKOUT_SECONDS,
    timeUnavailableReason,
    subtotalCents,
    pricedItemCount,
    unpricedItems: [...unpricedItems],
  };
}
