(() => {
  "use strict";

  // ---------- Instrument definitions ----------
  // Standard tunings, low → high. Frequencies are equal-temperament with A4 = 440.
  const INSTRUMENTS = {
    guitar: {
      name: "Guitar",
      strings: [
        { name: "E", octave: 2, freq: 82.41 },
        { name: "A", octave: 2, freq: 110.00 },
        { name: "D", octave: 3, freq: 146.83 },
        { name: "G", octave: 3, freq: 196.00 },
        { name: "B", octave: 3, freq: 246.94 },
        { name: "E", octave: 4, freq: 329.63 },
      ],
      bufferSize: 2048,
    },
    bass: {
      name: "Bass Guitar",
      strings: [
        { name: "E", octave: 1, freq: 41.20 },
        { name: "A", octave: 1, freq: 55.00 },
        { name: "D", octave: 2, freq: 73.42 },
        { name: "G", octave: 2, freq: 98.00 },
      ],
      bufferSize: 4096, // need larger buffer for low frequencies
    },
    ukulele: {
      // GCEA, standard reentrant. The G is higher than C (reentrant).
      name: "Ukulele",
      strings: [
        { name: "G", octave: 4, freq: 392.00 },
        { name: "C", octave: 4, freq: 261.63 },
        { name: "E", octave: 4, freq: 329.63 },
        { name: "A", octave: 4, freq: 440.00 },
      ],
      bufferSize: 2048,
    },
    banjo: {
      // 5-string open G: gDGBd (5th, 4th, 3rd, 2nd, 1st)
      name: "Banjo",
      strings: [
        { name: "G", octave: 4, freq: 392.00 }, // 5th (drone)
        { name: "D", octave: 3, freq: 146.83 }, // 4th
        { name: "G", octave: 3, freq: 196.00 }, // 3rd
        { name: "B", octave: 3, freq: 246.94 }, // 2nd
        { name: "D", octave: 4, freq: 293.66 }, // 1st
      ],
      bufferSize: 2048,
    },
    mandolin: {
      // GDAE, low to high
      name: "Mandolin",
      strings: [
        { name: "G", octave: 3, freq: 196.00 },
        { name: "D", octave: 4, freq: 293.66 },
        { name: "A", octave: 4, freq: 440.00 },
        { name: "E", octave: 5, freq: 659.25 },
      ],
      bufferSize: 2048,
    },
  };

  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  // ---------- DOM ----------
  const instrumentSel = document.getElementById("instrument");
  const noteEl = document.getElementById("note");
  const octaveEl = document.getElementById("octave");
  const targetEl = document.getElementById("target");
  const freqEl = document.getElementById("freq");
  const centsEl = document.getElementById("cents");
  const leftArrows = document.getElementById("leftArrows").querySelectorAll("span");
  const rightArrows = document.getElementById("rightArrows").querySelectorAll("span");
  const centerDot = document.getElementById("centerDot");
  const fineMeter = document.querySelector(".fine-meter");
  const fineNeedle = document.getElementById("fineNeedle");
  const stringsEl = document.getElementById("strings");
  const startBtn = document.getElementById("startBtn");
  const statusEl = document.getElementById("status");

  // ---------- Tuning constants ----------
  // Macro stage — 4 arrows per side, progressive lighting toward in-tune:
  //   >30¢       : 1 arrow (outermost — direction indicator)
  //   15-30¢     : 2 arrows
  //   5-15¢      : 3 arrows
  //   ≤5¢        : 4 arrows on the off side (micro zone begins here)
  //   ≤2¢ × N    : locked → all 8 arrows + center O lit, body flashes green
  const MACRO_FAR_CENTS = 30;
  const MACRO_MID_CENTS = 15;
  const MACRO_NEAR_CENTS = 5;
  // Micro stage — fine needle for precision tuning within the macro close zone.
  const FINE_RANGE_CENTS = 5;    // needle spans ±this on the fine meter (tight zoom)
  const MICRO_ZONE_CENTS = 5;    // entering this brightens needle + target band
  const LOCK_CENTS = 2;          // ±cents to declare "in tune"
  const LOCK_FRAMES = 4;         // sustained frames required for lock
  const SIDE_HYSTERESIS = 1.5;   // cents — keeps arrow side stable through tiny wobble around 0
  // Smoothing + signal handling.
  const NOTE_CHANGE_CENTS = 80;  // single-frame jump > this → reset smoothing
  const HISTORY_LEN = 3;         // median-filter window
  const SILENCE_RMS = 0.003;     // below this, treat the frame as silent
  const SILENCE_RESET_FRAMES = 45; // ~750ms of silence before wiping lock state
  const YIN_CLARITY = 0.85;      // YIN confidence floor

  // ---------- State ----------
  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let sourceNode = null;
  let rafId = null;
  let running = false;
  let currentInstrument = "guitar";
  let sampleBuffer = null;
  let freqHistory = [];
  let lockFrames = 0;
  let silenceFrames = 0;
  let lastArrowSide = null; // "left" | "right" | null — hysteresis for arrow side
  let wakeLock = null;

  // ---------- YIN pitch detection ----------
  // Reference: de Cheveigné & Kawahara (2002). Threshold 0.10–0.15 is typical.
  function yin(buffer, sampleRate, threshold = 0.10) {
    const SIZE = buffer.length;
    const halfBuffer = SIZE >> 1;
    const yinBuf = new Float32Array(halfBuffer);

    // Step 1: difference function
    for (let tau = 0; tau < halfBuffer; tau++) {
      let sum = 0;
      for (let i = 0; i < halfBuffer; i++) {
        const delta = buffer[i] - buffer[i + tau];
        sum += delta * delta;
      }
      yinBuf[tau] = sum;
    }

    // Step 2: cumulative mean normalized difference
    yinBuf[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau < halfBuffer; tau++) {
      runningSum += yinBuf[tau];
      yinBuf[tau] *= tau / runningSum;
    }

    // Step 3: absolute threshold — first dip below threshold that's a local min
    let tau = 2;
    let found = -1;
    while (tau < halfBuffer - 1) {
      if (yinBuf[tau] < threshold) {
        while (tau + 1 < halfBuffer && yinBuf[tau + 1] < yinBuf[tau]) tau++;
        found = tau;
        break;
      }
      tau++;
    }
    if (found === -1) return { freq: -1, clarity: 0 };

    // Step 4: parabolic interpolation for sub-sample precision
    let betterTau;
    if (found > 0 && found < halfBuffer - 1) {
      const s0 = yinBuf[found - 1];
      const s1 = yinBuf[found];
      const s2 = yinBuf[found + 1];
      const denom = 2 * (2 * s1 - s2 - s0);
      betterTau = denom !== 0 ? found + (s2 - s0) / denom : found;
    } else {
      betterTau = found;
    }

    return { freq: sampleRate / betterTau, clarity: 1 - yinBuf[found] };
  }

  // ---------- Note math ----------
  function freqToNote(freq) {
    const A4 = 440;
    const semitonesFromA4 = 12 * Math.log2(freq / A4);
    const midi = 69 + semitonesFromA4;
    const roundedMidi = Math.round(midi);
    const noteIndex = ((roundedMidi % 12) + 12) % 12;
    const octave = Math.floor(roundedMidi / 12) - 1;
    const cents = (midi - roundedMidi) * 100;
    return {
      name: NOTE_NAMES[noteIndex],
      octave,
      cents, // -50..+50 from the nearest note
      midi: roundedMidi,
    };
  }

  function centsBetween(freq, target) {
    return 1200 * Math.log2(freq / target);
  }

  function findNearestString(freq, strings) {
    let best = null;
    let bestAbs = Infinity;
    for (const s of strings) {
      const c = Math.abs(centsBetween(freq, s.freq));
      if (c < bestAbs) {
        bestAbs = c;
        best = s;
      }
    }
    return { string: best, cents: best ? centsBetween(freq, best.freq) : 0 };
  }

  // ---------- UI rendering ----------
  function renderStringChips() {
    const def = INSTRUMENTS[currentInstrument];
    stringsEl.innerHTML = "";
    for (const s of def.strings) {
      const chip = document.createElement("div");
      chip.className = "string-chip";
      chip.dataset.freq = String(s.freq);
      chip.textContent = `${s.name}${s.octave}`;
      stringsEl.appendChild(chip);
    }
  }

  function setArrows(cents, isLocked) {
    leftArrows.forEach((el) => el.classList.remove("lit"));
    rightArrows.forEach((el) => el.classList.remove("lit"));

    if (isLocked) {
      // Full lock: all 8 arrows + center O. CSS turns them green via body.locked.
      leftArrows.forEach((el) => el.classList.add("lit"));
      rightArrows.forEach((el) => el.classList.add("lit"));
      centerDot.classList.add("lock");
      return;
    }
    centerDot.classList.remove("lock");

    // Sticky side selection — prevents flicker when the smoothed cents value
    // wobbles across 0 due to measurement noise.
    let side;
    if (cents > SIDE_HYSTERESIS) side = "right";
    else if (cents < -SIDE_HYSTERESIS) side = "left";
    else side = lastArrowSide || (cents < 0 ? "left" : "right");
    lastArrowSide = side;

    // 4-stage progressive fill on the chosen side.
    const abs = Math.abs(cents);
    let count;
    if (abs > MACRO_FAR_CENTS) count = 1;       // >30¢ : 1 arrow
    else if (abs > MACRO_MID_CENTS) count = 2;  // 15-30¢ : 2 arrows
    else if (abs > MACRO_NEAR_CENTS) count = 3; // 5-15¢ : 3 arrows
    else count = 4;                             // ≤5¢   : 4 arrows (micro zone)

    if (side === "left") {
      // leftArrows[0] is the outermost (leftmost) → light outward-in
      for (let i = 0; i < count; i++) leftArrows[i].classList.add("lit");
    } else {
      // rightArrows[3] is the outermost (rightmost) → light outward-in
      for (let i = 0; i < count; i++) rightArrows[3 - i].classList.add("lit");
    }
  }

  function setFineNeedle(cents, isLocked, isInMicroZone) {
    // Zoomed micro view: map cents in [-FINE_RANGE_CENTS, +FINE_RANGE_CENTS]
    // to left position [0%, 100%]. Pitches outside the range peg the needle
    // at the edge — the macro arrows are the right tool at that distance.
    const clamped = Math.max(-FINE_RANGE_CENTS, Math.min(FINE_RANGE_CENTS, cents));
    const pct = 50 + (clamped / FINE_RANGE_CENTS) * 50;
    fineNeedle.style.left = `${pct}%`;
    fineNeedle.classList.toggle("lock", isLocked);
    // Brighten the needle + target band when the macro is satisfied
    // and the micro stage is the relevant control.
    fineNeedle.classList.toggle("active", isInMicroZone && !isLocked);
    fineMeter.classList.toggle("active", isInMicroZone && !isLocked);
  }

  function highlightStringChip(targetString) {
    const chips = stringsEl.querySelectorAll(".string-chip");
    chips.forEach((c) => {
      c.classList.remove("active", "locked");
      if (targetString && Math.abs(parseFloat(c.dataset.freq) - targetString.freq) < 0.5) {
        c.classList.add("active");
      }
    });
  }

  function clearDisplay() {
    noteEl.textContent = "—";
    octaveEl.textContent = "";
    targetEl.textContent = "Pick a string";
    freqEl.textContent = "0.0 Hz";
    centsEl.textContent = "0¢";
    leftArrows.forEach((el) => el.classList.remove("lit", "hot"));
    rightArrows.forEach((el) => el.classList.remove("lit", "hot"));
    centerDot.classList.remove("lock");
    fineNeedle.style.left = "50%";
    fineNeedle.classList.remove("lock", "active");
    fineMeter.classList.remove("active");
    document.body.classList.remove("locked");
    highlightStringChip(null);
  }

  // ---------- Audio loop ----------
  function computeRMS(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    return Math.sqrt(sum / buffer.length);
  }

  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function tick() {
    if (!running) return;
    rafId = requestAnimationFrame(tick);

    analyser.getFloatTimeDomainData(sampleBuffer);
    const rms = computeRMS(sampleBuffer);

    // Silence handling: only wipe state after SUSTAINED silence, so brief volume
    // dips during a decaying pluck don't kill the reading. Note-change resets
    // are handled separately below via the frequency-jump check.
    if (rms < SILENCE_RMS) {
      silenceFrames++;
      if (silenceFrames >= SILENCE_RESET_FRAMES) {
        if (freqHistory.length || lockFrames) {
          freqHistory = [];
          lockFrames = 0;
          lastArrowSide = null;
          document.body.classList.remove("locked");
          centerDot.classList.remove("lock");
          fineNeedle.classList.remove("lock", "active");
          fineMeter.classList.remove("active");
          highlightStringChip(null);
        }
        statusEl.textContent = "Listening…";
      }
      return;
    }
    silenceFrames = 0;

    const { freq, clarity } = yin(sampleBuffer, audioCtx.sampleRate);
    if (freq <= 0 || clarity < YIN_CLARITY) {
      statusEl.textContent = "Hold a steady note…";
      return;
    }

    // If this frame jumped far from the last sample we trusted, the player
    // moved to a different note — drop history so we lock onto the new pitch
    // instantly instead of dragging through the old one.
    if (freqHistory.length > 0) {
      const last = freqHistory[freqHistory.length - 1];
      const jump = Math.abs(1200 * Math.log2(freq / last));
      if (jump > NOTE_CHANGE_CENTS) {
        freqHistory = [];
        lockFrames = 0;
      }
    }

    freqHistory.push(freq);
    if (freqHistory.length > HISTORY_LEN) freqHistory.shift();
    const smoothed = median(freqHistory);

    const note = freqToNote(smoothed);
    const def = INSTRUMENTS[currentInstrument];
    const { string: nearest, cents: centsToTarget } = findNearestString(smoothed, def.strings);
    const absCents = Math.abs(centsToTarget);

    // Sustained-lock: require LOCK_FRAMES consecutive frames inside ±LOCK_CENTS
    // before declaring "in tune" — kills false positives from attack transients.
    if (absCents <= LOCK_CENTS) lockFrames++;
    else lockFrames = 0;
    const isLocked = lockFrames >= LOCK_FRAMES;

    noteEl.textContent = note.name;
    octaveEl.textContent = String(note.octave);
    freqEl.textContent = `${smoothed.toFixed(1)} Hz`;
    centsEl.textContent = `${centsToTarget >= 0 ? "+" : ""}${centsToTarget.toFixed(1)}¢`;
    targetEl.textContent = nearest ? `Target: ${nearest.name}${nearest.octave} (${nearest.freq.toFixed(2)} Hz)` : "—";

    const isInMicroZone = absCents <= MICRO_ZONE_CENTS;
    setArrows(centsToTarget, isLocked);
    setFineNeedle(centsToTarget, isLocked, isInMicroZone);
    highlightStringChip(nearest);
    document.body.classList.toggle("locked", isLocked);

    if (isLocked) {
      statusEl.textContent = "In tune ✓";
      stringsEl.querySelectorAll(".string-chip.active").forEach((c) => c.classList.add("locked"));
    } else if (absCents <= 10) {
      statusEl.textContent = centsToTarget < 0 ? "Almost — nudge up" : "Almost — nudge down";
    } else {
      statusEl.textContent = centsToTarget < 0 ? "Tune up ↑" : "Tune down ↓";
    }
  }

  // ---------- Start/stop ----------
  async function start() {
    try {
      statusEl.textContent = "Requesting microphone…";
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });

      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
      if (audioCtx.state === "suspended") await audioCtx.resume();

      sourceNode = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      const def = INSTRUMENTS[currentInstrument];
      // fftSize must be power of 2; analyser exposes time-domain buffer of fftSize
      analyser.fftSize = def.bufferSize;
      analyser.smoothingTimeConstant = 0;
      sampleBuffer = new Float32Array(analyser.fftSize);
      sourceNode.connect(analyser);

      // Try to keep the screen awake while tuning
      try {
        if ("wakeLock" in navigator) {
          wakeLock = await navigator.wakeLock.request("screen");
        }
      } catch (_) {
        /* non-fatal */
      }

      running = true;
      freqHistory = [];
      lockFrames = 0;
      silenceFrames = 0;
      lastArrowSide = null;
      startBtn.textContent = "Stop";
      startBtn.classList.add("stop");
      statusEl.textContent = "Listening…";
      tick();
    } catch (err) {
      statusEl.textContent = `Mic error: ${err.message || err.name || "unknown"}`;
      await stop();
    }
  }

  async function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (sourceNode) try { sourceNode.disconnect(); } catch (_) {}
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    if (audioCtx) try { await audioCtx.close(); } catch (_) {}
    if (wakeLock) try { await wakeLock.release(); } catch (_) {}
    audioCtx = null;
    analyser = null;
    sourceNode = null;
    micStream = null;
    wakeLock = null;
    startBtn.textContent = "Start Tuner";
    startBtn.classList.remove("stop");
    statusEl.textContent = "Tap Start and allow microphone access";
    clearDisplay();
  }

  // ---------- Event wiring ----------
  instrumentSel.addEventListener("change", async (e) => {
    currentInstrument = e.target.value;
    renderStringChips();
    clearDisplay();
    // If we were running, restart so buffer size matches new instrument
    if (running) {
      await stop();
      await start();
    }
  });

  startBtn.addEventListener("click", async () => {
    if (running) await stop();
    else await start();
  });

  // Re-acquire wake lock when tab becomes visible again
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && running && "wakeLock" in navigator) {
      try { wakeLock = await navigator.wakeLock.request("screen"); } catch (_) {}
    }
  });

  // ---------- Init ----------
  renderStringChips();
  clearDisplay();

  // ---------- Service worker (offline support) ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => {
        console.warn("SW registration failed:", err);
      });
    });
  }
})();
