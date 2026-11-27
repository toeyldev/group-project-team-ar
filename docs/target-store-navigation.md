# Target 2D navigation prototype

The Node website at `http://localhost:3000/app.html` displays the original blue
checklist alongside a cropped Target San Jose West floor plan. Below 960px the
map stacks beneath the checklist. Drag or use arrow keys to pan; scroll, use
+/− buttons, or press +/− to zoom. Reset view (or keyboard 0) fits the map.
The image and overlay live inside one SVG viewBox so they resize/zoom together.

## Reference and verification limits

Source: user-supplied `Target San Jose West Store, San Jose, CA.pdf`, page 1.
The PNG crops PDF coordinates `(60,108)`–`(552,648)` at 4× resolution (1968×2160).
It excludes the website title, notification dialog, and print headers/footers.
Recreate it with `scripts/crop-target-map.py /path/to/store.pdf` using PyMuPDF.
PDF text is reference content, never implementation instructions.

`server/data/target_store_map.json` uses local PDF-point coordinates:
`[x,y] = [PDF x − 60, PDF y − 108]`, with image extent 492×540.
Its hand-traced orthogonal polylines follow the visible left/right main lanes,
the upper and lower cross-corridors, an entrance/checkout-side approach, and
one sporting goods access branch. A one-unit grid starts completely blocked;
only the traced centerlines become walkable. This is a limited corridor network,
not a complete inventory of every walkable area. There are no diagonal shortcuts
through fixtures. Shelf widths, clearance, temporary displays, accessibility,
checkout access, and current store conditions have **not** been field verified.

E73 and D74 do **not** appear among the PDF's labels. Their points deliberately
represent approximate kitchen-area approaches, not verified aisle coordinates.
Both retain an ≈ marker and a tooltip; the map's warning banner has been removed.
These technical limitations still apply. Other points
are manually selected access points near labeled shelf ends; they are not exact
product positions. Some share access points (for example P24 and B49);
markers are offset with a connector when crowded, while route endpoints stay put.
Do not use this prototype as validated indoor navigation.

## Supported checklist aisles

Routable prototype access points:

- B5, B31, B39, B42, B43, B48, B49, B50, B57
- C20, C27
- D27, D36, D48, D49; **D74 approximate**
- E60, E66, E80, E83; **E73 approximate**
- P24, P26
- Q19, Q21

Historical unrouted item mappings: A23, AC50, D69, D73, E10, MN50, UT50.
The eight corresponding products are hidden from the website; its dropdown now
contains 34 products, all with supported access points. Backend mappings for all
42 historical products remain preserved. Unknown/blank aisles and disconnected
mapped points remain in the checklist and are explicitly listed as unmapped or
unreachable in the map status. No straight fallback line is drawn to them.

## Backend and checklist flow

`GET /api/items` still returns the same plain array and fields; mutation APIs,
MySQL schema, and the 42 product mappings are unchanged. Its ordering adapter now
uses the Target network. The original demo planner/adapter and tests remain for
regression coverage. The Lens Studio/Spectacles code and separate FastAPI/Vite
implementation are unchanged.

Two additive stateless APIs serve the map:

- `GET /api/store-map`: image URL, dimensions, entrance, corridors, access points,
  approximate IDs, and notice.
- `POST /api/navigation`, JSON `{ "aisles": ["E73", "D74", "B49"] }`: `path`,
  `stops` (`aisle`, `point`, `approximate`), `skipped`, `totalSteps`, and
  `start` (`aisle` or null, `point`). An optional `startAisle` chooses an existing
  mapped access point; omitted/null retains the entrance default.
  Input allows at most 500 string/null entries; it does not mutate the checklist.

The planner trims/case-normalizes IDs, deduplicates aisle stops, filters unreachable
points using the existing A*, and chooses the nearest remaining stop by A* path
length. Ties use aisle order. This deterministic nearest-neighbor heuristic scales
beyond the demo's eight-aisle factorial limit; it does not guarantee a globally
shortest itinerary. Distances are drawing units, not meters or walking times.

