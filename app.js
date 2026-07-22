const stopBtn = document.getElementById("stopBtn");
const repeatBtn = document.getElementById("repeatBtn");
const roleAnswerBtn = document.getElementById("roleAnswerBtn");
const roleQuestionBtn = document.getElementById("roleQuestionBtn");
const koreanToggle = document.getElementById("koreanToggle");
const setupEl = document.getElementById("setup");
const drillEl = document.getElementById("drill");
const linesListEl = document.getElementById("linesList");
const statusEl = document.getElementById("statusText");
const repEl = document.getElementById("repText");
const scenarioListEl = document.getElementById("scenarioList");
const vocabPopupEl = document.getElementById("vocabPopup");

let scenarios = [];
let glossary = {};
let myRole = "answer"; // "answer" = I speak the answer lines, AI speaks questions
                        // "question" = I speak the question lines, AI speaks answers
let stopped = false;
let lastAudioUrl = null;

async function loadGlossary() {
  const res = await fetch("glossary.json");
  glossary = await res.json();
}

// Wraps any word that exists in glossary.json in a tappable span so the user
// can look up pronunciation/meaning without leaving the drill screen.
function annotateText(text) {
  return text.replace(/[A-Za-z']+/g, (word) => {
    const entry = glossary[word.toLowerCase()];
    if (!entry) return word;
    const ipa = entry.ipa.replace(/"/g, "&quot;");
    const ko = entry.ko.replace(/"/g, "&quot;");
    return `<span class="vocabWord" data-ipa="${ipa}" data-ko="${ko}" data-word="${word}">${word}</span>`;
  });
}

linesListEl.addEventListener("click", (e) => {
  const target = e.target.closest(".vocabWord");
  if (!target) return;
  vocabPopupEl.innerHTML = `<b>${target.dataset.word}</b> <span class="vocabIpa">[${target.dataset.ipa}]</span><br>${target.dataset.ko}`;
  vocabPopupEl.classList.remove("hidden");
});

vocabPopupEl.addEventListener("click", () => {
  vocabPopupEl.classList.add("hidden");
});

const KOREAN_PREF_KEY = "roleplay-show-korean";
koreanToggle.checked = localStorage.getItem(KOREAN_PREF_KEY) !== "off";
document.body.classList.toggle("hideKorean", !koreanToggle.checked);
koreanToggle.addEventListener("change", () => {
  document.body.classList.toggle("hideKorean", !koreanToggle.checked);
  localStorage.setItem(KOREAN_PREF_KEY, koreanToggle.checked ? "on" : "off");
});

const CATEGORY_LABELS = {
  greetings: "Greetings",
  numbers: "Numbers",
  starbucks: "Starbucks",
  interview: "Job Interview",
  reunion: "Reunion",
  hosting: "Hosting a Guest",
};

function categoryOf(name) {
  const prefix = name.split("_")[0];
  return CATEGORY_LABELS[prefix] || prefix;
}

function titleOf(name) {
  // "greetings_01_first_meeting" -> "01. First Meeting"
  const parts = name.split("_");
  const num = parts[1];
  const rest = parts.slice(2).join(" ");
  const titled = rest.replace(/\b\w/g, (c) => c.toUpperCase());
  return `${num}. ${titled}`;
}

async function loadScenarioIndex() {
  const res = await fetch("pairs_index.json");
  scenarios = await res.json();

  const groups = new Map();
  for (const s of scenarios) {
    const cat = categoryOf(s.name);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(s);
  }

  scenarioListEl.innerHTML = "";
  for (const [cat, items] of groups) {
    const heading = document.createElement("h2");
    heading.className = "categoryHeading";
    heading.textContent = cat;
    scenarioListEl.appendChild(heading);

    for (const s of items) {
      const item = document.createElement("button");
      item.className = "scenarioItem";
      item.type = "button";
      item.textContent = titleOf(s.name);
      item.addEventListener("click", () => startDrill(s.file));
      scenarioListEl.appendChild(item);
    }
  }
}

roleAnswerBtn.addEventListener("click", () => {
  myRole = "answer";
  roleAnswerBtn.classList.add("active");
  roleQuestionBtn.classList.remove("active");
});
roleQuestionBtn.addEventListener("click", () => {
  myRole = "question";
  roleQuestionBtn.classList.add("active");
  roleAnswerBtn.classList.remove("active");
});

// iOS Safari only allows audio.play() to succeed if it's called directly from
// (or very shortly after) a user gesture. Once we're deep in an async
// play-audio -> wait-for-VAD -> play-audio loop, that "gesture window" is long
// gone and further .play() calls get silently rejected -- breaking hands-free
// playback. The fix: reuse a single <audio> element that gets "unlocked" by a
// real tap on the Start button, instead of creating a new Audio() each time.
let sharedAudioEl = null;

function unlockAudio() {
  sharedAudioEl = new Audio();
  sharedAudioEl.play().catch(() => {});
  sharedAudioEl.pause();
}

function playAudio(url) {
  lastAudioUrl = url;
  return new Promise((resolve, reject) => {
    sharedAudioEl.onended = resolve;
    sharedAudioEl.onerror = reject;
    sharedAudioEl.src = url;
    sharedAudioEl.play().catch((err) => {
      // Autoplay can be blocked (e.g. gesture window expired while waiting on
      // a mic-permission prompt). Retry once from a fresh play() call before
      // giving up -- most engines allow this once the element already has a
      // loaded src, even without a fresh gesture.
      sharedAudioEl.play().catch(reject);
    });
  });
}

// Replays the last-played line without disturbing the VAD listening loop --
// safe to tap while "Speak now..." is showing, it just plays over it.
repeatBtn.addEventListener("click", () => {
  if (!lastAudioUrl) return;
  const replayEl = new Audio(lastAudioUrl);
  replayEl.play().catch(() => {});
});

// Energy-based VAD using the Web Audio API: waits for the mic level to rise
// above a threshold (speech started) and then stay below it for a sustained
// silence window (speech ended) -- no ASR/LLM involved, just "did you stop
// talking yet", which is all a shadowing/roleplay drill needs.
class MicVad {
  constructor() {
    this.audioCtx = null;
    this.analyser = null;
    this.stream = null;
  }

  async init() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);
  }

  getLevel() {
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    return Math.sqrt(sumSquares / data.length);
  }

  waitForSpeechThenSilence({
    speechThreshold = 0.04,
    silenceMs = 1800,
    maxWaitMs = 20000,
    maxTotalMs = 30000,
    pollMs = 60,
  } = {}) {
    return new Promise((resolve) => {
      let spokeYet = false;
      let silenceStart = null;
      const startTime = Date.now();

      const tick = () => {
        if (stopped) { resolve(); return; }
        const level = this.getLevel();
        const now = Date.now();

        // Hard ceiling regardless of state: mic gain/echo/background noise
        // can keep the level pinned above threshold so silence never gets
        // sustained for silenceMs -- without this, the drill hangs forever
        // waiting for a silence window that will never come.
        if (now - startTime >= maxTotalMs) {
          resolve();
          return;
        }

        if (level > speechThreshold) {
          spokeYet = true;
          silenceStart = null;
        } else if (spokeYet) {
          if (silenceStart === null) silenceStart = now;
          if (now - silenceStart >= silenceMs) {
            resolve();
            return;
          }
        }

        if (!spokeYet && now - startTime >= maxWaitMs) {
          resolve();
          return;
        }
        setTimeout(tick, pollMs);
      };
      tick();
    });
  }

  close() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
    }
    if (this.audioCtx) {
      this.audioCtx.close();
    }
  }
}

