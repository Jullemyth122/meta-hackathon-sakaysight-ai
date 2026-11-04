# SakaySightAI — Product Vision, Evidence and Technical Notes

> **Meta Hackathon — SakaySightAI**
> A GPS-anchored 3D WebGPU digital twin of Philippine public transport covering **traditional jeepneys, modern jeepneys, UV Express and buses**, simulated cabin/door cameras with a proposed low-cost ESP32-camera-to-phone deployment, a smartphone GPS tracker (`/track.html`), and a grounded Meta AI operations assistant (`/api/assist`). Hardware cost, detector accuracy and financial benefits require field validation by vehicle type.

## The product we are building toward

**Making every seat, stop and peso count.** SakaySightAI aims to connect a driver's next decision with the commuter who needs that ride: notice people approaching before a pickup is missed, understand whether a cheaper diesel station is worth reaching, and find a catchable ride from a convenient boarding point.

**This is a demo-product prototype intended to become a live product.** The author reports that the team currently lacks the funding to produce/install the camera hardware and run a real fleet pilot. Simulation lets the team develop the software and test its assumptions at low cost. The architecture has a plausible path to deployment, but real hardware integration, reliable live inputs and measured benefits still need engineering and field validation. Lack of funding is not presented as proof that all other production work is complete.

### Vehicle coverage and shared capabilities

SakaySightAI's product scope includes **traditional jeepneys, modern jeepneys, UV Express and buses**. The implementation represents all four through [`FleetKind` and vehicle specifications](./src/core/vehicles/specs.ts), [boarding/drop-off rules](./src/core/vehicles/stops.ts), [fare rules](./src/core/fare.ts), shared advisory logic and vehicle-specific 3D geometry/passenger movement. A jeepney route mixes traditional and modern jeepneys according to a configurable model assumption; UV Express and buses run their own route types rather than being inserted into every jeepney corridor.

The current model permits UV Express boarding at terminals and drop-offs at modelled route stops. Traditional jeepneys, modern jeepneys and buses board/alight at their modelled route stops. These are software assumptions to verify against each actual service. Approaching-passenger guidance and any proposed nearer pickup must respect those rules; they do not imply that a UV Express can collect riders at any roadside location.

The traditional jeepney uses the virtual cabin camera described below. Modern jeepneys, UV Express and buses have [virtual door-camera placements](./src/scene/vehicles/doorCamera.ts) and a [vehicle-dependent camera view](./src/scene/world/CabinCameraFeed.tsx). Their layouts do not establish physical detector performance. Fuel consumption, tank size, maintenance, ownership costs and economics need vehicle-specific inputs; traditional-jeepney examples must not be presented as measured UV, bus or modern-jeepney results.

### Real statistics, transparent assumptions and decision mathematics

The model is informed by real geography, historical transport research and a dated DOE price snapshot. It also contains synthetic demand and adjustable assumptions. **Research-informed does not mean every passenger, fare outcome or traffic condition is measured live.** Our [evidence and decision-math guide](./docs/evidence-and-decision-math.md) identifies verified references from 2016, 2018, 2021, 2023 and 2026, explains their scope, and distinguishes them from observations and model choices. This is not a continuous annual dataset.

The same guide works through three product decisions, using explicitly illustrative inputs:

| Decision | What is available in the demo | What the worked example adds |
| --- | --- | --- |
| Eight empty seats and several people approaching | Arrival heads-up, distance/ETA, vehicle timing and queue-aware seats. | A proposed bounded-hold calculation: expected extra fares minus fuel, operating costs and lost earnings, while counting onboard delay. Automatic roadside holding is not implemented. |
| Enough diesel to reach a cheaper station? | On-route station candidates, dated estimated prices and simulated tank context. | Fuel reserve/reachability and total incremental cost. The example gives ₱77.47 net benefit on one hypothetical 30 L top-up, not a daily savings promise. |
| Reach a permitted pickup via a nearer secondary-road connection | Candidate mapped stops, first-mile access and catchability estimates. | A proposed verified rendezvous point: shorter walking distance is useful only when the person can arrive before the vehicle, safely board in the right direction and find space. Arbitrary roadside interception is not implemented. |

See the [source register, formulas, examples and pilot plan](./docs/evidence-and-decision-math.md) for assumptions and limitations. The examples are independent decision illustrations; they must not be added together or presented as measured driver income.

## Hackathon contribution, provenance and AI role

### Development dates and reused foundation

The participant guide supplied by the author lists the kickoff on **October 26, 2026 at noon Eastern Time** and the building period as **October 27–November 4, 2026**. The kickoff is October 27 at midnight in Manila. Repository history records:

- `bfd4b9a`: README initialization, October 26, 2026 at 09:06:54 +08:00, before the kickoff.
- `942c6ca`: first implementation commit, October 27, 2026 at 14:19:56 +08:00, after the kickoff and on the first stated building date.

Commit timestamps establish when work was recorded, not when every line was originally authored. **The author reports reusing a 3D foundation from their earlier code. That foundation is pre-existing work and is not claimed as a new hackathon contribution.** The exact upstream repository and file-level boundary have not been recorded here; the initial implementation commit must not be treated as proof that every included rendering asset or utility was newly created.

The author's reported hackathon work is the SakaySightAI-specific transport application and integration: OpenStreetMap/OpenFreeMap mapping, driver and commuter experiences, fleet and passenger behaviour, the virtual cabin-counter experiment, phone tracking, Meta voice/context integration, route and fuel advice, and service/economics experiments. The feature inventory below links to their current implementation; it is not a line-by-line authorship audit.

