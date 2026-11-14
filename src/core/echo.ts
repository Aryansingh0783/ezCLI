/* Where each message you sent was echoed by a CLI that only prints to the terminal.
 *
 * The chat view cuts the terminal text into turns at those rows. A row counts as the echo when it is
 * the prompt line: optional prompt mark (">", "›", "❯", "!"), then the start of what was sent. Only when
 * no such row exists is "the text appears somewhere in a row" accepted. Without that order a short
 * message such as "HI" is matched to the model's own reasoning ("the user said HI"), which splits
 * the reply in the middle of its thinking block. */

const PROMPT = /^[>›❯!]\s*/;

/** Whitespace collapsed, as the rows passed to `findEchoRows` must be. */
export const normRow = (x: unknown): string => String(x).replace(/\s+/g, ' ').trim();

/**
 * @param flat    terminal rows, each already through `normRow`
 * @param heads   per turn, oldest first: the normalised text that was sent, or null when the turn is
 *                already finished and needs no row
 * @returns per turn the row index of its echo, or -1
 */
export function findEchoRows(flat: readonly string[], heads: readonly (string | null)[]): number[] {
  const at = heads.map(() => -1);
  let limit = flat.length;
  // newest first, so a message sent twice is matched to its own echo and not the earlier one
  for (let i = heads.length - 1; i >= 0; i--) {
    const full = heads[i];
    if (!full) continue;
    const head = full.slice(0, 28);
    let found = -1;
    for (let k = limit - 1; k >= 0 && found < 0; k--) {
      const row = flat[k] ?? '';
      const bare = row.replace(PROMPT, '');
      const prompted = bare.length !== row.length;
      // the echo line: a prompt mark and the message, or a row that is exactly the (short) message
      if ((prompted && bare.startsWith(head)) || row === full) found = k;
    }
    for (let k = limit - 1; k >= 0 && found < 0; k--) {
      if ((flat[k] ?? '').includes(head)) found = k;
    }
    if (found >= 0) {
      at[i] = found;
      limit = found;
    }
  }
  return at;
}

/** The start of a message as it would appear on the terminal: enough to recognise it, short enough to sit on one line. */
export function echoKey(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 18);
}
