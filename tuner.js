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
  const stringsEl = document.getElementById("strings");
  const startBtn = document.getElementById("startBtn");
  const statusEl = document.getElementById("status");

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

  function setArrows(cents) {
    // cents: signed. negative = flat (need to tune up → light LEFT arrows pointing inward)
    // positive = sharp (need to tune down → light RIGHT arrows pointing inward)
    const abs = Math.abs(cents);
    const flat = cents < 0;
    const sharp = cents > 0;

    leftArrows.forEach((el, i) => {
      el.classList.remove("lit", "hot");
      // Light progressively from innermost (i=2) outward as it gets further off
      // i=2 lights at >5¢, i=1 at >15¢, i=0 at >30¢
      const thresholds = [30, 15, 5];
      if (flat && abs > thresholds[i]) {
        el.classList.add(abs > 30 && i === 0 ? "hot" : "lit");
      }
    });
    rightArrows.forEach((el, i) => {
      el.classList.remove("lit", "hot");
      // i=0 (innermost) at >5¢, i=1 at >15¢, i=2 at >30¢
      const thresholds = [5, 15, 30];
      if (sharp && abs > thresholds[i]) {
        el.classList.add(abs > 30 && i === 2 ? "hot" : "lit");
      }
    });

    if (abs <= 5) centerDot.classList.add("lock");
    else centerDot.classList.remove("lock");
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

    // Silence gate — below this, don't even try
    if (rms < 0.008) {
      statusEl.textContent = "Listening…";
      return;
    }

    const { freq, clarity } = yin(sampleBuffer, audioCtx.sampleRate);
    if (freq <= 0 || clarity < 0.85) {
      statusEl.textContent = "Hold a steady note…";
      return;
    }

    // Smooth with a short median filter to kill jitter
    freqHistory.push(freq);
    if (freqHistory.length > 5) freqHistory.shift();
    const smoothed = median(freqHistory);

    const note = freqToNote(smoothed);
    const def = INSTRUMENTS[currentInstrument];
    const { string: nearest, cents: centsToTarget } = findNearestString(smoothed, def.strings);

    noteEl.textContent = note.name;
    octaveEl.textContent = String(note.octave);
    freqEl.textContent = `${smoothed.toFixed(1)} Hz`;
    centsEl.textContent = `${centsToTarget >= 0 ? "+" : ""}${centsToTarget.toFixed(0)}¢`;
    targetEl.textContent = nearest ? `Target: ${nearest.name}${nearest.octave} (${nearest.freq.toFixed(2)} Hz)` : "—";

    setArrows(centsToTarget);
    highlightStringChip(nearest);

    if (Math.abs(centsToTarget) <= 5) {
      statusEl.textContent = "In tune ✓";
      const chips = stringsEl.querySelectorAll(".string-chip.active");
      chips.forEach((c) => c.classList.add("locked"));
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
})();
