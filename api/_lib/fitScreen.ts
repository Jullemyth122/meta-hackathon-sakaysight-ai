/**
 * A screen summary that fits what Meta is sent. A long one is shortened from
 * its longest list, last entries first (they are the furthest away), and says
 * so, rather than being dropped whole and leaving the assistant blind.
 */

type Fields = Record<string, unknown>;

export function fitScreen(screen: unknown, maxBytes: number): string {
  if (!screen || typeof screen !== 'object') return '';
  const whole = JSON.stringify(screen);
  if (whole.length <= maxBytes) return whole;
  const fields: Fields = { ...(screen as Fields), trimmed: 'long lists shortened; ask for more' };
  for (;;) {
    let longest: string | null = null;
    let size = 0;
    for (const [key, value] of Object.entries(fields))
      if (Array.isArray(value) && value.length > size) [longest, size] = [key, value.length];
    if (longest === null) return '';
    fields[longest] = (fields[longest] as unknown[]).slice(0, -1);
    const text = JSON.stringify(fields);
    if (text.length <= maxBytes) return text;
  }
}
