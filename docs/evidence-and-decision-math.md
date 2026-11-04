# SakaySightAI: evidence, decisions and the path to a live product

SakaySightAI aims to make every seat, stop and peso count across **traditional jeepneys, modern jeepneys, UV Express and buses**. Its product hypothesis is that sharing timely information about vehicles, seats and passengers can reduce missed pickups, wasted driving and unnecessary walking. This document explains the evidence behind that idea and the arithmetic needed to test it.

## Vehicle scope of the evidence and examples

The simulator represents all four vehicle types through [vehicle specifications](../src/core/vehicles/specs.ts), [service rules](../src/core/vehicles/stops.ts) and [fare rules](../src/core/fare.ts). The decision framework is shared, but the evidence is not interchangeable: much of the research cited below and the saved financial experiments concern traditional jeepneys. They do not establish fuel economy or savings for a bus, UV Express or modern jeepney.

Apply the formulas with the actual vehicle's capacity, fare, permitted pickup locations, measured fuel use, operating costs and driver/operator arrangement. The 14-seat boarding example below is explicitly a **traditional-jeepney illustration**. A terminal-only UV service cannot use a proposed intermediate roadside pickup; a bus pickup must follow its service's stops. Vehicle-specific virtual cameras and layouts also need separate hardware validation, and a component target for one camera is not a complete multi-door bus installation budget.

## Product stage and funding disclosure

**SakaySightAI is a demo-product prototype built through simulation, intended to become a live transport product.** The author reports that the team currently lacks the funding to produce and install the camera hardware and run a real fleet pilot. The simulation is the team's affordable way to develop the experience, exercise decisions and make the proposed system reviewable before that investment.

There is working software for simulation, browser GPS transport, deterministic planning and configured Meta API integrations. Physical ESP32-to-phone image inference, reliable live passenger-demand collection and field-validated savings are still development and pilot work. The architecture offers a plausible implementation path; it does not prove that the complete live product will work without further engineering. Funding is one constraint alongside data quality, integration, reliability and operator adoption.

The intended deployment is: **camera images → phone detector/counting → occupancy and GPS updates → planner → Meta voice/context explanation → human decision → measured outcome**. The ESP32 is proposed as the camera, the phone as the inference device, and Meta as the speech/context layer. YOLO detection and transport arithmetic are not attributed to Meta.

## What is based on real evidence?

**The prototype combines published research, geographic data, a dated price snapshot, local observations and explicit modelling assumptions.** It is not a continuous measured dataset covering every year from 2016 to 2026. Publication year, observation year and projection year must be distinguished; a report forecasting 2026 is not a 2026 field measurement.

The author's research spans the 2016–2019 and 2020–2026 periods. The audit below identifies the specific sources verified for this documentation. It does not retroactively claim that every newly linked reference originally calibrated the code. No separate 2019 or 2020 parameter source is asserted without an identifiable citation and matching value.

