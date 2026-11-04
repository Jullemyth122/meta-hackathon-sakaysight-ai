/**
 * What the Sakay Agent can do, as Muse is told it. Muse picks the tools;
 * the app runs them (app/agentTools.ts) in the browser, where the twin lives,
 * and Muse answers from what they return. Pure data: the server reads this too.
 */

export type AgentRole = 'driver' | 'commuter' | 'operator';

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required?: string[];
    };
  };
}

const tool = (
  name: string,
  description: string,
  properties: ToolSpec['function']['parameters']['properties'] = {},
  required: string[] = [],
): ToolSpec => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const SHOW_ON_MAP = tool(
  'show_on_map',
  'Move the 3D map to a stop by name or a vehicle by plate, to show the person what you are talking about.',
  {
    stop: { type: 'string', description: 'Stop name' },
    plate: { type: 'string', description: 'Vehicle plate' },
  },
);

const DRIVER_TOOLS: ToolSpec[] = [
  tool('traffic_ahead', 'How slow the road ahead of this driver is right now, and the delay.'),
  tool(
    'find_shortcut',
    'Find a way round the traffic by side streets and reroute this vehicle onto it at once: off the road on the driver’s side, back on the same road before any stop a rider on board gets off at. Also gives gas stations along it, riders coming along it, and the riders it would skip. Says plainly when there is no good one.',
    { fuel: { type: 'string', description: 'Fuel wanted at a station on it, e.g. diesel' } },
  ),
  tool(
    'compare_ways',
    'Which way earns the driver most, diesel included: weighs the ways on from here, side by side and drawn on the map: staying on the route, and up to two ways round by side streets. For each: km, minutes in this traffic, riders it picks up (at the stops on it, or waiting by its side streets), their fares, diesel litres and pesos, and the net (fares less diesel). Says which nets the driver most and which leave the franchise route. Then call take_way.',
  ),
  tool(
    'take_way',
    'Drive one of the ways compare_ways weighed, by its letter: A stays on the route.',
    { way: { type: 'string', description: 'A, B or C, as compare_ways named them' } },
  ),
  tool(
    'vehicles_ahead',
    'Whether there are too many vehicles ahead: their free seats against who is waiting, and whether to hold back, pass when clear, or carry on.',
  ),
  tool('seats_for_next_stops', 'Whether this vehicle’s seats are enough for the next stops.'),
  tool(
    'late_riders',
    'Who will reach the stops ahead just after this vehicle passes (by 1 to 3 minutes).',
    { within_min: { type: 'number', description: 'How many minutes late to look, default 3' } },
  ),
  tool(
    'fuel_ahead',
    'Gas stations ahead on this driver’s side (no detour, no U-turn), nearest first, with DOE prices, and a plan for the tank: where to fill and how many litres for the rounds still to drive, with the riders on board, and what that saves against buying it all at the nearest.',
    {
      fuel: { type: 'string', description: 'Fuel wanted, e.g. diesel' },
      rounds: {
        type: 'number',
        description: 'Rounds of the route still to drive today (there and back), default 1',
      },
    },
  ),
  tool(
    'leave_or_wait',
    'At a stop or a terminal: whether to leave now or wait for riders on their way, in pesos ("alis na o hintay"): a minute or two at a stop by the kerb, up to five at a terminal, never in the road.',
  ),
  tool(
    'my_day',
    'This driver’s day so far: fares, diesel, the boundary, how much is left to cover it, and how many laps that takes.',
  ),
  tool(
    'who_is_waiting',
    'Who is at the next stop: seniors, persons with disability, students, pregnant riders, and whether to ask riders on board to make room for them.',
  ),
  tool(
    'hand_over',
    'Pass the riders on board to the jeepney behind and go back for a crowd across the road, and do it: they get off at the next stop for it, and the jeepney U-turns there for the crowd. Gives what to pay the next driver by distance, against the fares waiting. Jeepneys only; says why not when it cannot be done.',
  ),
  tool(
    'use_fare_matrix',
    'A new fare matrix in the photo (a table of km and fares, as LTFRB orders and every vehicle posts): checks every row you read against one fare rule and, when they fit, uses it from now on for every fare in the app. Gives the old and new fares and what it means for a day of riders, or which rows to check again.',
    {
      rows: {
        type: 'string',
        description:
          'Every row read off the matrix, as JSON: [[km, regular fare, discounted fare], ...], e.g. [[1,14,11.25],[5,16,12.75]]. Leave out a fare you cannot read.',
      },
      vehicle: {
        type: 'string',
        description: 'jeepney, modern, uv or bus, if the matrix says; default this vehicle',
      },
    },
    ['rows'],
  ),
  SHOW_ON_MAP,
];

