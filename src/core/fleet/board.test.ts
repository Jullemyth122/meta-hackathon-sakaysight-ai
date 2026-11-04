import { describe, expect, it } from 'vitest';
import { FleetBoard, HOLD_MS } from './board';

describe('the fleet board', () => {
  const clocked = () => {
    let t = 1000;
    const board = new FleetBoard(() => t);
    return { board, pass: (ms: number) => (t += ms) };
  };
  const way = { enterS: 500, exitS: 1400 };

  it('holds riders for whoever asked first, not for the next to ask', () => {
    const { board, pass } = clocked();
    board.hold({ vehicle: 1, plate: 'FLT 2201', riders: new Set([7, 8, 9]), ...way });
    pass(5000);
    board.hold({ vehicle: 0, plate: 'ABC 123', riders: new Set([9, 10]), ...way });
    expect(board.heldFor(8, 0)?.plate).toBe('FLT 2201');
    // Both say 9: it is the first asker's.
    expect(board.heldFor(9, 2)?.vehicle).toBe(1);
    expect(board.heldFor(10, 1)?.vehicle).toBe(0);
    // Nobody is held against themselves.
    expect(board.heldFor(7, 1)).toBeUndefined();
  });

  it('lets them go after a minute, or when the driver has chosen', () => {
    const { board, pass } = clocked();
    board.hold({ vehicle: 1, plate: 'FLT 2201', riders: new Set([7]), ...way });
    board.hold({ vehicle: 2, plate: 'FST 1180', riders: new Set([8]), ...way });
    board.release(2);
    expect(board.heldFor(8)).toBeUndefined();
    pass(HOLD_MS - 1);
    expect(board.heldFor(7)?.vehicle).toBe(1);
    pass(1);
    expect(board.heldFor(7)).toBeUndefined();
  });

  it('counts who holds the same way round, by its ends', () => {
    const { board } = clocked();
    board.hold({ vehicle: 1, plate: 'A', riders: new Set(), enterS: 510, exitS: 1390 });
    board.hold({ vehicle: 2, plate: 'B', riders: new Set(), enterS: 900, exitS: 1800 });
    board.hold({ vehicle: 3, plate: 'C', riders: new Set(), enterS: null, exitS: null });
    expect(board.onTheWay(500, 1400, 0, 150).map((h) => h.vehicle)).toEqual([1]);
    expect(board.onTheWay(500, 1400, 1, 150)).toEqual([]);
  });

  it('asking again replaces what that driver held', () => {
    const { board } = clocked();
    board.hold({ vehicle: 1, plate: 'A', riders: new Set([7, 8]), ...way });
    board.hold({ vehicle: 1, plate: 'A', riders: new Set([9]), enterS: null, exitS: null });
    expect(board.heldFor(7)).toBeUndefined();
    expect(board.of(1)?.riders.has(9)).toBe(true);
  });
});