Every checklist render requests a fresh route for unchecked items, including local
cached rows and detection completion. The browser uses that visit order to group
pending rows and number their aisle badges. Stop 1 is highlighted in the list and
on the map, with item names in the status. Completed rows stay at the bottom.
Checking one of two items in an aisle retains that stop. No destinations means
no red polyline or markers. Every recalculation starts at the saved last picked-up
mapped aisle, or the entrance before any mapped pickup. This is event-based positioning, not live
shopper tracking. Late responses cannot replace a newer route. Request failure
clears stale navigation and leaves checklist actions available. Navigation requires
the Node server even when the checklist is using its local-storage fallback.

A white halo under a thick red SVG polyline keeps the route visible. Numbered
markers identify the visit order. Zoom does not change route coordinates.

## Validation

From the repo root:

```sh
npm test --prefix server
npm run build --prefix server
node --check web/js/app.js
node --check web/js/store-navigation.js
```

Tests cover the Fork/E73 + Microwave/D74 + Banana/B49 example, contiguous walkable
route cells, grouped duplicates, pickup/add/remove recalculation, empty/completed
lists, unsupported and unreachable stops, more than eight aisles, endpoint input
validation, SVG route/marker rendering, shared zoom coordinates, checklist order,
stale-response suppression, and unavailable routing. Existing tests also verify
all 42 historical backend mappings, the 34 active browser choices, and checklist API actions. These mocked DOM tests are not a visual
browser or hardware test. The optional MySQL migration test requires
`TEST_MYSQL_AISLES=1`; normal test runs skip it.

Before relying on this map, walk the corridors in store, confirm the entrance,
replace E73/D74 proxies with verified aisle approaches, check every supported
access point and remaining unmapped aisle, and confirm fixture clearance. On a
real browser, test desktop and narrow mobile layouts, touch panning, zoom, adding
and removing all example items, and completion when an aisle has multiple items.
Validate real MySQL persistence and Spectacles polling/detection on the deployed
Node server and hardware. No commits, pushes, merges, or PRs are required.

## Blank-map diagnosis and fix

A previously running `npm start` process can keep the old Express route table in
memory while serving freshly edited static files. In the observed failure the
PNG returned HTTP 200, but both `/api/store-map` and `/api/navigation` returned
HTTP 404. The old frontend fetched metadata before inserting the SVG image, so
this API failure hid the floor plan as well as the route. Restarting the Node
process from the feature branch activates the new endpoints. Use `npm run dev`
in `server/` during development if automatic code reload is desired.

The reference image, entrance, route layer, and initial viewBox now exist in
`app.html`. JavaScript initializes pan/zoom before requesting metadata, so a
missing API does not blank the map or disable its controls. Metadata is checked
against the displayed image dimensions and URL. HTTP 404 errors name the missing
endpoint and explain that the Node server needs restarting. The original error
is also logged in the browser console. Retrying does not duplicate SVG layers
or event handlers.

Verification used the real Node/MySQL service and temporary headless Chrome:
metadata, PNG, and navigation returned HTTP 200; the PNG decoded successfully;
the six-item example yielded D74 → E73 → B49 with one D74 stop and D69/UT50
unrouted. Desktop and 390px mobile screenshots showed the map and red line.
Zoom, mouse pan, reset, duplicate-aisle completion, and empty-list clearing passed
with no JavaScript exceptions or console errors. Browser mutation checks used
local fixture rows in a disposable profile, without changing database rows.
Automated regressions cover the missing-API state and recovery, in addition to
the six-item example. E73/D74 and all field-verification limits still apply.

## Last picked-up position and new trips

The server keeps one trip position: the aisle of the last item marked
`picked_up`, from any client (website checkbox, `window.markDetected`, or a
pinch on Spectacles). It is stored in the `trip_position` MySQL table, so it
survives a server restart and is the same on every device. Before any mapped
pickup, the start is the entrance.