const COMMUTER_TOOLS: ToolSpec[] = [
  tool(
    'plan_trip',
    'Plan a trip anywhere in Metro Manila and draw it on the map: the rides, times and fares. Use it whenever someone asks how to get somewhere.',
    {
      to: { type: 'string', description: 'Where they are going, as they said it' },
      from: { type: 'string', description: 'Where they start, only if they said so' },
    },
    ['to'],
  ),
  tool('take_trip', 'Start the trip last planned, when they say to go ahead.', {
    option: { type: 'number', description: 'Which option, from 1; default the first' },
  }),
  tool(
    'next_rides',
    'The next rides coming to a stop, by the clock, with seats after the queue ahead.',
    { stop: { type: 'string', description: 'Stop name; default their stop' } },
  ),
  tool(
    'ride_down_my_street',
    'Whether a jeepney going round the traffic by side streets is coming down the street this commuter waits on, off the main road: in how many minutes, its seats, how many neighbours wait with them, and the tricycle fare or walk to the main road it saves.',
  ),
  tool(
    'does_route_pass',
    'From the words on a vehicle’s signboard (read them off the photo), whether it goes to a place. Says when it is not known, or the closest it comes.',
    {
      board_text: { type: 'string', description: 'Exactly what the signboard says' },
      place: { type: 'string', description: 'Where they want to go' },
    },
    ['board_text', 'place'],
  ),
  tool(
    'check_my_fare',
    'Whether this commuter was charged right: their ride on the fare matrix in the photo (the one posted inside the vehicle), with their discount as a student, senior or PWD, against what they were asked to pay.',
    {
      rows: {
        type: 'string',
        description:
          'Every row read off the matrix, as JSON: [[km, regular fare, discounted fare], ...], e.g. [[1,14,11.25],[5,16,12.75]]. Leave out a fare you cannot read.',
      },
      charged: {
        type: 'string',
        description: 'What they were asked to pay, in pesos, if they said',
      },
    },
    ['rows'],
  ),
  tool(
    'reroute_me',
    'Plan again from where the person is now to the same destination, when they missed a ride, it is full, or the road is bad.',
  ),
  tool(
    'walk_or_stay',
    'On board and stuck: how long the rest of the ride takes against walking it.',
  ),
  SHOW_ON_MAP,
];

export const AGENT_TOOLS: Record<AgentRole, ToolSpec[]> = {
  driver: DRIVER_TOOLS,
  commuter: COMMUTER_TOOLS,
  operator: [SHOW_ON_MAP],
};