**OpenStreetMap integration is a SakaySightAI feature added to the reused 3D foundation, as reported by the author.** OpenStreetMap supplies geographic data, while OpenFreeMap serves the vector tiles that SakaySightAI converts into roads, buildings, water and parks for its 3D twin. This choice keeps the basemap accessible without a Google Maps API key or Google Maps usage charges. [OpenFreeMap](https://openfreemap.org/) offers its public tile service without registration or API keys. The cost comparison is with [Google Maps Platform's usage-based pricing and free usage caps](https://developers.google.com/maps/billing-and-pricing/overview): Google Maps is not universally paid from the first request, but billable usage can incur charges. The contribution is SakaySightAI's integration and rendering of these existing mapping resources, not creation of OpenStreetMap or OpenFreeMap.

The supplied guide permits building on existing products or codebases when new contributions are clearly identified. The submission and three-minute video should explicitly disclose the reused foundation and demonstrate the newly developed SakaySightAI features. Reuse alone does not establish disqualification, and these notes do not guarantee eligibility or replace the organisers' decision. The supplied copy omits the detailed scoring rubric (`[table]`), so no AI score or finalist prediction is asserted.

### What Meta AI contributes

SakaySightAI is designed to turn transport state into understandable, actionable guidance for a driver or commuter speaking English, Tagalog or Taglish. Its intended benefit is easier access to relevant decisions through natural questions and voice; improved driving decisions, fare collection or advice-following have not yet been measured in a field pilot.

| Layer | Current implementation | Attribution and evidence boundary |
| --- | --- | --- |
| Spoken questions | [`api/transcribe.ts`](./api/transcribe.ts) sends recorded WAV questions to Meta transcription with language biases and local stop-name keywords. | Meta speech recognition; the default model identifier is `muse-voice-transcribe-1.0`, overridable through `META_TRANSCRIBE_MODEL`. A configured endpoint and successful live call are required to demonstrate it. |
| Contextual answers | [`api/assist.ts`](./api/assist.ts) sends the relevant screen summary and computed plan to the Meta model configured through `META_MODEL`. Its prompt requests answers in the user's language and consistent with the supplied facts. | Meta supplies language interpretation and explanation. Prompt grounding reduces opportunities for unsupported answers but does not prove they cannot occur. |
| Transport calculations | [`api/_lib/planner.ts`](./api/_lib/planner.ts) and [`src/core/advisory`](./src/core/advisory) calculate stop/pass advice, ETAs, seat estimates, queue assignments, fares and fuel estimates. | Deterministic application logic, not calculations performed or independently verified by Meta. Some answers, including trip budgets and arrival guidance, have direct deterministic paths. |
| Sakay Agent | [`api/agent.ts`](./api/agent.ts), [`core/agent`](./src/core/agent), [`agentTools.ts`](./src/app/agentTools.ts). Muse chooses tools (trip planning, traffic, shortcuts, seats, late riders, leaving a terminal, the boundary, passing riders on, signboards from a photo); the browser runs them and Muse answers from the results. | Tool calling and image input tested live on the configured key on 2026-10-31. Muse chooses and phrases; numbers come from the tools. Facts about riders and traffic are simulated. A shortcut leaves a franchise route and is advice only: the simulated vehicle stays on its route. |
| Waiting by the road | [`core/network/roadside.ts`](./src/core/network/roadside.ts), `riskAt` in [`core/map/streets.ts`](./src/core/map/streets.ts) | A From spot beside a route is where the commuter boards: vehicles pull over there. Expressways, ramps, flyovers and tunnels are refused, from OpenStreetMap road tags. Only the commuter app's own rider does this; simulated crowds use stops. It does not know local no-loading rules, such as MMDA loading bays. |
| Crossing the road | [`core/people/crossing.ts`](./src/core/people/crossing.ts), `crossingAhead` in [`passengerSystem.ts`](./src/core/people/passengerSystem.ts) | Whoever's way crosses the focused route's road waits at the kerb until vehicles have given way. Other routes' traffic is a timetable with a lag, so it holds back only near the view and below high simulation speeds. The simulated road only knows the focused route: a way across another road holds that traffic for the commuter app's own rider only. |
| Drive lines | [`core/geo/driveLine.ts`](./src/core/geo/driveLine.ts), [`scene/world/lanes.ts`](./src/scene/world/lanes.ts) | Across all 548 routes, both lanes (26,000 km): sliding over 10° fell from 66 km to under 5 km, the rest at U-turns at the ends of routes, where the road doubles straight back. Each line is built the first time its route is seen, one a frame at most. Other routes' traffic keeps to a timetable, so it does not brake for bends. |
| Spoken replies | [`api/speak.ts`](./api/speak.ts), [`src/net/voice.ts`](./src/net/voice.ts) | ElevenLabs or Azure when configured, with browser speech fallback. Spoken output in this implementation is not attributed to Meta. |
| Muse answers everything | [`ui/phone/AskBox.tsx`](./src/ui/phone/AskBox.tsx), [`net/agent.ts`](./src/net/agent.ts), [`ui/network/TripPlanner.tsx`](./src/ui/network/TripPlanner.tsx) | No answer skips Muse by choice: the free math-only mode is gone, a whole-trip cost is worked out on the device and told by Muse, and Muse says which trip it would take. `onlyItsNumbers` drops any wording with a number Muse was not given. This costs more credit than before; only the 60-second cache and asking once per set of trips hold it down. |
| Automatic AI | [`ui/AutoAI.tsx`](./src/ui/AutoAI.tsx), [`core/agent/autopilot.ts`](./src/core/agent/autopilot.ts) | Shown only with one vehicle or person selected; on for one at a time (`store.autoAI`). In the Live map a person is only ever selected through the Commuter app: clicking one in 3D does not select them. |
| Resilience and cost control | Fallback to the app's own numbers, compact context, 60-second answer cache and server-only credentials. | `/api/assist` returns `source` as `meta-ai`, `deterministic-planner` or `deterministic-fallback`; the screen says Muse could not be reached for both of the last two. Missing configuration or credit-saving mode can produce a useful answer without a Meta call. |
| Loading screen | [`index.html`](./index.html), [`app/startup.ts`](./src/app/startup.ts), [`ui/Splash.tsx`](./src/ui/Splash.tsx), [`scripts/splash/`](./scripts/splash) | Waits for the engine, the routes, the map, then 30 frames in a row under 50 ms. Gives up on frames settling after 5 s, and on everything after 45 s, for a machine in trouble. Shows on opening the page only, not on changing route or view. Scenery is baked to images because as repeating vectors it took the app from 17 s to about 50 s (`python scripts/splash/build.py` needs Chrome). The bar's route-building stage is 9 s or so of the 17: smoothing every route's turns on the main thread, between slices. |
| Road repair | `public/data/metro-manila-network.json` | Off-road stretches of route redrawn along roads a vehicle can take (258 of 542; no tracks, footpaths or driveways). The other 284, about 10 km of 13,288 km, stay as they were: the only road is a long way round, and a detour would be worse. Measured over 1,760 km around the default route: 5.5 km more than 3 m outside a road's edge, 1.5 km more than 6 m. Rounding corners any wider cuts across buildings, any tighter is sharper than a bus takes them: 0.3% of road is under 8 m radius. |

For a judge-facing AI demonstration, record the configured model identifier and show a successful Meta transcription and an answer with `source: "meta-ai"`. A planner fallback must be labelled as such. Cached Meta answers remain Meta-derived, but do not demonstrate a fresh inference request. Do not expose API keys in the recording or logs.

### Current feature inventory and what each feature knows

| Feature | User benefit and implementation | Current data boundary |
| --- | --- | --- |
| OpenStreetMap-based 3D map | Uses OpenFreeMap vector tiles to show real roads, buildings, water and parks without a Google Maps API dependency. Tiles are decoded and converted to 3D meshes in background workers. [`tileSource.ts`](./src/map/tileSource.ts), [`tileWorker.ts`](./src/map/tileWorker.ts), [`buildTile.ts`](./src/core/map/buildTile.ts) | OpenStreetMap is the geographic data source; OpenFreeMap is the tile provider. Basemap geometry does not supply live traffic, current transit service or passenger demand. |
| Driver stop/pass guidance | Explains pickups, drop-offs, capacity and riders already covered by a vehicle ahead. [`driver.ts`](./src/core/advisory/driver.ts), [`dispatch.ts`](./src/core/advisory/dispatch.ts) | Calculated from the focused route's simulated state. It is advisory, not an automatic vehicle control system. |
| Approaching commuters | Shows known walkers/tricycle riders within 500 m of their stop, their remaining distance and ETA, and whether they are expected before the vehicle. [`approach.ts`](./src/core/advisory/approach.ts) | Distances and arrival times are calculated from simulated journeys. Meta can explain the supplied facts; it does not visually detect people down the road. Unknown arrival estimates are not treated as zero. |
| Catchable rides and seat availability | Helps a commuter avoid a vehicle that arrives before they reach the stop, or one whose seats are taken by people ahead in the queue. [`commuter.ts`](./src/core/advisory/commuter.ts), [`CommuterPanel.tsx`](./src/ui/phone/CommuterPanel.tsx) | Seats and arrival times are estimates, not reservations. Future destinations and queue order are known in the simulation; a deployment needs corresponding real inputs. |
| Arrival explanations | Answers whether people are still approaching and whether a ride can be caught. [`arrivalAdvice.ts`](./api/_lib/arrivalAdvice.ts) | An ETA comparison does not reserve a seat or instruct a driver to wait minutes for a distant rider. Current guidance says to recheck on arrival. More fares are a possible outcome to test, not a promised result. |
| Fuel and refuelling advice | Remaining fuel to a terminal, estimated savings, tank state, and reachable stations ahead on the driver's side of the route. [`stations.ts`](./src/core/fuel/stations.ts), [`DriverPanel.tsx`](./src/ui/phone/DriverPanel.tsx) | Uses bundled station data and dated DOE price ranges; expected prices are range midpoints, not live pump quotes. Advice stays on the franchise route. |
| Trip budgets and earnings | Distinguishes a full trip budget from the remaining leg; models boundary and owner-driver costs and daily earnings. [`tripBudget.ts`](./src/core/advisory/tripBudget.ts), [`earnings.ts`](./src/app/earnings.ts) | Costs and earnings depend on inputs and assumptions. Fare revenue minus diesel alone is not take-home income. |
| Network trip planning | Direct or one-transfer journeys, walking/tricycle access, directional stops and rider-category fares. [`plan.ts`](./src/core/network/plan.ts), [`TripPlanner.tsx`](./src/ui/network/TripPlanner.tsx) | Network data includes the 2015 DOTC GTFS feed and road-derived paths. Other routes use flow estimates. Current route coverage must be verified in the field. |
| Traffic-sensitive simulation | Rush-hour speeds, terminal queues, fleet spacing, working days and refuelling alter the simulated journey. [`fleetSim.ts`](./src/core/fleet/fleetSim.ts) | This is simulated traffic behaviour. No live traffic feed or Meta traffic-detection system is demonstrated. Phone GPS supplies position/speed observations, not verified city-wide congestion. |
| Phone GPS tracking | Actual browser geolocation, noise filtering, explicit vehicle confirmation and stale/lost indicators; an indoor simulated ride is also available. [`TrackerApp.tsx`](./src/tracker/TrackerApp.tsx), [`liveVehicle.ts`](./src/core/tracking/liveVehicle.ts) | A phone's position does not independently identify its vehicle, passenger count or destination. Simulated sessions are labelled. |
| Cabin sensor experiment | Virtual camera projection, detector noise/occlusion, tracking, crossing counts and visible-head correction, with a sensor lab and PiP telemetry. [`pipeline.ts`](./src/core/doorway/pipeline.ts) | Detection inputs come from projected virtual people, not real image inference. The YOLO/phone deployment is proposed, not an integrated Meta vision feature. |
| Operator twin and economics lab | Inspect a route, compare no-app/planner/planner-plus-Meta policies, and export ledgers and audits. [`EconomicsLab.tsx`](./src/ui/EconomicsLab.tsx), [`simulation results`](./docs/simulation-results/README.md) | Seeded model results, not measured savings. Some high-load scenarios reduce service; voice-driven adoption uplift is an unmeasured hypothesis. Saved result versions may differ from the current model. |

### Proposed ESP32 camera → YOLO detector → phone deployment

The intended low-cost design uses the ESP32 camera for image capture and a paired phone for detector inference, tracking and counting; the phone can then publish occupancy alongside GPS. A candidate YOLO head detector would need compatible model weights, preprocessing, runtime integration and testing on the target phone. Training or fine-tuning on suitable licensed cabin footage may be needed; this repository does not contain a completed training run, real-camera inference integration or hardware benchmark.

The under-₱600 figure below is a **component-budget target**, assuming an existing phone. It is not a verified complete installed price: mounting, power, wiring, enclosure, delivery, connectivity and maintenance must be costed. Any cheaper configuration remains a candidate until actual parts and measurements are recorded. A locally connected camera may avoid cellular video upload, but cloud updates and Meta requests still require connectivity.

The simulator supplies passenger positions, queue order and destinations directly through [`twinState.ts`](./src/app/twinState.ts). A real deployment must obtain or estimate those facts, account for people without the app, and expose uncertainty. Camera occupancy and GPS alone cannot establish how many people await a stop or where each rider will alight.

Field evidence still needed: camera counts against manual counts under varied lighting and occlusion; phone processing speed and power use; real GPS-to-dashboard operation; route/ETA accuracy; successful Meta voice/context interactions; and a corridor pilot measuring passenger waiting, service and driver costs.

---

## 1. Proposed Hardware Budget and Simulated Pipeline

This specification describes the hardware design that the **SakaySightAI** Three.js/WebGPU simulation aims to support. Component prices and detector performance below are design assumptions, not purchase quotes or measured hardware results. A real installation and model evaluation are still required.

| Component / Layer | Proposed Spec | Indicative Component Budget (PH) | Current Implementation or Proposed Integration |
| --- | --- | --- | --- |
| **Microcontroller & Camera** | **ESP32-S3-CAM (N16R8)** + **OV2640 Wide-Angle Lens (`120°–160°`)** or **ESP32-CAM + MB Base** | **₱350 – ₱550** | Modelled physically in 3D (`CabinCameraModel` in [`src/scene/DoorwayScene.tsx`](./src/scene/DoorwayScene.tsx) and [`src/scene/world/CabinCameraFeed.tsx`](./src/scene/world/CabinCameraFeed.tsx)) and optically in [`src/scene/doorway/cabinCamera.ts`](./src/scene/doorway/cabinCamera.ts) at `CABIN_CAM` (`position: (1.2, 2.12, 0)`, `lookAt: (-3.3, 0.9, 0)`, `vfov: 100°` / `~116°` horizontal at `4:3`). |
| **In-Vehicle Connection (Video)** | **Local Wi-Fi** (phone hotspot or ESP32 SoftAP) | Built-in radio; operating costs not assessed | Proposed MJPEG camera-to-phone stream. The repository currently renders virtual camera frames; real stream integration and phone compatibility remain to be tested. |
| **In-Vehicle Connection (Count Only)** | **Bluetooth Low Energy** | Board-dependent | Optional future transport if counting is available on a capable edge device. No BLE counting integration or latency measurement is demonstrated here. |
| **Phone → Cloud / Twin Link** | **Firebase Realtime Database** or same-browser **BroadcastChannel** | Depends on usage, hosting and connectivity | GPS/session transport is implemented in [`firebaseTransport.ts`](./src/net/firebaseTransport.ts) and [`loopbackTransport.ts`](./src/net/loopbackTransport.ts). Publishing physical camera occupancy is additional integration work. |
| **AI Detection Model** | Candidate **YOLO head detector** on a phone, e.g. through TensorFlow.js | Weights, data and runtime licensing/costs must be checked | [`pipeline.ts`](./src/core/doorway/pipeline.ts) models detections with assumed miss rate (`5%`), jitter (`6%`), occlusion onset (`45%`) and latency (`25–40 ms`). No YOLO inference or training is currently integrated. |
| **Frame Rate & Resolution** | Simulation target: **`QVGA (320×240)` @ `24 FPS`** | Hardware benchmark pending | Rendered into a `320×240` target in [`PipRenderer`](./src/scene/doorway/PipRenderer.tsx) and sampled on a `24 Hz` simulated camera clock in [`CabinPipeline.tick`](./src/core/doorway/pipeline.ts). These are not measured capture/inference rates on an ESP32 or phone. |

### Why Front-Ceiling Cabin Mounting + Head Detection (Instead of a Pure 90° Doorway Mount)
1. **Full-Cabin + Doorway Coverage in One Lens:** In a traditional Philippine jeepney, mounting the ESP32-S3-CAM on the **front cabin ceiling (`x = 1.2 m, y = 2.12 m, z = 0 m`)** looking back over both benches toward the rear doorway (`REAR_X = -3.1 m`) allows a single camera to see **both** people stepping through the rear doorway **and** all 14 seated passengers along the left and right benches (`SEATS = 14`, max capacity `22` with standing/extended load).
2. **Why Heads Instead of Full-Body `COCO-SSD "person"` Boxes:** From the front of a packed jeepney, seated passengers' torsos and legs overlap along each bench, causing full-body bounding boxes to merge. Because the camera is mounted high on the ceiling (`y = 2.12 m`), passengers' **heads** separate vertically in the image plane the farther back they sit, remaining distinct and countable.
3. **Self-Correcting Hybrid Count:** Doorway crossings (`boarded` / `alighted`) are combined with a steady lower bound of visible heads in the cabin (`SteadyCount`), so if two passengers board closely and one crossing is occluded, the visible head count automatically corrects the total (`corrections++`).

---

## 2. Complete Technology Stack, Frameworks & Libraries

All frameworks and libraries configured in [`package.json`](./package.json):

| Category | Library / Framework | Version | Purpose in SakaySightAI |
| --- | --- | --- | --- |
| **UI Framework** | `react` / `react-dom` | `^19.3.1` | Declarative HUD panels, view controls, PiP overlay, and `/track.html` mobile web app. |
| **Language** | `typescript` | `^6.0.3` | Strict static typing across simulation math, geo projections, transport payloads, and 3D scene components. |
| **3D Engine** | `three` (`WebGPURenderer`) | `^0.186.1` | Core 3D rendering engine using `three/webgpu` (`WebGPURenderer` with automatic `WebGL2` fallback). |
| **React 3D Bridge** | `@react-three/fiber` | `^9.8.2` | React reconciler for Three.js driving the `useFrame` simulation and render pipeline. |
| **3D Controls & Helpers** | `@react-three/drei` | `^10.7.9` | `MapControls` camera controller and `<Html>` world-space stop/vehicle markers. |
| **UI State Management** | `zustand` | `^5.0.16` | Lightweight reactive store ([`src/app/store.ts`](./src/app/store.ts)) for UI state (mode, route, selected jeepney, camera view, FOV cone toggle, theme). |
| **Animation** | `gsap` / `@gsap/react` | `^3.15.0` / `^2.1.2` | Smooth camera shot transitions ([`src/scene/CameraRig.tsx`](./src/scene/CameraRig.tsx)) and passenger counter badge flashes ([`src/ui/CounterBadge.tsx`](./src/ui/CounterBadge.tsx)). |
| **Realtime Backend** | `firebase` (Realtime DB + Auth) | `^13.1.0` | Streams live GPS fixes and trip states from `/track.html` on a smartphone to the 3D twin dashboard. |
| **3D Vector Map Tiles** | `@mapbox/vector-tile`, `pbf`, `earcut` | `^3.0.0`, `^5.1.2`, `^3.2.4` | Decodes OpenFreeMap Protobuf vector tiles and triangulates polygons (buildings, water, parks, roads) inside a background Web Worker. |
| **Styling** | `sass-embedded` (SCSS) | `^1.106.1` | Design tokens, light/dark theme variables, dashboard layout, and mobile tracker stylesheet. |
| **Serverless AI API** | Vercel Functions ([`api/assist.ts`](./api/assist.ts)) | Node `>=22` | Calls Meta's OpenAI-compatible chat completions API (`META_API_KEY`, `META_MODEL`, `META_API_BASE`) to explain supplied twin telemetry with instructions to stay grounded in the computed plan. |
| **Build & Test Tooling** | `vite`, `vitest`, `eslint`, `prettier` | `^8.3.5`, `^5.0.5` | Multi-page bundling (`index.html` + `track.html`), HTTPS LAN phone dev mode (`@vitejs/plugin-basic-ssl`), the `/api` functions in the dev server, and the unit/integration test suite. |

---

## 3. Step-by-Step Simulation Pipeline

The following virtual-camera and counting stages are implemented and covered by simulation tests. These tests do not establish real camera, wireless transport or detector performance:

1. **[x] Step 1: Front-Ceiling Cabin Mounting & Physical 3D Sensor Model**
   - **Implementation:** [`src/scene/doorway/cabinCamera.ts`](./src/scene/doorway/cabinCamera.ts), [`src/scene/DoorwayScene.tsx`](./src/scene/DoorwayScene.tsx), and [`src/scene/world/CabinCameraFeed.tsx`](./src/scene/world/CabinCameraFeed.tsx).
   - **How it works:** The virtual ESP32-S3-CAM is mounted at `(1.2, 2.12, 0)` in the jeepney's ground frame, looking back at `(-3.3, 0.9, 0)` with a `100°` vertical FOV (`4:3` aspect ratio). A physical 3D ESP32-S3-CAM module (mounting bracket, dark PCB, gold lens ribbon, silver OV2640 barrel, glass lens, green LED) and a toggleable **Red FOV Detection Cone** spanning from the lens (`x = 1.2`) to the rear doorway (`REAR_X = -3.1`) are rendered inside both the Sensor Lab and the Live Twin.

2. **[x] Step 2: Frame Capture at `QVGA (320×240)` @ `24 FPS`**
   - **Implementation:** [`src/core/doorway/pipeline.ts`](./src/core/doorway/pipeline.ts) (`FRAME_W = 320`, `FRAME_H = 240`, `ESP32_HEAD_DETECTOR.fps = 24`) and [`src/scene/doorway/PipRenderer.tsx`](./src/scene/doorway/PipRenderer.tsx).
   - **How it works:** `CabinPipeline.tick(nowMs, capture)` runs on the camera's own `24 Hz` clock (`period = 41.67 ms`) independent of the monitor's refresh rate. If a new frame arrives before the previous frame's `25–40 ms` inference finishes (`exposedAt < busyUntil`), the frame is recorded as `dropped`, modelling the possibility of dropped frames; the latency values are assumptions.

3. **[x] Step 3: Phone-to-Twin GPS/Session Transport (Loopback + Firebase)**
   - **Implementation:** [`src/net/loopbackTransport.ts`](./src/net/loopbackTransport.ts) and [`src/net/firebaseTransport.ts`](./src/net/firebaseTransport.ts).
   - **How it works:** Works zero-config offline across browser tabs via `BroadcastChannel` (`LoopbackTransport`), and over the internet between a real smartphone and laptop via Firebase Realtime Database (`FirebaseTransport`) with anonymous authentication and security rules ([`database.rules.json`](./database.rules.json)).

4. **[x] Step 4: 3D-to-2D Head Projection & Realistic Detector Simulation**
   - **Implementation:** `projectPerson` in [`src/scene/doorway/cabinCamera.ts`](./src/scene/doorway/cabinCamera.ts) and `CabinPipeline.detect` in [`src/core/doorway/pipeline.ts`](./src/core/doorway/pipeline.ts).
   - **How it works:** Projects each rider's 3D head center (`HEAD_CENTRE_Y = 1.40 m` scaled by posture/stoop) into the `320×240` pixel frame via `ndc.project(cam)`. Computes apparent head width from distance (`focalPx = (FRAME_H / 2) / tan(vfov / 2)`), sorts people front-to-back by depth, computes pairwise bounding-box overlap occlusion (`overlapFraction`), applies random detector misses (`missRate: 0.05` amplified by occlusion above `0.45`), and adds Gaussian centroid/size jitter (`jitter: 0.06`).

5. **[x] Step 5: Greedy Nearest-Neighbour Centroid Tracking & Doorway Side Classification**
   - **Implementation:** [`src/core/doorway/centroidTracker.ts`](./src/core/doorway/centroidTracker.ts) and `cabinSide` in [`src/core/doorway/pipeline.ts`](./src/core/doorway/pipeline.ts).
   - **How it works:**
     - `CentroidTracker` matches detections frame-to-frame using Euclidean distance + box-width difference (`maxJumpPx: 10`, `maxMissedFrames: 6`, `maxSizeRatio: 1.4`).
     - `cabinViewFor(cam)` projects the 3D rear doorway opening (`x = -3.1`) into a 2D pixel rectangle `door` and computes the reference head width at the doorway threshold (`doorHeadWidthPx`).
     - `cabinSide(box, cabin)` classifies any head outside the doorway rectangle as `'in'` (inside the cabin). For heads seen inside the doorway rectangle, it compares `box.w / doorHeadWidthPx`: `< 1.05` is `'out'` (on the street behind the door), `> 1.35` is `'in'` (stepped inside the cabin), and `1.05 .. 1.35` is `'unsure'` (hysteresis band so pixel jitter cannot cause false flips).

6. **[x] Step 6: Hybrid Doorway Transition + Steady Head-Count Floor & HUD Telemetry**
   - **Implementation:** [`src/core/doorway/occupancy.ts`](./src/core/doorway/occupancy.ts), [`src/ui/PipOverlay.tsx`](./src/ui/PipOverlay.tsx), and [`src/ui/CounterBadge.tsx`](./src/ui/CounterBadge.tsx).
   - **How it works:**
     - `DoorTransitions` requires a tracked head to stay on the new side (`'out' -> 'in'` or `'in' -> 'out'`) for `CONFIRM_FRAMES = 3` consecutive detections before incrementing `boarded` or `alighted`.
     - `SteadyCount` computes the 80th percentile of visible cabin heads over a 24-frame (`~1 s`) rolling window and requires a new level to hold for `600 ms`. Whenever `heads.value > base + boarded - alighted`, `PassengerCounter` raises `base` and increments `corrections`.
     - Live telemetry (`FPS`, `latencyMs`, `dropped`, `current`, `boarded`, `alighted`, `seenNow`, `seenSteady`, bounding boxes, track IDs, and doorway rectangle) is rendered in real time on [`src/ui/PipOverlay.tsx`](./src/ui/PipOverlay.tsx) and [`src/ui/CounterBadge.tsx`](./src/ui/CounterBadge.tsx).

---

## 4. Mathematical & Simulation Models

### A. Geodesy, Polyline Map-Matching & GPS Noise Rejection
- **Local Tangent-Plane Projection ([`src/core/geo/projection.ts`](./src/core/geo/projection.ts)):**
  Converts WGS84 `(lat, lng)` around the route origin `(lat0, lng0)` into local scene metres `(x = East, z = South)` using `METRES_PER_DEGREE_LAT = 111_132.92` and `cos(lat0)` longitudinal scaling.
- **Uncertainty-Gated Speed Estimation ([`src/core/tracking/gpsFilter.ts`](./src/core/tracking/gpsFilter.ts)):**
  Rejects fixes with `accuracyM > 35 m`. Over a `15 s` rolling window, displacement $d = \text{haversine}(f_0, f_n)$ is only considered significant when:
  $$d > \sqrt{\sigma_0^2 + \sigma_n^2}$$
  This prevents stationary GPS drift (e.g., two $\pm 10\text{ m}$ fixes $3\text{ s}$ apart) from producing fake $12\text{ km/h}$ vehicle speeds.
- **Trip State Machine ([`src/core/tracking/tripState.ts`](./src/core/tracking/tripState.ts)):**
  Transitions `WAITING` $\rightarrow$ `POSSIBLE_VEHICLE` only when speed $\ge 3.5\text{ m/s}$ ($12.6\text{ km/h}$) with $\ge 4$ good fixes is sustained for $12\text{ s}$ while within the route corridor. Transitions to `CONFIRMED` **only** when the rider taps confirm. Leaving the route corridor for $30\text{ s}$ resets `POSSIBLE_VEHICLE` to `WAITING`.
- **Windowed Route Matching & Pose Extrapolation ([`src/core/tracking/liveVehicle.ts`](./src/core/tracking/liveVehicle.ts)):**
  Projects GPS fixes onto the route polyline within a window $[s_{\text{last}} - 60\text{ m},\; s_{\text{last}} + 250\text{ m}]$ so loop or out-and-back routes never snap to the opposite lane. Extrapolates forward along the polyline for at most `MAX_EXTRAPOLATION_S = 2 s` and blends the rendered 3D pose with exponential smoothing ($\tau = 0.5\text{ s}$). Vehicles turn `stale` after `8 s` without a fix and `lost` after `30 s`.

### B. Multi-Segment Passenger Boarding/Alighting, Two-Bone Arm IK & Bicycle Steering Model
- **Two-Step Climb & Cabin Aisle Trajectory ([`src/core/people/riderMotion.ts`](./src/core/people/riderMotion.ts)):**
  Every boarding passenger follows continuous segments parameterized by arc-length and speed:
  1. **Approach (`1.15 m/s`):** Walk from curb/street (`x = -6.2 m`) to the road spot behind the step (`stepOutsideX`).
  2. **Two-Step Climb & Grab-Pole Reach (`CLIMB_S = 0.62 s` per step):** Step from the road onto the rear bumper step (`L.step`), lifting the leading knee (`lift`, `liftLeg`), leaning forward from the hips (`CLIMB_LEAN = 0.28 rad`), and reaching both hands onto the entrance grab poles (`reach`), then climb onto the cabin floor while ducking (`DUCK = 0.84`) so the top of the head clears the `2.04 m` doorway header.
  3. **Center Aisle (`0.85 m/s`):** Walk forward along `z = 0` stooped under the low roof (`STOOP = 0.88`, `AISLE_LEAN = 0.12 rad`) to the assigned bench row `seat.x`.
  4. **Turn (`0.40 s`):** Rotate yaw toward the opposite bench (`yaw = ∓π/2`) while shifting laterally toward `seat.z`.
  5. **Sit (`0.85 s`):** Ease `sit: 0 -> 1` (thighs rotate to $+90^\circ$, shins to $-90^\circ$) and settle into a per-person seated habit (`lap`, `phone`, or `bag`).
  Alighting executes the exact reverse trajectory (`stand up → turn → aisle → step down onto step → down to road → walk away`) with single-file doorway spacing (`DOOR_SPACING_S = 1.0 s`) so riders never overlap in the doorway.
- **9-Mesh Instanced Human Rig, Two-Bone IK & Kinematic Bicycle Steering ([`src/scene/people/personRig.ts`](./src/scene/people/personRig.ts), [`src/scene/jeepney/jeepneyGeometry.ts`](./src/scene/jeepney/jeepneyGeometry.ts), [`src/scene/jeepney/JeepneyInstances.tsx`](./src/scene/jeepney/JeepneyInstances.tsx)):**
  - All passengers and drivers across the entire scene are drawn in **9 `InstancedMesh` draw calls** (`torso`, `pelvis`, `head`, `hair`, and paired `thigh`, `shin`, `foot`, `sleeve`, `forearm`).
  - **Turning Steering Wheel Mesh (`steeringWheelGeometry`):** Drawn as its own `InstancedMesh` at `STEERING = { centre: (1.3, 0.68, -0.46), rake: 40°, radius: 0.175 }` and rotated about its raked axis each frame by the **kinematic bicycle model**:
    $$\delta_{\text{wheel}} = \text{clamp}\!\left(R_{\text{steer}} \cdot \arctan\!\left(\frac{L \cdot \omega}{\max(v, 1.5)}\right),\; -2.4,\; +2.4\right)$$
    where $R_{\text{steer}} = 14$ (`STEERING_RATIO`), $L = 4.3\text{ m}$ (`WHEELBASE_M`), $\omega$ is the vehicle's smoothed yaw rate ($\text{rad/s}$), and $v$ is smoothed ground speed ($\text{m/s}$).
  - **Analytical Two-Bone Arm IK (`RigWriter.solveArm`):** Computes exact shoulder swing, splay, and elbow flexion angles from the law of cosines so both of the driver's hands lock onto the rotating steering wheel rim at "ten-to-two" (`rimPoint(±62°, handTurn)`) within `< 2 mm`, while the driver's feet work the pedals (`pose.pedal`), the torso pivots at hip height (`HIP_Y = 0.74 m`), and the head glances into the turn.

### C. LTFRB Traditional Jeepney Fare Formula ([`src/core/fare.ts`](./src/core/fare.ts))
- Base fare: **₱14.00** for the first **4 km**, plus **₱2.00** per additional started kilometre:
  $$\text{Fare}_{\text{regular}}(d) = 14 + 2 \cdot \max\bigl(0, \lceil d - 4 \rceil\bigr)$$
- Student / Senior Citizen / PWD **20% discount**, rounded to the nearest 25 centavos:
  $$\text{Fare}_{\text{discounted}}(d) = \frac{\text{round}\bigl(0.8 \cdot \text{Fare}_{\text{regular}}(d) \times 4\bigr)}{4}$$

---

## 5. Complete File-by-File Codebase Reference

### A. Root & Configuration Files
- [`index.html`](./index.html) — Main desktop/laptop entry page mounting the 3D Digital Twin & Sensor Lab ([`src/main.tsx`](./src/main.tsx)).
- [`track.html`](./track.html) — Lightweight mobile web page ([`src/tracker/main.tsx`](./src/tracker/main.tsx)) for in-vehicle GPS sharing and rider trip confirmation (zero Three.js bundle overhead).
- [`vite.config.ts`](./vite.config.ts) — Multi-page Vite configuration (`index.html` + `track.html`), `@` path alias (`./src`), and optional HTTPS (`@vitejs/plugin-basic-ssl`) when launched with `npm run dev:phone`.
- [`vercel.json`](./vercel.json) — Vercel configuration routing `/api/**/*.ts` serverless functions with a 30-second max duration.
- [`firebase.json`](./firebase.json) & [`database.rules.json`](./database.rules.json) — Firebase Realtime Database security rules requiring authentication and validating `vehicles/$sessionId/fix` and `status` schemas.
- [`scripts/fetch-route.mjs`](./scripts/fetch-route.mjs) — CLI script that fetches route geometry and nearby bus stops from OpenStreetMap Overpass / OSRM and outputs a pre-bundled `.route.json`.

### B. Serverless AI Assistant (`api/`)
- [`api/assist.ts`](./api/assist.ts) — `POST /api/assist` Vercel Serverless Function. Validates a live telemetry snapshot (`route`, `selectedVehicle`, `liveVehicles`, `simFleet`, `doorway`, `question`) and queries the Meta LLM with a strict grounding system prompt that forbids inventing numbers.
- [`api/health.ts`](./api/health.ts) — `GET /api/health` endpoint reporting whether `META_API_KEY` and `META_MODEL` are configured on the server.
- [`api/_lib/meta.ts`](./api/_lib/meta.ts) — OpenAI-compatible client wrapper for Meta's chat completion endpoint (`META_API_BASE`, `META_MODEL`, `META_API_KEY`).

### C. Pure Simulation & Domain Core (`src/core/` — Zero React/Three Dependencies, Unit Tested)
- **Geodesy & Routes (`src/core/geo/`):**
  - [`src/core/geo/projection.ts`](./src/core/geo/projection.ts) — Equirectangular tangent-plane projection (`toLocal` / `toLatLng`) and `haversineM`.
  - [`src/core/geo/polyline.ts`](./src/core/geo/polyline.ts) — Arc-length parameterized 2D polyline (`pointAt(s)`, `project(point, window)`).
  - [`src/core/geo/simplify.ts`](./src/core/geo/simplify.ts) — Ramer–Douglas–Peucker (`simplifyPolyline`) polyline simplification.
  - [`src/core/geo/routes.ts`](./src/core/geo/routes.ts) — Loads the bundled **Tungko – SM City Fairview (Quirino Highway)** route ([`src/data/tungko-fairview.route.json`](./src/data/tungko-fairview.route.json)), builds the offline synthetic road, parses uploaded GeoJSON/JSON routes, and converts live GPS traces into downloadable routes.
- **GPS Filtering & Live Vehicle Tracking (`src/core/tracking/`):**
  - [`src/core/tracking/types.ts`](./src/core/tracking/types.ts) — Shared types (`GpsFix`, `TripPhase`, `VehicleStatus`, `VehicleSnapshot`).
  - [`src/core/tracking/gpsFilter.ts`](./src/core/tracking/gpsFilter.ts) — `GpsFilter` accuracy and uncertainty-gated speed estimator.
  - [`src/core/tracking/tripState.ts`](./src/core/tracking/tripState.ts) — `stepTrip` finite state machine (`WAITING` $\rightarrow$ `POSSIBLE_VEHICLE` $\rightarrow$ `CONFIRMED` $\rightarrow$ `ENDED`).
  - [`src/core/tracking/liveVehicle.ts`](./src/core/tracking/liveVehicle.ts) — `LiveVehicle` windowed map-matching, bounded extrapolation, exponential smoothing, and staleness detection.
- **Cabin Camera Counting Pipeline (`src/core/doorway/`):**
  - [`src/core/doorway/centroidTracker.ts`](./src/core/doorway/centroidTracker.ts) — `CentroidTracker` greedy nearest-neighbour multi-object tracker with size-ratio gating.
  - [`src/core/doorway/occupancy.ts`](./src/core/doorway/occupancy.ts) — `DoorTransitions`, `SteadyCount`, and `PassengerCounter`.
  - [`src/core/doorway/pipeline.ts`](./src/core/doorway/pipeline.ts) — `CabinPipeline` orchestrating `24 Hz` frame capture, depth-sorted occlusion, detector noise/miss simulation, `cabinSide` classification, tracking, and telemetry generation.
  - [`src/core/doorway/doorwaySim.ts`](./src/core/doorway/doorwaySim.ts) — Ground-truth single-vehicle stop simulator for the **Sensor Lab** mode.
- **Articulated Passenger Choreography & Stop Queues (`src/core/people/`):**
  - [`src/core/people/riderMotion.ts`](./src/core/people/riderMotion.ts) — `RiderMotion` 5-stage continuous trajectory generator for boarding and alighting.
  - [`src/core/people/stopLayout.ts`](./src/core/people/stopLayout.ts) — Curb waiting queues, boarding approach waypoints, and sidewalk dispersal targets.
  - [`src/core/people/passengerSystem.ts`](./src/core/people/passengerSystem.ts) — Full-route passenger simulation across the supported vehicle types and their modelled stops.
- **Simulated Fleet & Fare Calculation (`src/core/fleet/`, `src/core/fare.ts`):**
  - [`src/core/fleet/fleetSim.ts`](./src/core/fleet/fleetSim.ts) — `FleetSim` simulating route-specific fleets of traditional/modern jeepneys, UV Express or buses, with headway spacing, stop dwell timers, working days and passenger demand.
  - [`src/core/fare.ts`](./src/core/fare.ts) — `fareFor(km, discounted, rule)` and `FARE_BY_VEHICLE` selecting prototype fare rules for traditional jeepneys, modern jeepneys, UV Express and buses; verify current matrices before deployment.
- **3D Vector Tile Map Builder (`src/core/map/`, `src/map/`):**
  - [`src/core/map/tiles.ts`](./src/core/map/tiles.ts), [`src/core/map/style.ts`](./src/core/map/style.ts), [`src/core/map/meshBuilder.ts`](./src/core/map/meshBuilder.ts), [`src/core/map/buildTile.ts`](./src/core/map/buildTile.ts), [`src/core/map/roadClearance.ts`](./src/core/map/roadClearance.ts) — Decodes OpenFreeMap z14 vector tiles, clips buildings back from road corridors, and merges each tile into at most 5 typed buffers (`land`, `water`, `roadCasing`, `roadFill`, `buildings`).
  - [`src/map/tileSource.ts`](./src/map/tileSource.ts) & [`src/map/tileWorker.ts`](./src/map/tileWorker.ts) — Fetches tiles around the active route and builds geometries off the main thread inside a Web Worker using zero-copy `Transferable` `ArrayBuffer`s.

### D. Application State & Runtimes (`src/app/`)
- [`src/app/store.ts`](./src/app/store.ts) — Zustand store holding UI state (`view: 'twin' | 'driver' | 'commuter' | 'doorway' | 'economics'`, `route`, `scenario`, `simulationSpeed`, `follow: { kind: 'sim' | 'live', …, view: 'chase' | 'inside' | 'pov' }`, `showFov`, `shot`, the network's status, the commuter's planned trip).
- [`src/app/twinRuntime.ts`](./src/app/twinRuntime.ts) & [`src/app/doorwayRuntime.ts`](./src/app/doorwayRuntime.ts) — Plain TypeScript runtime classes that advance the 60 FPS simulation outside React so moving vehicles and passengers cause **zero React re-renders**.

### E. 3D Scene, Instanced Public Utility Vehicles, Articulated People & Camera Rig (`src/scene/`)

- [`src/scene/vehicles/PuvInstances.tsx`](./src/scene/vehicles/PuvInstances.tsx), [`vehicleGeometry.ts`](./src/scene/vehicles/vehicleGeometry.ts) and [`puvCrew.ts`](./src/scene/vehicles/puvCrew.ts) — Instanced modern jeepneys, UV Express and buses with their own bodies, seating and passenger movement; [`doorCamera.ts`](./src/scene/vehicles/doorCamera.ts) defines their virtual door-camera placements.
- [`src/scene/Renderer.tsx`](./src/scene/Renderer.tsx) — Initializes Three.js `WebGPURenderer` (with automatic fallback to `WebGL2`), tone mapping, and shadow maps.
- [`src/scene/TwinScene.tsx`](./src/scene/TwinScene.tsx) — Main 3D Digital Twin canvas with `MapControls` configured for orbit-first rotation (`LEFT = ROTATE`, `RIGHT = PAN`) and dynamic `minDistance` (`0.35 m` in outside chase view, `0.08 m` in front/inside POV) so users can smoothly zoom in and orbit 360° around any jeepney.
- [`src/scene/CameraRig.tsx`](./src/scene/CameraRig.tsx) — Frame-ordered (`FRAME_ORDER.CAMERA`) camera controller supporting:
  - `overview` (full route framing),
  - `street` (close 3/4 street shot),
  - `chase` (zero-lag delta-tracked 360° outside orbit around the followed jeepney's cabin center `x = -0.5, y = 1.2`),
  - `inside` (full-viewport view directly through the ceiling ESP32-S3-CAM lens),
  - `pov` (**Front Cab / Driver POV** at `POV_EYE = (0.94, 1.50, 0.24)` seated beside the driver looking across the steering wheel, gauges, windshield wipers, and road ahead).
- [`src/scene/jeepney/jeepneyGeometry.ts`](./src/scene/jeepney/jeepneyGeometry.ts) & [`src/scene/jeepney/JeepneyInstances.tsx`](./src/scene/jeepney/JeepneyInstances.tsx):
  - Procedural Sarao-style Philippine jeepney merged by material slot into ~14 `InstancedMesh` draw calls for the entire fleet.
  - Features a realistic **step-in U-shaped front cab doorway** with chrome tubular trim, **flush matte-black dashboard** with recessed gauge rings and lower firewall, **dual windshield wipers**, connected steering column + 3-spoke steering wheel, floor gear shifter, clean front tire fenders, hood horses, side mirrors, and cushioned benches for 14 passengers (`SEATS = 14`).
  - **Direct 3D Clicking (Zero Draw-Call OBB Raycasting):** Hovering and clicking any jeepney in the 3D scene raycasts against `HIT_BOX` in local vehicle space; clicking the body selects Outside View (`chase`), and clicking the front cab (`x > 0.65`) switches to Front Cab POV (`pov`).
- [`src/scene/people/personRig.ts`](./src/scene/people/personRig.ts) & [`src/scene/people/PeopleInstances.tsx`](./src/scene/people/PeopleInstances.tsx):
  - Draws every articulated person in the scene in **9 `InstancedMesh` draw calls total**, including the driver's live push-pull steering, pedal footwork, torso lean, and mirror checks.
- [`src/scene/DoorwayScene.tsx`](./src/scene/DoorwayScene.tsx) & [`src/scene/world/CabinCameraFeed.tsx`](./src/scene/world/CabinCameraFeed.tsx):
  - Renders the Sensor Lab scene and attaches the physical `CabinCameraModel` + toggleable **Red FOV Detection Cone** (`showFov`) to the currently monitored jeepney in the Live Twin, feeding `PipRenderer` (`320×240` QVGA render target).

### F. UI Panels & Mobile Tracker (`src/ui/`, `src/tracker/`)
- [`src/ui/Header.tsx`](./src/ui/Header.tsx) — Top navigation bar switching between **Live twin**, **Driver app**, **Commuter app** and **Sensor lab** (the **Profit & service lab** opens from the Live twin), view FPS, backend/transport status badges, and phone tracker shortcut.
- [`src/ui/ViewControls.tsx`](./src/ui/ViewControls.tsx) — Floating viewport toolbar with direct **Jeepney `<select>` dropdown**, **Ride a jeepney / Next jeepney**, **Outside view**, **Inside view**, **Front POV**, **Show/Hide FOV cone**, **Whole route**, and **Street view** buttons.
- [`src/ui/TwinPanel.tsx`](./src/ui/TwinPanel.tsx) — Right sidebar showing route info, live GPS phones on the road, clickable simulated fleet cards (with plate, speed, stop status, and `ESP-CAM` passenger count), and LTFRB fare calculator.
- [`src/ui/DoorwayPanel.tsx`](./src/ui/DoorwayPanel.tsx) — Sensor Lab control panel comparing **Camera estimate** vs **Ground truth**, manual `+1 Board` / `-1 Alight` triggers, camera preset buttons (`Outside`, `ESP32-CAM`, `Rear door`), and `Show/Hide FOV cone` toggle.
- [`src/ui/PipOverlay.tsx`](./src/ui/PipOverlay.tsx) — Bottom-right `320×240` Picture-in-Picture HUD drawing the simulated ESP32-S3-CAM view, red head bounding boxes, track IDs, doorway threshold box, and live `FPS / latency / riders / boarded / alighted` telemetry.
- [`src/ui/AssistPanel.tsx`](./src/ui/AssistPanel.tsx) — AI Assistant panel that sends the current twin snapshot to `/api/assist`.
- [`src/tracker/TrackerApp.tsx`](./src/tracker/TrackerApp.tsx) & [`src/tracker/useGeolocation.ts`](./src/tracker/useGeolocation.ts) — Smartphone web app (`/track.html`) with live GPS status, accuracy/speed readouts, and explicit **"I'm on this jeepney"** / **"I got off"** controls.
- [`src/tracker/simulatedRide.ts`](./src/tracker/simulatedRide.ts) & [`src/tracker/useSimulatedRide.ts`](./src/tracker/useSimulatedRide.ts) — The **simulated ride** for testing indoors: GPS fixes along Tungko – SM City Fairview at jeepney speed (waiting at the first stop, dwelling at each stop), with everyday phone GPS error, through the same filter and trip state machine. Its sessions are `sim-…`.

---

## 6. Automated Test Suite

Run `npm test` to execute every Vitest unit and integration test (`src/**/*.test.ts`; the long multi-day simulations take about 10 minutes). Besides the network, flows, trip planning, fleet day cycle, advisory, economics, fuel and street-graph suites, these cover the original pipeline:
- [`src/core/core.test.ts`](./src/core/core.test.ts) (16 tests) — Equirectangular projection, polyline map-matching, Ramer–Douglas–Peucker simplification, `GpsFilter` noise rejection, `stepTrip` state transitions, `LiveVehicle` smoothing/staleness, and LTFRB fare calculation.
- [`src/core/doorway/pipeline.test.ts`](./src/core/doorway/pipeline.test.ts) (9 tests) — `CentroidTracker` identity preservation, occlusion handling, `DoorTransitions` confirmation, `SteadyCount` hysteresis, and `CabinPipeline` frame drops.
- [`src/scene/people/personRig.test.ts`](./src/scene/people/personRig.test.ts) (8 tests) — Analytical two-bone arm IK holding the steering wheel rim within `< 2 mm` across wheel turns (`0, +0.6, -0.9 rad`), clockwise steering geometry, driver backrest alignment, step-climbing knee lift, and ducking under the `2.04 m` doorway header.
- [`src/scene/doorway/cabinCamera.test.ts`](./src/scene/doorway/cabinCamera.test.ts) (4 tests) — End-to-end 3D projection + counting accuracy over three 10-minute simulated stop cycles (`seed 3, 5, 9`).
- [`src/core/people/passengerSystem.test.ts`](./src/core/people/passengerSystem.test.ts) (6 tests) — Multi-stop passenger queueing, boarding/alighting choreography, and capacity enforcement.
- [`src/core/motion.test.ts`](./src/core/motion.test.ts) (4 tests) — Continuous `RiderMotion` pose trajectories, doorway crossing times, and smooth fleet headway driving.
- [`src/core/map/map.test.ts`](./src/core/map/map.test.ts) (10 tests) & [`src/core/map/roadClearance.test.ts`](./src/core/map/roadClearance.test.ts) (6 tests) — Vector tile geometry building and road-building clearance clipping.
- [`src/scene/CameraRig.test.ts`](./src/scene/CameraRig.test.ts) (3 tests) — Zero-lag moving cabin camera invariance across frame subscription orders.

---

## 7. Instructions: Setup, Running, Phone Demo & Deployment

### 1. Install & Run Locally
```bash
npm install
npm run dev
```
- Open **`http://localhost:5173`** for the 3D Digital Twin & Sensor Lab dashboard.
- Open **`http://localhost:5173/track.html`** in a second window to test the mobile GPS tracker immediately using the zero-config same-browser loopback; tick **Simulate a ride** to drive a phone jeepney along Tungko – SM City Fairview without leaving your desk.
- `npm run dev` also serves the `/api` functions (assistant, voice), with their keys read from `.env` on the server side only.

### 2. Verify Typecheck, Lint, Tests & Production Build
```bash
npm run typecheck
npm run lint
npm test
npm run build
```

### 3. How to Interact with the 3D Twin & Sensor Lab
- **Choose Any Jeepney:** Click any jeepney directly on the 3D road, pick one from the top toolbar dropdown, or click any vehicle card in the right **Simulated fleet** list. The simulation's clock, speed, skip nights, other routes and **All jeepneys data** are at the bottom left of the map.
- **Inspect Outside, Inside & Front Cab POV:**
  - While following a jeepney, **left-drag** to orbit 360° around the cabin, **scroll** to zoom right up to the windows, and **right-drag** to pan.
  - Click **Front POV** in the toolbar (or click the front hood/cab of the jeepney in 3D) to sit beside the driver and watch the live steering, pedals, gauges, and road ahead.
  - Click **Inside view** to look directly through the ceiling-mounted ESP32-S3-CAM lens.
  - Click **Hide FOV cone / Show FOV cone** to toggle the red 3D camera frustum inside the cabin.

### 4. Connect a Real Smartphone over Wi-Fi / Internet (Optional)
1. Copy `.env.example` to `.env` and fill in your `VITE_FIREBASE_*` keys from a free Firebase Spark project (enable **Realtime Database** and **Anonymous Auth**).
2. Deploy database rules: `npx firebase-tools deploy --only database`.
3. Run `npm run dev:phone` and open `https://<your-laptop-LAN-IP>:5173/track.html` on your phone (or deploy to Vercel for automatic HTTPS).
