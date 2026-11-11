// History: everything placed since the page opened, kept in state.history and ordered by when each edit was
// made, and the window of it shown on the Earth (the POINT_LIFE before "now").
// (The timeline bar that scrubbed and replayed this history was removed; it is in git history.)
import { POINT_LIFE, MAX_POINTS, MAX_HISTORY, state, flags, clockNow, upperBound } from './core.js';

export function record(item) {
  state.history.splice(upperBound(item.time), 0, item); // lookups finish out of order, so insert sorted
  if (state.history.length > MAX_HISTORY) state.history.shift();
  flags.windowDirty = true;
}
// Earth edits shown at the playhead: the POINT_LIFE before it (plus the selected edit, wherever it is).
export function computeWindow() {
  const T = clockNow();
  const out = [];
  for (let i = upperBound(T - POINT_LIFE); i < state.history.length && state.history[i].time <= T; i++) {
    if (!state.history[i].sky) out.push(state.history[i]);
  }
  const sel = state.selected;
  if (sel && !sel.sky && !sel.unplaced && !out.includes(sel)) sel.time < T ? out.unshift(sel) : out.push(sel);
  state.points = out.length > MAX_POINTS ? out.slice(-MAX_POINTS) : out;
  flags.windowDirty = false;
}