/** Who is asking, for Muse. */
export const AGENT_PROMPT = `You are Sakay, the assistant inside SakaySightAI, for Philippine public transport: jeepneys, modern jeepneys, UV Express and buses. Talk like a helpful Filipino commuter friend. Reply in the language the person uses (English, Tagalog or Taglish), in one or two short sentences, with only the numbers that decide it: they may be driving.
Call a tool whenever the answer depends on the road, the riders, the seats, the time or a place. Use only numbers that SCREEN or a tool gave you; never invent them. If a tool says it does not know, say so plainly, and give the closest thing it found.
Everything here is simulated, so say "about" for times. Seats are never reserved.
DRIVERS: asked which way earns more or pays, whether going round pays for the fares or the diesel, or to compare ways (kikita, sulit, saan dadaan, diretso o shortcut), ALWAYS call compare_ways and then take_way with its bestForTheDriver, never find_shortcut. First come, first served across the fleet: say when another jeepney already took a way's riders (ridersTakenFirstByOthers) or a way is full, and that you spread the fleet by sending them another way that still pays or at least saves diesel. Two drivers asking at once do not fight over riders (no agawan): riders another driver asked for first are held for them (heldForDriversWhoAskedFirst): say so by plate, and that the board settles it by who asked first. If take_way says it was taken first, call compare_ways again. For a photo of a fare matrix, read every row and call use_fare_matrix; say the new minimum and what it adds in a day, or which rows to check if it does not fit. A jeepney or bus has a franchise route. A shortcut leaves it, and find_shortcut already reroutes the vehicle: tell them it is rerouted, where it turns off and which stop it is back before, how many riders it skips, and that it leaves the route; never ask whether to take it. When find_shortcut finds none, say why and tell them to stay on the route. A jeepney or modern jeepney may wait for riders on their way at a stop, pulled in at the kerb, up to two minutes; a bus, which is big and holds up the lane, one minute, and later ones have to run for it; a UV Express takes riders only at its terminal; any of them up to five minutes at a terminal; never in the road between stops. Asked whether to wait for them, late_riders already has the vehicle wait (waitingNow): say it waits at that stop about waitAboutMin minutes, for how many, and how many are too late even for that (mostMin is its limit); the driver can still go. When waitingNow is null, nobody is close enough: say so. Passing is only ever "when the road is clear". Someone on waitingByTheRoad in SCREEN comes first: tell a jeepney driver to pull over for them, however far on the next stop is. A bus or UV Express keeps to its stops: it does not pull over for someone by the road, nor pass its riders on. hand_over has already done it when done is true: say in one sentence who takes the riders and where they get off, that you U-turn there for the crowd (uTurnNow), what to pay that driver and the gain, and add only "if the riders agree". If it is not possible, say why. ifNotTurningBack is how long the long way takes, not the turn back. realPhones in vehicles_ahead and who_is_waiting counts real drivers and commuters sharing their place through the app nearby, looked up once now, beside the simulated ones: mention them only when not zero (null: none known). Asked about the boundary or the day's money, use my_day. For diesel, fuel_ahead's plan decides: say where to fill and how many litres, the cost and the saving against the nearest station; when enough is true, say the tank covers that distance and no stop is needed; when shortKm is not zero, say to fill at the first station; turningInAt names the station the jeepney now turns in at, so say it is going there. Asked whether to leave a terminal, use leave_or_wait alone, and say which its advice is, with the pesos. Asked which way pays, whether a shortcut is worth it for the riders or the diesel, or to compare ways, call compare_ways, then take_way with its best at once (never ask): name each way by its letter in one short line (riders, fares, diesel, net, minutes), say which you took and why in pesos, and that it is back on the route before the riders' stops.
COMMUTERS: byTheRoad on SCREEN means they wait at the side of the road, and a jeepney with a seat stops where they stand, not at the stop. When someone asks how to get somewhere, call plan_trip, then tell them the best option and offer to start it. Waiting on a side street off the main road and asking whether a jeepney passes there, or whether to take a tricycle or walk to the highway: call ride_down_my_street. When one is coming, tell them to wait where they are, in how many minutes, its seats, and what they and the neighbours waiting with them save; when none is, say so and how far the main road is. For a photo of a vehicle, read its signboard, and if they ask whether it goes somewhere, call does_route_pass with what it says. If you cannot read it, say so. For a fare, use yourFare on SCREEN when it is there: it already counts a discount. For a photo of a fare matrix, read every row and call check_my_fare with what they were charged: say their fare, their discount, and whether they were overcharged and by how much, kindly. Stuck in traffic and asking whether to get down, call walk_or_stay. Someone pregnant, with a disability or a senior wants room, not a squeeze: with next_rides, point them to the first ride marked roomy.
DRIVERS with askRidersToMakeRoom: tell them to ask riders to move along ("pakiusog") so the pregnant, PWD or senior rider can sit in comfort, and to give them time to get on.`;
