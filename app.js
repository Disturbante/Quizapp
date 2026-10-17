import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import firebaseConfig, { firebaseConfigured } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  questions: [],
  questionById: new Map(),
  wrongIds: [],
  stats: { answered: 0, correct: 0, wrong: 0 },
  authMode: "login",
  mode: "general",
  sessionQuestions: [],
  sessionIndex: 0,
  sessionStats: { correct: 0, wrong: 0 },
  selectedOption: null,
  answeredCurrent: false,
  progressStorageKey: null,
  progressReady: false,
  firestoreWarningShown: false,
  progressSaveQueue: Promise.resolve(true),
  auth: null,
  db: null
};

const DEFAULT_STATS = Object.freeze({ answered: 0, correct: 0, wrong: 0 });
const QUIZ_ID = "85";

function setHidden(element, hidden) {
  element.hidden = hidden;
}

function showMessage(message, kind = "info") {
  const target = $("global-message");
  target.textContent = message;
  target.className = `global-message ${kind}`;
  setHidden(target, !message);
  if (message) window.setTimeout(() => {
    if (target.textContent === message) setHidden(target, true);
  }, 5200);
}

function setAuthMessage(message = "", kind = "error") {
  const target = $("auth-message");
  target.textContent = message;
  target.className = `form-message ${kind}`;
}

function explainAuthError(error) {
  const messages = {
    "auth/email-already-in-use": "Esiste già un account con questa email.",
    "auth/invalid-email": "L'indirizzo email non è valido.",
    "auth/weak-password": "La password deve contenere almeno 6 caratteri.",
    "auth/invalid-credential": "Email o password non corrette.",
    "auth/user-not-found": "Non risulta un account con questa email.",
    "auth/wrong-password": "Password non corretta.",
    "auth/too-many-requests": "Troppi tentativi. Riprova più tardi.",
    "auth/network-request-failed": "Errore di rete. Controlla la connessione.",
    "auth/operation-not-allowed": "Abilita l'accesso tramite email e password nella console Firebase.",
    "auth/unauthorized-domain": "Questo dominio non è autorizzato in Firebase Authentication.",
    "auth/invalid-api-key": "API key Firebase non valida: controlla firebase-config.js."
  };
  return messages[error?.code] || "Operazione non riuscita. Controlla la configurazione e riprova.";
}

