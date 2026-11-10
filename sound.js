/*
 * Simple Web Audio voice, in the spirit of Listen to Wikipedia:
 * bigger edits play lower notes, additions are bells, removals are plucks,
 * new articles are a soft chord. Notes are panned by longitude.
 */
(function () {
  let ctx = null, master = null, lastAt = 0;
  // Pentatonic scale over ~3 octaves, low -> high.
  const SCALE = [];
  for (let o = 0; o < 4; o++) for (const s of [0, 2, 4, 7, 9]) SCALE.push(130.81 * Math.pow(2, o + s / 12));

  function ensure() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createDynamicsCompressor();
      const g = ctx.createGain(); g.gain.value = 0.6;
      master.connect(g).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  function tone(freq, { type = 'sine', dur = 1.2, vol = 0.2, pan = 0, attack = 0.005, when = 0 }) {
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator(), g = ctx.createGain(), p = ctx.createStereoPanner();
    osc.type = type; osc.frequency.value = freq;
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(p).connect(master);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  function play(item) {
    if (!ctx) return;
    const now = performance.now();
    if (now - lastAt < 90) return; // don't let bursts turn into noise
    lastAt = now;
    const size = Math.abs(item.delta);
    // log scale: 1 byte -> top of scale, ~50 KB -> bottom
    const k = Math.min(1, Math.log10(size + 1) / 4.7);
    const idx = Math.round((1 - k) * (SCALE.length - 1));
    const f = SCALE[idx];
    const pan = item.lng / 180;
    const vol = item.tier === 'exact' ? 0.22 : 0.11;
    if (item.kind === 'new') {
      tone(f, { type: 'sine', dur: 2.4, vol: vol * 0.8, pan, attack: 0.08 });
      tone(f * 1.25, { type: 'sine', dur: 2.4, vol: vol * 0.6, pan, attack: 0.08, when: 0.06 });
      tone(f * 1.5, { type: 'sine', dur: 2.4, vol: vol * 0.5, pan, attack: 0.08, when: 0.12 });
    } else if (item.kind === 'remove') {
      tone(f / 2, { type: 'triangle', dur: 0.7, vol, pan });
    } else {
      tone(f, { type: 'sine', dur: 1.6, vol, pan });
      tone(f * 2.76, { type: 'sine', dur: 0.5, vol: vol * 0.25, pan }); // bell-ish partial
    }
  }

  window.WikiSound = {
    enable() { ensure(); },
    disable() { if (ctx) ctx.suspend(); },
    play,
  };
})();
