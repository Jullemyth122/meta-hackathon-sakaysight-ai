import { describe, expect, it } from 'vitest';
import { INSET_PACES, InsetPace } from './insetPace';

const run = (pace: InsetPace, fps: number, seconds: number) => {
  for (let t = 0; t < seconds * fps; t++) pace.update(1 / fps);
};

describe('how often the camera insets are drawn', () => {
  it('is smooth where the view runs at full speed', () => {
    const pace = new InsetPace();
    run(pace, 60, 5);
    expect(pace.rates).toBe(INSET_PACES[0]);
  });

  it('is cheapest where the view is struggling', () => {
    const pace = new InsetPace();
    run(pace, 60, 5);
    run(pace, 28, 5);
    expect(pace.rates).toBe(INSET_PACES[INSET_PACES.length - 1]);
  });

  it('slows down within a second or two of the view starting to suffer', () => {
    const pace = new InsetPace();
    run(pace, 60, 5);
    run(pace, 30, 1.5);
    expect(pace.rates.mirror).toBeLessThan(INSET_PACES[0].mirror);
  });

  it('does not hunt up and down around the line', () => {
    const pace = new InsetPace();
    run(pace, 30, 5);
    const settled = pace.rates;
    run(pace, 50, 10); // between the two lines: stays as it is
    expect(pace.rates).toBe(settled);
  });

  it('comes back up once there is room again, a step at a time', () => {
    const pace = new InsetPace();
    run(pace, 30, 5);
    run(pace, 60, 3.5);
    expect(pace.rates).toBe(INSET_PACES[1]);
    run(pace, 60, 3);
    expect(pace.rates).toBe(INSET_PACES[0]);
  });

  it('takes no notice of one long hitch, or a tab coming back', () => {
    const pace = new InsetPace();
    run(pace, 60, 5);
    pace.update(3);
    pace.update(0);
    run(pace, 60, 1);
    expect(pace.rates).toBe(INSET_PACES[0]);
  });
});