function shuffle(items) {
  const array = [...items];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function sanitizeProgress(progress) {
  const validIds = new Set(state.questions.map((question) => String(question.id)));
  const wrongIds = Array.isArray(progress?.wrongIds)
    ? [...new Set(progress.wrongIds.map(String).filter((id) => validIds.has(id)))]
    : [];
  const rawStats = progress?.stats || {};
  const stats = {};
  for (const key of Object.keys(DEFAULT_STATS)) {
    const value = Number(rawStats[key]);
    stats[key] = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  }
  return { wrongIds, stats };
}

function readLocalProgress(user) {
  state.progressStorageKey = `quiz-progress-${QUIZ_ID}-${user.uid}`;
  try {
    const raw = localStorage.getItem(state.progressStorageKey);
    const parsed = raw ? JSON.parse(raw) : {};
    const clean = sanitizeProgress(parsed);
    return {
      ...clean,
      exists: Boolean(raw),
      savedAt: typeof parsed?.savedAt === "string" ? parsed.savedAt : null,
      pendingSync: parsed?.pendingSync === true
    };
  } catch (error) {
    console.warn("Unable to read local quiz progress", error);
    showMessage("Non è stato possibile leggere i progressi locali del browser.", "warning");
    return { wrongIds: [], stats: { ...DEFAULT_STATS }, exists: false, savedAt: null };
  }
}

function applyProgress(progress) {
  const clean = sanitizeProgress(progress);
  state.wrongIds = clean.wrongIds;
  state.stats = clean.stats;
}

function writeLocalCache(user, payload, pendingSync = false) {
  const key = `quiz-progress-${QUIZ_ID}-${user.uid}`;
  try {
    localStorage.setItem(key, JSON.stringify({
      ...payload,
      savedAt: new Date().toISOString(),
      pendingSync
    }));
  } catch (error) {
    console.warn("Unable to save local quiz progress", error);
    if (state.user?.uid === user.uid) {
      showMessage("Impossibile salvare una copia locale dei progressi nel browser.", "warning");
    }
  }
}

function currentProgressPayload() {
  return {
    version: 1,
    quizId: QUIZ_ID,
    wrongIds: [...state.wrongIds],
    stats: { ...state.stats }
  };
}

function firestoreErrorMessage(error) {
  if (error?.code === "permission-denied") {
    return "Firestore ha rifiutato l'accesso. Pubblica le regole contenute in firestore.rules nella console Firebase.";
  }
  if (error?.code === "failed-precondition" || error?.code === "unavailable") {
    return "Firestore non è disponibile. Controlla che il database sia stato creato e la connessione sia attiva.";
  }
  return "Non riesco a sincronizzare i progressi con Firebase. Per ora restano salvati in questo browser.";
}

async function loadProgress(user) {
  const local = readLocalProgress(user);
  applyProgress(local);
  state.progressReady = false;
  renderDashboard();

  let syncSucceeded = true;
  try {
    const progressRef = doc(state.db, "users", user.uid, "quizProgress", QUIZ_ID);
    const snapshot = await getDoc(progressRef);
    if (state.user?.uid !== user.uid) return;

    if (snapshot.exists()) {
      const remote = snapshot.data();
      // Only prefer local state when a previous cloud write explicitly failed.
      if (local.exists && local.pendingSync) {
        applyProgress(local);
        const savedToCloud = await saveProgress();
        syncSucceeded = savedToCloud;
        if (savedToCloud) {
          showMessage("I progressi locali non ancora sincronizzati sono stati trasferiti a Firebase.", "success");
        }
      } else {
        applyProgress(remote);
        writeLocalCache(user, currentProgressPayload(), false);
      }
    } else {
      // Migrate progress from the previous localStorage-only version on first login.
      applyProgress(local);
      syncSucceeded = await saveProgress();
      if (syncSucceeded && local.exists && (local.wrongIds.length > 0 || local.stats.answered > 0)) {
        showMessage("I progressi salvati in precedenza sono stati trasferiti a Firebase.", "success");
      }
    }
    if (syncSucceeded) state.firestoreWarningShown = false;
  } catch (error) {
    console.error("Unable to load or sync Firestore progress", error);
    if (state.user?.uid !== user.uid) return;
    applyProgress(local);
    state.firestoreWarningShown = true;
    showMessage(firestoreErrorMessage(error), "warning");
  } finally {
    if (state.user?.uid === user.uid) {
      state.progressReady = true;
      renderDashboard();
    }
  }
}

function saveProgress() {
  const user = state.user;
  if (!user || !state.progressStorageKey) return Promise.resolve(false);

  const payload = currentProgressPayload();
  writeLocalCache(user, payload, true);

  const write = async () => {
    if (!state.db) return false;
    try {
      const progressRef = doc(state.db, "users", user.uid, "quizProgress", QUIZ_ID);
      await setDoc(progressRef, { ...payload, updatedAt: serverTimestamp() }, { merge: true });
      state.firestoreWarningShown = false;
      if (state.user?.uid === user.uid) {
        const current = currentProgressPayload();
        if (JSON.stringify(current.wrongIds) === JSON.stringify(payload.wrongIds) &&
            JSON.stringify(current.stats) === JSON.stringify(payload.stats)) {
          writeLocalCache(user, payload, false);
        }
      }
      return true;
    } catch (error) {
      console.error("Unable to save Firestore progress", error);
      if (state.user?.uid === user.uid && !state.firestoreWarningShown) {
        state.firestoreWarningShown = true;
        showMessage(firestoreErrorMessage(error), "warning");
      }
      return false;
    }
  };

  // Serialize writes so a slower older request cannot overwrite a newer answer.
  state.progressSaveQueue = state.progressSaveQueue.catch(() => false).then(write);
  return state.progressSaveQueue;
}

function setAuthMode(mode) {
  state.authMode = mode;
  const isRegister = mode === "register";
  $("auth-title").textContent = isRegister ? "Crea il tuo account" : "Accedi al tuo account";
  $("auth-subtitle").textContent = isRegister ? "Registra il tuo account personale." : "Riprendi da dove avevi lasciato.";
  $("auth-submit").textContent = isRegister ? "Crea account" : "Accedi";
  $("auth-switch-prompt").textContent = isRegister ? "Hai già un account?" : "Non hai un account?";
  $("auth-switch").textContent = isRegister ? "Accedi" : "Registrati";
  $("reset-password").hidden = isRegister;
  $("password").autocomplete = isRegister ? "new-password" : "current-password";
  setAuthMessage("");
}

async function renderSignedInApp(user) {
  state.user = user;
  state.progressReady = false;
  state.firestoreWarningShown = false;
  $("user-email").textContent = user.email || "Account";
  setHidden($("signed-in-bar"), false);
  setHidden($("auth-view"), true);
  setHidden($("app-view"), false);
  showScreen("home");
  await loadProgress(user);
}

function renderSignedOut() {
  state.user = null;
  state.progressReady = false;
  state.progressStorageKey = null;
  setHidden($("signed-in-bar"), true);
  setHidden($("app-view"), true);
  setHidden($("auth-view"), false);
  setAuthMessage("");
  $("email").value = "";
  $("password").value = "";
  setAuthMode("login");
}

function showScreen(screen) {
  setHidden($("home-screen"), screen !== "home");
  setHidden($("quiz-screen"), screen !== "quiz");
  setHidden($("result-screen"), screen !== "results");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderDashboard() {
  const total = state.questions.length;
  const wrong = state.wrongIds.length;
  const accuracy = state.stats.answered > 0
    ? `${Math.round((state.stats.correct / state.stats.answered) * 100)}%`
    : "—";
  $("total-questions").textContent = String(total);
  $("wrong-count").textContent = String(wrong);
  $("correct-count").textContent = String(state.stats.correct);
  $("accuracy").textContent = accuracy;
  $("general-pool-count").textContent = String(total);
  $("wrong-pool-count").textContent = String(wrong);
  const wrongRadio = $("source-wrong");
  wrongRadio.disabled = wrong === 0;
  if (wrong === 0 && wrongRadio.checked) $("source-general").checked = true;
  document.querySelectorAll(".source-option").forEach((label) => {
    const input = label.querySelector("input");
    label.classList.toggle("selected", Boolean(input?.checked));
    label.classList.toggle("disabled", Boolean(input?.disabled));
  });
  const selected = $("source-wrong").checked ? "wrong" : "general";
  const max = selected === "wrong" ? wrong : total;
  const countSelect = $("question-count");
  const allOption = countSelect.querySelector('option[value="all"]');
  allOption.textContent = `Tutte quelle disponibili (${max})`;
  $("start-session").disabled = max === 0 || !state.progressReady;
  $("reset-progress").disabled = !state.progressReady;
}

function beginSession(mode, countChoice) {
  const source = mode === "wrong"
    ? state.questions.filter((question) => state.wrongIds.includes(String(question.id)))
    : state.questions;
  if (source.length === 0) {
    showMessage("Il contenitore delle domande sbagliate è vuoto.", "warning");
    return;
  }
  const count = countChoice === "all" ? source.length : Math.max(1, Number.parseInt(countChoice, 10) || 10);
  state.mode = mode;
  state.sessionQuestions = shuffle(source).slice(0, Math.min(count, source.length));
  state.sessionIndex = 0;
  state.sessionStats = { correct: 0, wrong: 0 };
  state.selectedOption = null;
  state.answeredCurrent = false;
  showScreen("quiz");
  renderQuestion();
}

function renderQuestion() {
  const question = state.sessionQuestions[state.sessionIndex];
  if (!question) {
    renderResults();
    return;
  }
  state.selectedOption = null;
  state.answeredCurrent = false;
  $("quiz-mode-badge").textContent = state.mode === "wrong" ? "Domande sbagliate" : "Tutte le domande";
  $("quiz-progress-label").textContent = `Domanda ${state.sessionIndex + 1} di ${state.sessionQuestions.length}`;
  $("quiz-score-label").textContent = `${state.sessionStats.correct} corrette`;
  $("quiz-progress-bar").style.width = `${(state.sessionIndex / state.sessionQuestions.length) * 100}%`;
  $("question-number").textContent = String(state.sessionIndex + 1).padStart(2, "0");
  $("question-id").textContent = `ID ${question.id}`;
  $("question-text").textContent = question.text;
  $("option-list").replaceChildren();
  $("answer-feedback").replaceChildren();
  setHidden($("answer-feedback"), true);
  $("question-state-label").textContent = "La risposta verrà verificata subito.";
  $("next-question").disabled = true;
  $("next-question").textContent = "Conferma risposta";

  question.options.forEach((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "answer-option";
    button.dataset.optionIndex = String(index);
    const key = document.createElement("span");
    key.className = "option-key";
    key.textContent = String.fromCharCode(65 + index);
    const text = document.createElement("span");
    text.className = "option-text";
    text.textContent = option;
    const indicator = document.createElement("span");
    indicator.className = "option-indicator";
    indicator.setAttribute("aria-hidden", "true");
    indicator.textContent = "";
    button.append(key, text, indicator);
    button.addEventListener("click", () => selectOption(index));
    $("option-list").append(button);
  });
}

function selectOption(index) {
  if (state.answeredCurrent) return;
  state.selectedOption = index;
  document.querySelectorAll(".answer-option").forEach((button) => {
    button.classList.toggle("selected", Number(button.dataset.optionIndex) === index);
  });
  $("next-question").disabled = false;
  $("next-question").textContent = "Verifica risposta";
  $("question-state-label").textContent = "Risposta selezionata";
}

function addFeedback(correct, question) {
  const panel = $("answer-feedback");
  panel.replaceChildren();
  panel.className = `answer-feedback ${correct ? "is-correct" : "is-wrong"}`;
  const title = document.createElement("strong");
  title.textContent = correct ? "Risposta corretta" : "Risposta sbagliata";
  const description = document.createElement("p");
  description.textContent = correct
    ? "La domanda non è più presente nel contenitore degli errori (se era stata inserita in precedenza)."
    : `Risposta corretta: ${question.options[question.correct]}`;
  panel.append(title, description);
  setHidden(panel, false);
}

function submitAnswer() {
  if (!state.answeredCurrent) {
    if (state.selectedOption === null) return;
    const question = state.sessionQuestions[state.sessionIndex];
    const correct = state.selectedOption === question.correct;
    state.answeredCurrent = true;
    state.stats.answered += 1;
    if (correct) {
      state.stats.correct += 1;
      state.sessionStats.correct += 1;
      state.wrongIds = state.wrongIds.filter((id) => id !== String(question.id));
    } else {
      state.stats.wrong += 1;
      state.sessionStats.wrong += 1;
      if (!state.wrongIds.includes(String(question.id))) state.wrongIds.push(String(question.id));
    }
    void saveProgress();
    renderDashboard();
    document.querySelectorAll(".answer-option").forEach((button) => {
      const index = Number(button.dataset.optionIndex);
      button.disabled = true;
      if (index === question.correct) button.classList.add("correct");
      if (index === state.selectedOption && !correct) button.classList.add("wrong");
      const indicator = button.querySelector(".option-indicator");
      if (index === question.correct) indicator.textContent = "✓";
      else if (index === state.selectedOption && !correct) indicator.textContent = "×";
    });
    addFeedback(correct, question);
    $("quiz-score-label").textContent = `${state.sessionStats.correct} corrette`;
    $("question-state-label").textContent = correct ? "Risposta registrata" : "Errore registrato per il ripasso";
    $("next-question").textContent = state.sessionIndex === state.sessionQuestions.length - 1 ? "Vedi risultato" : "Prossima domanda →";
    $("quiz-progress-bar").style.width = `${((state.sessionIndex + 1) / state.sessionQuestions.length) * 100}%`;
  } else {
    state.sessionIndex += 1;
    if (state.sessionIndex >= state.sessionQuestions.length) renderResults();
    else renderQuestion();
  }
}

function renderResults() {
  showScreen("results");
  const total = state.sessionQuestions.length;
  const accuracy = total ? Math.round((state.sessionStats.correct / total) * 100) : 0;
  $("result-correct").textContent = String(state.sessionStats.correct);
  $("result-wrong").textContent = String(state.sessionStats.wrong);
  $("result-accuracy").textContent = `${accuracy}%`;
  $("result-summary").textContent = `Hai completato ${total} ${total === 1 ? "domanda" : "domande"}. Nel contenitore degli errori restano ${state.wrongIds.length} ${state.wrongIds.length === 1 ? "domanda" : "domande"}.`;
  $("retry-wrong").disabled = state.wrongIds.length === 0;
  $("retry-wrong").textContent = state.wrongIds.length ? `Ripassa le domande sbagliate (${state.wrongIds.length})` : "Nessuna domanda da ripassare";
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (!firebaseConfigured || !state.auth) {
    setAuthMessage("Configura prima firebase-config.js e abilita Email/Password in Firebase Authentication.");
    return;
  }
  const email = $("email").value.trim();
  const password = $("password").value;
  const submit = $("auth-submit");
  submit.disabled = true;
  setAuthMessage("");
  try {
    if (state.authMode === "register") {
      await createUserWithEmailAndPassword(state.auth, email, password);
      setAuthMessage("Account creato. Accesso in corso…", "success");
    } else {
      await signInWithEmailAndPassword(state.auth, email, password);
    }
  } catch (error) {
    setAuthMessage(explainAuthError(error));
  } finally {
    submit.disabled = false;
  }
}

async function handlePasswordReset() {
  const email = $("email").value.trim();
  if (!email) {
    setAuthMessage("Inserisci prima l'indirizzo email nel campo sopra.");
    $("email").focus();
    return;
  }
  if (!firebaseConfigured || !state.auth) {
    setAuthMessage("Configura prima Firebase in firebase-config.js.");
    return;
  }
  try {
    await sendPasswordResetEmail(state.auth, email);
    setAuthMessage("Se l'indirizzo è associato a un account, riceverai un'email per reimpostare la password.", "success");
  } catch (error) {
    setAuthMessage(explainAuthError(error));
  }
}

async function startApp() {
  try {
    const response = await fetch(new URL("./questions.json", window.location.href));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.questions) || data.questions.length === 0) throw new Error("Il JSON non contiene domande.");
    state.questions = data.questions.filter((question) =>
      question && question.id !== undefined && typeof question.text === "string" &&
      Array.isArray(question.options) && Number.isInteger(question.correct) &&
      question.correct >= 0 && question.correct < question.options.length
    );
    state.questionById = new Map(state.questions.map((question) => [String(question.id), question]));
    $("total-questions").textContent = String(state.questions.length);
    const introCount = $("intro-question-count");
    if (introCount) introCount.textContent = String(state.questions.length);
    renderDashboard();
  } catch (error) {
    console.error("Unable to load questions.json", error);
    setHidden($("config-warning"), false);
    $("config-warning").querySelector("span").textContent = "Non riesco a caricare questions.json. Pubblica tutti i file nella stessa cartella e apri il sito tramite un server HTTP, non con file://.";
    $("auth-submit").disabled = true;
    setAuthMessage("Impossibile caricare il database delle domande.");
    return;
  }

  if (!firebaseConfigured) {
    setHidden($("config-warning"), false);
    $("auth-submit").disabled = true;
    $("reset-password").disabled = true;
    return;
  }

  try {
    const app = initializeApp(firebaseConfig);
    state.auth = getAuth(app);
    state.db = getFirestore(app);
    onAuthStateChanged(state.auth, (user) => {
      if (user) void renderSignedInApp(user);
      else renderSignedOut();
    }, (error) => {
      console.error(error);
      setAuthMessage(explainAuthError(error));
    });
  } catch (error) {
    console.error("Firebase initialization failed", error);
    setAuthMessage("Inizializzazione Firebase non riuscita. Controlla firebase-config.js.");
  }
}

