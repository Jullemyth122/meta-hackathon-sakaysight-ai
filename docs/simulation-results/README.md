# SakaySightAI profit simulation results (model `roi-events-2`)

Seeded event simulation (`scripts/simulate-economics.mjs`, same model as the
"Profit & service lab" tab). Every row compares the same riders, fares, traffic
and fleet under three policies: no app, planner only, planner + Muse AI. Driver
cash = fares − diesel (₱94.55/L unless stated) − ₱700 boundary − ₱100 other −
app costs − AI costs. Each folder has `inputs.json`, `summary.json`, the full
`daily-ledger.csv` and `audit.json` (passenger samples, per-jeepney ledgers).

Rider mix: 65% regular, 20% student, 8% senior, 5% PWD (20% off), 2% pregnant
(regular fare; no legal discount). Fare: ₱14 first 4 km + ₱2 per started km.

| # | Scenario (30–31 days × 10 seeds) | Driver cash/jeepney/day: none → planner | Δ per jeepney per month | Wait: none → planner | Served: none → planner |
|---|---|---|---|---|---|
| 1 | SM Tungko–Fairview, 50k trips, 200 jeeps | ₱121 → ₱415 | **+₱8,815** | 2.0 → 0.9 min | 99.87% → 99.98% |
| 2 | Same, 100k trips, 200 jeeps (stress) | ₱3,995 → ₱4,199 | +₱6,132 | 20.1 → 20.1 min | 95.53% → 95.45% |
| 3 | Same, 200k trips, 300 jeeps, 31 days (stress, overloaded) | ₱6,192 → ₱6,328 | +₱4,237 | 40.1 → 42.2 min | 91.11% → 90.91% |
| 4 | SM Tungko–Lagro, 100k trips, 200 jeeps | ₱3,794 → ₱3,997 | +₱6,076 | 13.6 → 13.9 min | 98.31% → 97.31% |
| 5 | #1 but drivers already wait 10 min at terminals | ₱534 → ₱594 | +₱1,804 | 3.0 → 1.5 min | 99.81% → 99.98% |
| 6 | #1 at ₱130/L diesel (March 2026 spike) | −₱1,126 → −₱722 | +₱12,137 | 2.0 → 0.9 min | same as #1 |