function renderAllPairs(turns) {
  linesListEl.innerHTML = "";
  const rowEls = [];
  for (const turn of turns) {
    const row = document.createElement("div");
    row.className = "pairRow";
    const qKo = turn.questionKo ? `<div class="koLine">${turn.questionKo}</div>` : "";
    const aKo = turn.answerKo ? `<div class="koLine">${turn.answerKo}</div>` : "";
    row.innerHTML = `
      <div class="qBlock">
        <div class="qLine"><span class="roleTag">Q</span>${annotateText(turn.question)}</div>
        ${qKo}
      </div>
      <div class="aBlock">
        <div class="aLine"><span class="roleTag">A</span>${annotateText(turn.answer)}</div>
        ${aKo}
      </div>
    `;
    linesListEl.appendChild(row);
    rowEls.push({
      row,
      qBlock: row.querySelector(".qBlock"),
      aBlock: row.querySelector(".aBlock"),
    });
  }
  return rowEls;
}

function setActiveRow(rowEls, index, currentSide) {
  rowEls.forEach(({ row, qBlock, aBlock }, i) => {
    row.classList.toggle("active", i === index);
    qBlock.classList.toggle("current", i === index && currentSide === "question");
    aBlock.classList.toggle("current", i === index && currentSide === "answer");
  });
  const active = rowEls[index];
  if (active) {
    active.row.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

async function runScenario(fileName, vad) {
  const res = await fetch(fileName);
  const scenario = await res.json();
  const audioDir = `audio/${scenario.name}/`;
  const rowEls = renderAllPairs(scenario.turns);

  for (let i = 0; i < scenario.turns.length && !stopped; i++) {
    const turn = scenario.turns[i];
    repEl.textContent = `${i + 1} / ${scenario.turns.length}`;

    if (myRole === "answer") {
      // AI asks, I answer.
      setActiveRow(rowEls, i, "question");
      statusEl.textContent = "Listening to AI...";
      try {
        await playAudio(audioDir + turn.questionAudio);
      } catch (err) {
        console.error("playAudio failed, skipping line", err);
        statusEl.textContent = "Audio failed, skipping...";
      }
      if (stopped) break;

      setActiveRow(rowEls, i, "answer");
      statusEl.textContent = "Speak now...";
      await vad.waitForSpeechThenSilence();
      statusEl.textContent = "";
    } else {
      // I ask, AI answers.
      setActiveRow(rowEls, i, "question");
      statusEl.textContent = "Speak now...";
      await vad.waitForSpeechThenSilence();
      if (stopped) break;

      setActiveRow(rowEls, i, "answer");
      statusEl.textContent = "Listening to AI...";
      try {
        await playAudio(audioDir + turn.answerAudio);
      } catch (err) {
        console.error("playAudio failed, skipping line", err);
        statusEl.textContent = "Audio failed, skipping...";
      }
      statusEl.textContent = "";
    }
  }

  if (!stopped) {
    statusEl.textContent = "Scenario complete!";
  }
}

let currentVad = null;

async function startDrill(fileName) {
  unlockAudio(); // must happen synchronously within the tap, before any await
  stopped = false;

  const vad = new MicVad();
  try {
    await vad.init();
  } catch (err) {
    alert("Microphone access is required for this drill: " + err.message);
    return;
  }
  currentVad = vad;

  setupEl.classList.add("hidden");
  drillEl.classList.remove("hidden");

  await runScenario(fileName, vad);

  vad.close();
}

stopBtn.addEventListener("click", () => {
  stopped = true;
  if (currentVad) currentVad.close();
  drillEl.classList.add("hidden");
  setupEl.classList.remove("hidden");
});

loadGlossary();
loadScenarioIndex();