| Source and date | What it supports | How to use it in SakaySightAI |
| --- | --- | --- |
| [DOTr/GIZ, Jeepney+ NAMA, 2016](https://changing-transport.org/publications/transforming-public-transport-in-the-philippines/) | Historical transport-sector context and the case for operational improvements. The report includes forward-looking scenarios as well as historical evidence. | Background for the problem and study design. Do not import a historical fleet count or a projection as today's corridor count. |
| [SAE study 2018-01-1758, 2018](https://saemobilus.sae.org/papers/development-drive-cycles-measurement-fuel-economies-light-duty-vehicles-metro-manila-2018-01-1758) | Its developed public-utility-jeepney drive cycle averages **10.87 km/h**. The **3–12 km/L** range in the abstract covers all tested light-duty vehicle types, not jeepneys alone. | A historical reasonableness check for slow urban service. It does not prove the app's 6 km/L assumption or today's Tungko–Fairview traffic. |
| [Mendoza, UP CIDS Discussion Paper 2021-02](https://cids.up.edu.ph/wp-content/uploads/2022/02/UP-CIDS-Discussion-Paper-2021-02.pdf), financial analysis, printed pp. 24–31 | Analyses financial outcomes under different daily passenger totals, including **200 and 300 passengers**. | The 300-rider input referenced in `scenario.ts` should be treated as a scenario informed by literature, not an observed route average. The economics lab's 250 riders per vehicle per day is likewise an adjustable model input. |
| [UP CIDS Policy Brief 2023-01](https://cids.up.edu.ph/wp-content/uploads/2023/03/Putting-Transport-Workers-and-Commuters-First-The-Route-to-Just-Transition-in-Public-Transport-Modernization.pdf), p. 1 | Describes the accessibility of jeepneys and cites older work for access within 500 m. | Context for first-mile access. It does not validate today's walkability, a pickup location, or the software's separately chosen 500 m approaching-rider radius. |
| [DOE NCR fuel monitoring, October 20–26, 2026](https://d24qbtp4vooyzi.cloudfront.net/api/media/file/NCR%20Price%20Monitoring%2010202026.pdf?prefix=dev%2Fmedia) | Dated city/brand fuel-price ranges and common prices. The app's bundled snapshot records common diesel prices of ₱95.80/L for Caloocan and ₱93.30/L for Quezon City. | Source metadata and values are in [`diesel-prices.json`](../src/data/diesel-prices.json). The application's common-price reference is their arithmetic mean, **₱94.55/L**, not a market-share-weighted corridor average or a live pump quote. |
| OpenStreetMap/OpenFreeMap and the bundled 2015 DOTC GTFS network | Real geographic features and historical route/stop information. | Spatial inputs, not live congestion, occupancy or proof that every transit route still operates. See [`network.ts`](../src/core/network/network.ts). |
| Author/local-rider observations recorded in October 2026 | Rough headway and operational assumptions, described in [`scenario.ts`](../src/core/fleet/scenario.ts) and the [simulation log](./simulation-results/README.md). | Informal observations, not an instrumented survey. Record route, time, sample size and method before claiming measured calibration. |

Earlier notes/code comments mention JICA/MMDA/IBON totals and driver earnings ranges without complete page-level citations for every number. Those remain background claims requiring source reconciliation, not verified calibration evidence. Historic fares, incomes and diesel prices must not be compared across years as if their purchasing power and operating conditions were unchanged.

### Explicit assumptions and model boundaries

| Input | Current location/value | Evidence status |
| --- | --- | --- |
| Moving fuel economy, idling and restart fuel in the economics lab | [`economics/model.ts`](../src/core/economics/model.ts): 6 km/L, 0.8 L/hour, 0.02 L/restart | Adjustable assumptions requiring measurements on the target vehicle. |
| Short-horizon advisory fuel model | [`advisory/model.ts`](../src/core/advisory/model.ts): 0.14 L/km base + 0.0025 L/km per onboard rider; 0.028 L per stop-and-go | A different approximation from the economics lab. Do not combine the two as independent savings. |
| Approaching-rider visibility | [`approach.ts`](../src/core/advisory/approach.ts): known approaches within 500 m | Product parameter. Current positions and arrival times come from simulated journeys. |
| Walking speed in network planning | [`network/plan.ts`](../src/core/network/plan.ts): 1.2 m/s | Assumed speed; network access distances are approximate, not verified accessible walking routes. |
| Tank level and capacity | Fleet simulation and driver screen | Simulated fuel state, not a physical fuel-sensor reading. A live product needs reliable measurement or a clearly labelled estimate. |
| Owner share, upkeep, boundary, ridership and advice adoption | Fleet scenario and economics inputs | Scenario settings, not universal driver facts. Meta adoption uplift is a hypothesis. |

Saved [experiment outputs](./simulation-results/README.md) include their own model versions and assumptions. The current code declares `roi-events-4`; older `roi-events-2` results are not a fresh run of that model. No new simulation was run for this documentation revision.

## Decision 1: notice approaching passengers before leaving

**Example interpretation: eight seats are empty/available**, not occupied. Suppose a 14-seat traditional jeepney has six passengers aboard and four people are approaching a permitted pickup point. The useful alert is their number, direction, distance, estimated arrival and whether space remains after the queue ahead of them boards.

**Available now in the simulation:** an approaching-passenger heads-up, walking/tricycle modes, distance/ETA, and a comparison with the vehicle's ETA. [`arrivalHeadsUp`](../src/core/advisory/driver.ts) says to recheck on arrival; approaching riders do not automatically change the stop/pass decision or reserve seats.

**Proposed addition:** a bounded hold recommendation at an approved stopping point, considering incremental riders, onboard delay, queue order and downstream service. This is not implemented by the current approaching-rider alert. The economics lab's terminal-hold policy is a separate experiment, not this roadside feature.

For a simplified fixed-size eligible group:

```text
available seats A = max(0, permitted seat capacity − onboard − seats needed by the prior queue)
eligible group N = people travelling in this direction who can reach the pickup within the hold limit
expected additional boardings = min(A, N) × q
expected extra fares = expected additional boardings × average applicable fare
expected driver gain = expected extra fares
                    − additional idling/boarding/load fuel cost
                    − additional operating and AI cost
                    − expected lost earnings elsewhere from the delay
```

`q` is the assumed probability that each eligible rider produces a genuinely additional boarding for this driver compared with leaving now. It is not a model confidence score or measured prediction yet. Real queues with different probabilities need a fuller capacity-constrained calculation. Actual people board in whole numbers; an expected value can be fractional.

**Illustrative arithmetic, not a fare quotation or measured outcome:** A = 8, N = 4, q = 0.8, no passengers ahead in the waiting queue, average fare = ₱15, extra hold = 45 seconds, idle rate = 0.8 L/hour and diesel = ₱95/L. Assume 0.05 L of additional boarding/load fuel, ₱0.30 allocated incremental operating/AI cost and ₱6 of expected lost earnings from delay.

| Quantity | Calculation | Result |
| --- | --- | --- |
| Expected additional boardings | min(8, 4) × 0.8 | 3.2 |
| Expected extra gross fares | 3.2 × ₱15 | ₱48.00 |
| Extra idling cost | (45 ÷ 3,600) × 0.8 × ₱95 | ₱0.95 |
| Other incremental fuel | 0.05 × ₱95 | ₱4.75 |
| Other costs/opportunity cost | ₱0.30 + ₱6 | ₱6.30 |
| Expected driver gain | ₱48 − ₱0.95 − ₱4.75 − ₱6.30 | **₱36.00 for this event** |

With these same simplified costs, break-even is q = 12 ÷ (4 × 15) = **20%**. At q = 10%, expected gain is **−₱6**. The six onboard passengers also incur **4.5 passenger-minutes** of holding delay (6 × 45 ÷ 60), before downstream effects. That service cost must be tracked even if it is not charged to the driver's cash ledger.

Do not delay requested drop-offs, exceed permitted capacity, stop in an unsuitable location or indefinitely wait for an uncertain rider. Recheck updated ETAs and use a maximum hold. A rider transferred from another vehicle is not automatically new revenue for the fleet. A rider this same driver would have picked up anyway is not an incremental gain. The alert's value must be tested against those alternatives.

## Decision 2: buy cheaper diesel without risking an empty tank

**Available now:** stations ahead on the driver's side of the route, nearest and lowest estimated price among the offered candidates, estimated top-up savings, and simulated tank context. [`fuelAdvice`](../src/core/fuel/stations.ts) compares point estimates from dated price ranges; it is not a complete route-wide refuelling optimiser. “Cheapest” is limited to the offered stations with known prices.

**Proposed improvement:** a conservative reachability calculation using reliable tank inputs, reserve fuel, expected congestion and station availability. First decide which stations are reachable; then compare their total incremental cost.

```text
usable fuel = estimated tank litres − reserve litres
fuel to station = on-route km ÷ expected km/L + expected idle fuel
reachable only if fuel to station ≤ usable fuel
purchase saving = litres purchased × (reference price − alternative price)
net refuelling benefit = purchase saving − extra fuel cost − extra time/other costs
```

**Illustrative example:** tank = 3 L, reserve = 1.5 L, candidate station = 3 km ahead, fuel economy = 6 km/L. Reaching it consumes 0.5 L before idle allowance, within the 1.5 L usable budget. A two-minute extra queue at 0.8 L/hour adds about 0.027 L. These are assumptions, not a guarantee of range.

If buying 30 L at ₱92/L instead of ₱95/L, gross purchase savings are **₱90**. Value the additional queue fuel at ₱95/L (about ₱2.53) and assume ₱10 of lost earning opportunity: the illustrative net benefit is **₱77.47**. The 3 km is on the route and would be driven anyway, so it is included in reachability but not charged again as an extra detour. Extra forecourt travel or a true detour must be charged separately. The purchase volume must fit the tank.

The current guidance keeps drivers on their franchise route. Do not recommend a shortcut or U-turn just to reach a cheaper pump. Overlapping price ranges mean even the direction of savings can be uncertain; show the observation date and confirm the actual price. Fuel quantity in a live product should come from measured telemetry or an explicitly uncertain driver-entered/refill-based estimate.

## Decision 3: reach a closer pickup point from a secondary road

**Product idea:** a commuter walks along a secondary road to an approved pickup point on the selected vehicle's existing route, instead of travelling farther to their usual waiting area. The vehicle stays on its route and boarding remains subject to its service rules. A nearer point is useful only if the commuter can reach it before the vehicle, the vehicle can stop there in the correct direction, and space remains.

**Available now:** the network planner compares candidate mapped stops and direct/one-transfer journeys with walking or tricycle access; the focused commuter view excludes vehicles arriving before the simulated person reaches their stop. **Proposed addition:** jointly choosing a new rendezvous point using a verified pedestrian path, permitted pickup locations, live updates and uncertainty. The current planner does not promise arbitrary roadside interception or verified walking shortcuts.

```text
time to pickup = verified walk distance ÷ personal walking speed + crossing/access delay
catchable if time to pickup + uncertainty buffer ≤ vehicle ETA at that point
choose among feasible points using total journey time, fare, access needs and seats
```

**Illustrative example:** the usual waiting area is a 650 m walk; a verified alternative pickup is 180 m away. At 1.2 m/s, walking takes about **9.03 minutes versus 2.50 minutes**, a **470 m / 6.53-minute walking reduction**. Add 20 seconds for crossing and a 30-second buffer at the nearer point. Required lead time becomes **200 seconds**. If the vehicle arrives in four minutes (240 seconds), the margin is **40 seconds**. If its ETA falls below 200 seconds, that recommendation is no longer feasible.

This is walking-time savings, not automatically 6.53 minutes off the whole journey. Compare the actual next catchable vehicle and downstream arrival at both points. Do not ask people to run into traffic or cross a barrier; accessibility, crossings and boarding restrictions are hard constraints. If live information becomes stale, withdraw the precise interception advice and fall back to a known stop.

## Other decisions worth testing

| Decision | Existing foundation | Additional proof or product work |
| --- | --- | --- |
| Avoid a full vehicle and select the next catchable one | Queue-aware seats and arrival estimates | Real occupancy, reliable queue estimates and honest uncertainty; seats are not reserved. |
| Avoid unnecessary empty stops | Stop/pass recommendations and a fuel estimate | Detect unregistered/offline waiting riders and honour drop-offs. “No app report” must not mean “nobody there.” |
| Reduce near-empty terminal departures | Economics lab's demand-aware hold experiments | Actual terminal demand, dispatcher practices, fairness between drivers and maximum passenger wait. |
| Avoid an unnecessary tricycle fare | Walking/tricycle access comparison | Verified pedestrian paths, accessibility and user preference. A longer or unsafe walk is not a useful saving. |
| Explain delay and the next best choice | Time-dependent traffic simulation and voice/context interface | Live congestion evidence and measured ETA errors; the current demo does not detect city-wide traffic. |
| Keep multiple drivers from chasing the same demand | Deterministic queue assignments | Live participation, driver coordination and evidence that service improves across the fleet. |
| Understand actual take-home earnings | Trip budgets, boundary/owner settings and daily ledgers | Trip records, receipts, maintenance and all recurring costs, rather than gross fares alone. |

## How savings should be accounted for

The current short-horizon advisory estimates fuel as:

```text
litres = distance_km × (0.14 + 0.0025 × onboard_riders) + 0.028 × planned_stops
stop-saving estimate = (comparison_stops − planned_stops) × 0.028 × diesel_price
```

For three genuinely unnecessary stops avoided and an illustrative ₱95/L, this is **0.084 L or ₱7.98**. The comparison must reflect what the driver would actually do. Comparing against a driver who stops at every empty stop can overstate the benefit. The coefficients are assumptions, and the simplified calculation does not fully model load changes or traffic interactions.

The economics lab uses a separate event ledger:

```text
fuel litres = moving km ÷ km_per_litre + idle hours × idle_litres_per_hour
            + restart count × restart_litres
driver net = collected fares − diesel cost − boundary OR owner upkeep
           − other operating/maintenance costs − app/data/hardware share − AI costs
incremental benefit = net with intervention − net under a realistic comparison policy
```

Use the same demand, fares and traffic when comparing policies. Account for every cash cost once. Savings in litres and savings from a different pump price overlap in the total fuel bill; separate attribution should reconcile to the ledger. Do not add the independent illustrative examples above into a daily income claim or multiply them by every operating day without observed event frequency.

Meta's financial case is incremental too: compare **planner + Meta against planner alone**, holding other settings equal. In the saved experiments, equal assumed adoption adds AI cost without an adoption benefit. Voice could improve understanding and follow-through, but that must be measured. API spend, connectivity and device costs count against the benefit.

## A practical pilot and funding path

Start with one corridor and a small volunteer fleet, rather than assuming city-wide coverage. Funding and partner support would pay for camera kits, mounting/power, phone compatibility work, connectivity, installation, annotated test footage, field observation and maintenance. The under-₱600 camera-component target is not a complete deployment budget and assumes an existing phone.

1. **Validate inputs:** compare camera occupancy with manual counts; measure GPS/ETA error, passenger participation, fuel use and actual pump prices. Record missing data and offline riders.
2. **Run in observation mode:** log suggested decisions without changing operations. Check whether the inputs and predictions match what happens.
3. **Trial guidance with drivers and a dispatcher:** compare matched shifts or a crossover design while recording route, hours, traffic, demand, fares and price changes.
4. **Measure both sides:** net driver income after all costs; diesel per completed passenger trip; commuter total journey time and wait distributions; missed pickups, unserved riders, crowding and onboard delay. Include days and drivers that lose out, not only averages.
5. **Measure Meta's specific benefit:** task completion, answer accuracy, response time, advice understanding/follow-through and incremental cost versus planner-only use. Keep any interactions compatible with safe vehicle operation.

A product claim should follow the evidence: “under these pilot conditions, these drivers and commuters saw this measured change,” with sample size and uncertainty. Until then, SakaySightAI is a research-informed, simulation-led product prototype with a concrete deployment plan and testable benefits.