**Muse AI.** At the same advice-following rate as the planner, Muse only adds its
bill: ₱1.94 (50k trips) to ₱3.01 (200k trips) per jeepney per day. If hands-free
voice makes drivers follow the advice more often, it pays: 60% instead of 50%
→ +₱1,802 per jeepney per month over the planner (#7); 70% → +₱3,644 (#8).
Break-even is about half a percentage point more follow-through. That uplift is
a hypothesis for a pilot, not a measured effect.

**Where the money comes from.** Almost all of it is diesel: advice-following
drivers leave a busy terminal at once and, at a quiet one, wait for riders (up to
15 minutes, until 90% of seats are taken) instead of driving a near-empty trip.
Fares barely change, because riders are not created by the app.

**Limits.** Synthetic demand: no verified daily ridership exists for this
corridor, so 100k/200k are stress tests; #5 is the one closest to reported 2026
driver take-home (₱400–800/day), while #1 (₱121/day) assumes drivers barely
wait at terminals, which real terminal queues do not support. The return trip reuses outbound stop distances.
No traffic interactions, abandonment or other routes. Busy corridors trade a
little service (#3, #4: up to 1% fewer trips served) for the diesel saved.

**Model `roi-events-3` (current app).** The jeepneys' start order now changes
every day, as a terminal's line does, so no jeepney is always the one right
behind another; each jeepney's own day (riders, trips, km, diesel, fares, net)
is kept for the driver app. Fleet averages are unchanged within a few pesos
(Tungko route, 20 jeepneys: ₱639 → ₱728 a day with SakaySightAI; SM Tungko–SM
Fairview, 200 jeepneys: ₱538 → ₱588). The rows above were run with
`roi-events-2`. Single days swing more than drivers report (no terminal
dispatcher keeping jeepneys apart is modelled); month averages per jeepney fall
within ₱380–850 a day without the app.

**Fleet size (28 Oct 2026).** LTFRB publishes no per-route unit counts, and the
2015 GTFS feed lists the same placeholder frequency (one a minute) for 331 of
its 332 routes. A regular rider of the corridor estimates one jeepney passing a
Quirino Highway stop about every minute, at the rush and at midday alike. The
lab's default corridor fleet is now 100 (a round trip takes 80–110 minutes in
the model, so one leaves each terminal every 1.0 minute): ₱528 → ₱584 per
jeepney a day (₱13,730 → ₱15,187 per 26-day month). The live twin starts with
60 jeepneys on its 20 km loop for the same headway.

**Live twin working day (28 Oct 2026).** The 3D twin now runs whole days: day 1
starts at 4:30 AM with every jeepney parked at its terminal; they leave one by
one, drive at the hour's traffic speed (about 11.7 km/h at the rush, 15–16 km/h
at midday, stops included, so SM Tungko → SM Fairview takes ~44 / ~33 min),
load at the terminal line (the pila: until 90% full, up to 5 minutes), knock off
between 8:30 and 10 PM, finish the trip to a terminal and park. The ledger
closes at 3 AM and the clock stops after day 31. Crowds use a literature-informed
scenario of 300 riders per jeepney a day, not a measured corridor count (see the
[source register](../evidence-and-decision-math.md)). Measured in simulation on the Tungko–SM Fairview loop with 60
jeepneys: ~11 on board at the rush, 128 km and 29 L a day, ₱700 net a day. The
lab's default day (6 AM, 14 hours, 250 riders) gives ₱528; with the twin's day
(5 AM, 16 hours, 300 riders) it gives ₱888. All three sit inside the ₱400–800
(to ₱1,300 on busy routes) that boundary drivers report.

**Route paths cleaned, day v3 (29 Oct 2026).** 22.5% of the network's road
path (1,897 of 8,426 km over 332 routes) was the router's out-and-back spurs:
U-turns to stops on the far side of divided roads and squiggles across
intersections, which made jeepneys go round in small circles. They are cut
(src/core/network/spurs.ts; the data file was cleaned once with
scripts/despur-network.mjs, original kept outside the repo). Drivers now set
out between 5:30 and 6:30 AM and knock off between 9 and 11 PM, new times
every day; boundary drivers collect and leave the jeepney at the operator's
terminal, owner-drivers at home (at least 800 m from a terminal); the head of a
terminal line waits 2 to 5 minutes; each jeepney has a 45 L tank (an
assumption) and fills up at the next station on its side of the road below a
quarter, for 4 to 7 minutes off the lane.

**Owner-drivers and home spots (29 Oct 2026).** Not every driver pays boundary:
by default a quarter own their jeepney (an assumption; no published share),
pay no boundary but ₱200 a day of their own upkeep (also an assumption), in the
lab and the twin alike. In the twin each jeepney is kept overnight at its own
spot along the route (near the driver's home): it pulls out there between 4:30
and 5:45 AM and, after the last trip to a terminal, drives home empty (that
diesel counts) and parks. One day, 60 jeepneys: boundary drivers ₱660 net,
owner-drivers ₱853 (₱17,150 and ₱22,190 over 26 working days). The lab's
default corridor is now ₱648 → ₱701 per jeepney a day with SakaySightAI.

**Calibration (lab and driver app defaults).** Scenario #5 is the one that
matches what boundary drivers report (₱400–800 a day net; ₱10k–20k a month):
about 250 riders per jeepney a day and drivers already queueing ~10 minutes at
terminals. It is now the default in the Profit & service lab and in the driver
app's "My earnings" projection. The North Caloocan figure of 500–550k daily
commuters (all modes, all destinations) is not one corridor's jeepney ridership.