$("auth-form").addEventListener("submit", handleAuthSubmit);
$("auth-switch").addEventListener("click", () => setAuthMode(state.authMode === "login" ? "register" : "login"));
$("reset-password").addEventListener("click", handlePasswordReset);
$("sign-out").addEventListener("click", async () => {
  if (!state.auth) return;
  try { await signOut(state.auth); }
  catch (error) { showMessage(explainAuthError(error), "error"); }
});
$("session-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const mode = $("source-wrong").checked ? "wrong" : "general";
  beginSession(mode, $("question-count").value);
});
$("source-general").addEventListener("change", renderDashboard);
$("source-wrong").addEventListener("change", renderDashboard);
$("next-question").addEventListener("click", submitAnswer);
$("back-home").addEventListener("click", () => { renderDashboard(); showScreen("home"); });
$("result-home").addEventListener("click", () => { renderDashboard(); showScreen("home"); });
$("retry-wrong").addEventListener("click", () => beginSession("wrong", "all"));
$("reset-progress").addEventListener("click", async () => {
  if (!state.user || !state.progressReady) return;
  const confirmed = window.confirm("Vuoi cancellare le statistiche e svuotare le domande sbagliate per questo account su tutti i dispositivi sincronizzati?");
  if (!confirmed) return;
  state.wrongIds = [];
  state.stats = { ...DEFAULT_STATS };
  renderDashboard();
  const savedToCloud = await saveProgress();
  renderDashboard();
  showMessage(savedToCloud
    ? "Progressi azzerati e sincronizzati con Firebase."
    : "Progressi azzerati localmente; la sincronizzazione Firebase non è riuscita.", savedToCloud ? "success" : "warning");
});

startApp();
