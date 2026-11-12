// History: every placed edit this session, ordered by when it was made, and the slice of it drawn on the Earth.
import { POINT_LIFE, MAX_POINTS, MAX_HISTORY, state, flags, indexAfter } from './core.js';

export function record(item) {
  state.history.splice(indexAfter(item.time), 0, item); // lookups finish out of order, so insert in place
  if (state.history.length > MAX_HISTORY) state.history.shift();
  flags.windowDirty = true;
}

// The Earth edits made in the last POINT_LIFE, plus the selected edit wherever it is.
export function computeWindow() {
  const now = Date.now();
  const out = state.history.slice(indexAfter(now - POINT_LIFE)).filter(it => !it.sky);
  const sel = state.selected;
  if (sel && !sel.sky && !sel.unplaced && !out.includes(sel)) out.unshift(sel);
  state.points = out.slice(-MAX_POINTS);
  flags.windowDirty = false;
}