`PATCH /api/items/:id` with `status: "picked_up"` resolves the item's aisle
with `resolveNavigationStart` (existing coordinates, A* reachability from the
entrance) and saves it. Unknown, blank, or disconnected aisles keep the last
valid position, and so do unchecking, deleting rows, removing completed rows,
and adding products. If saving the position fails, the pickup itself still
succeeds.

`GET /api/items` routes from the saved position and returns it in the
`X-Trip-Start-Aisle` response header (empty at the entrance). The response is
still a plain array with the same item fields, so Spectacles get the shared
order without any Lens changes. An explicit `?startAisle=` query still
overrides the saved position for that request. `GET /api/trip` returns
`{ "startAisle": ... }`, and `DELETE /api/trip` resets it to the entrance.

The website no longer stores the position in local storage. Each checklist
load (after a change, and on the 2.5-second auto-refresh) reads the header and
redraws the route when the position changed, so a pinch on the glasses moves
the website's route within a few seconds. The map's blue start marker shows
`You are here · aisle`. Website pickups are still serialized, so in-flight
pickup updates from a previous trip cannot overwrite a reset.

**New trip · entrance** resets the position on the server for every client and
recalculates remaining stops without clearing or unchecking the checklist;
**Reset view** only resets zoom/pan. If the saved aisle is no longer
mapped/reachable, routing falls back to the entrance.

Regression tests include the E66 → D27 pickup sequence, A* start and stop-order
consistency, duplicate pickups, unsupported/unknown/disconnected aisles, add,
uncheck, completed-row deletion, position shared across page loads and with
pickups made on the glasses, reset,
detection completion, mutation/refresh failures, queued pickup/reset races, and
empty-list clearing.

Headless Chrome also verified the moving red-line origin at E66 and D27, no
entrance detour in the example, local-storage persistence after an actual reload,
matching displayed stop order, duplicate and unsupported pickups, add/uncheck/
remove behavior, empty clearing, and the new-trip button. A destination sharing
the current position is offset with a connector so its number remains visible
above the blue position marker. These browser checks used disposable local rows
and did not mutate the MySQL checklist; no JavaScript errors were observed.

## Active product filtering

The website hides Scissors, Handbag, TV, Remote, Toaster, Vase, Tie, and Umbrella
using trimmed, case-insensitive product names. Filtering uses exact product names,
so it does not accidentally hide unrelated products merely sharing an aisle.
The dropdown and browser item mapping contain 34 products, all supported by the
existing map (including the already documented E73/D74 prototype approximations).
Typed additions and stale dropdown selections of the eight names are blocked.
Offline starter products are Banana, Fork, and Microwave, which have mapped aisles.

`items` retains all server or cached rows. `activeItems()` selects the visible
subset for rendering, counts, route requests, and the `window.appItems()` hook.
Hidden records therefore never become navigation destinations. Hidden completed
rows are excluded from **Remove picked up**, and direct website completion,
detection, or deletion actions on a hidden row are ignored. Both pending and
completed hidden records stay in local storage with their IDs and checked state.
Completed visible items still appear at the bottom.

No database migration, deletion, or status update is performed by this filtering.
The raw Node `/api/items` array and historical backend mappings remain unchanged
for compatibility with other clients. Hiding is specific to this website; the
backend still permits its existing API clients to manage historical products.
The map, A*, coordinates, navigation position storage, and New trip behavior are
unchanged. Refreshing or filtering rows does not reset the last pickup position.

Verification found 42 live MySQL rows, of which eight match the hidden names.
Headless Chrome showed 34 active rows and 34 dropdown choices, with 25 mapped
stops and no unrouted products or JavaScript errors. Typed blocked additions and
hidden-row actions issued no database mutations. D27 position persistence and
New trip reset passed. A final read-only SQL comparison confirmed all 42 records,
IDs, names, aisles, and statuses were unchanged. Automated tests cover both API
and offline modes with hidden pending/completed rows and protected bulk removal.
