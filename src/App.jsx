import React, { useEffect, useMemo, useRef, useState } from "react";
import jsPDF from "jspdf";
import CURRICULUM_EMBEDDED from "./evantis.curriculum.v1.json";
import { marked } from "marked";
import DOMPurify from "dompurify";

/* =========================
   CONFIG
========================= */
const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";
const API_KEY = import.meta.env.VITE_API_KEY || "";

const AUTH_LOGIN_PATH = "/auth/login";
const AUTH_REGISTER_PATH = "/auth/register";
const AUTH_ME_PATH = "/auth/me";
const TEACH_CURRICULUM_PATH = "/teach/curriculum";
const SHOW_DEBUG_PILLS = false;

// Paleta E-Vantis (para usos inline puntuales)
const EV_GOLD = "#F4C95D"; // dorado suave CTA

/* =========================
   STORAGE KEYS
========================= */
const LS_TOKEN = "evantis_token";
const LS_SAVED = "evantis_saved_lessons";
const LS_CHAT = "evantis_chat_by_session";
const LS_ACTIVE_RESULT = "evantis_active_result";

/* =========================
   HELPERS
========================= */
function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function makeIdempotencyKey(prefix = "ev") {
  try {
    // navegadores modernos
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    const hex = Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${prefix}_${hex}`;
  } catch {
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
  }
}

function loadChatStore() {
  const parsed = safeJsonParse(localStorage.getItem(LS_CHAT), {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed;
}

function saveChatStore(store) {
  const safe = store && typeof store === "object" && !Array.isArray(store) ? store : {};
  localStorage.setItem(LS_CHAT, JSON.stringify(safe));
}

function getChatForSession(session_id) {
  if (!session_id) return [];
  const store = loadChatStore();
  const list = store?.[session_id];
  return Array.isArray(list) ? list : [];
}

function setChatForSession(session_id, messages) {
  if (!session_id) return;
  const store = loadChatStore();
  store[session_id] = Array.isArray(messages) ? messages : [];
  saveChatStore(store);
}

function nowISO() {
  return new Date().toISOString();
}

function humanLabelModule(m) {
  return m === "lesson"
    ? "Clase"
    : m === "exam"
    ? "Examen"
    : m === "enarm"
    ? "Caso ENARM"
    : m === "gpc_summary"
    ? "Resumen GPC"
    : m;
}

function humanLabelLevel(l) {
  // UI: “Profundidad”
  return l === "internado" ? "Clínica" : l === "pregrado" ? "Pregrado" : "Adaptativa";
}

/* =========================
   PLAN / FASE 7 (GATING)
========================= */
function normalizePlan(plan) {
  return String(plan || "").trim().toLowerCase();
}
function isProOrPremium(plan) {
  const p = normalizePlan(plan);
  return p === "pro" || p === "premium";
}

/* =========================
   CURRICULUM NORMALIZER (PURO)
========================= */
function normalizeCurriculumTree(raw) {
  const subjectsRaw = Array.isArray(raw?.subjects) ? raw.subjects : [];
  const subjects = subjectsRaw.map((s) => ({
    id: s.id,
    name: s.name,
    npm_profile: s.npm_profile,
    blocks: Array.isArray(s.blocks) ? s.blocks : [],
  }));
  return { subjects };
}

/* =========================
   MARKDOWN → BLOQUES PDF
========================= */
function parseMarkdownToBlocks(md = "") {
  return String(md || "")
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return { type: "space" };
      if (t.startsWith("## ")) return { type: "h2", text: t.slice(3) };
      if (t.startsWith("# ")) return { type: "h1", text: t.slice(2) };
      if (t.startsWith("- ")) return { type: "li", text: t.slice(2) };
      return { type: "p", text: t };
    });
}

/* =========================
   MARKDOWN → HTML (UI)
========================= */
marked.setOptions({
  gfm: true,
  breaks: true,
  headerIds: false,
  mangle: false,
});

function applyHighYield(md = "") {
  // Convención v1: ==texto==
  // No cruza saltos de línea. Si algo queda raro, deja literal.
  const s = String(md || "");
  return s.replace(/==([^\n=][^=\n]*?)==/g, (full, inner) => {
    const safe = String(inner || "").trim();
    if (!safe) return full;
    return `<span class="ev-hy">${safe}</span>`;
  });
}

function renderAcademicHTML(md = "") {
  const raw = applyHighYield(String(md || ""));
  const html = marked.parse(raw);
  return DOMPurify.sanitize(html);
}

function slugify(s = "") {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function normalizeSectionTitle(s = "") {
  return String(s || "").trim().replace(/[:：]\s*$/, "").toLowerCase();
}

function sectionKind(title = "") {
  const t = normalizeSectionTitle(title);

  // Clínicas (core)
  if (t.includes("definicion")) return "core";
  if (t.includes("epidemiologia")) return "core";
  if (t.includes("cuadro clinico")) return "core";
  if (t.includes("signos") || t.includes("sintomas")) return "core";

  // Dx / Tx
  if (t.includes("diagnostico") || t.includes("tamizaje") || t.includes("estandar de oro")) return "dx";
  if (t.includes("tratamiento") || t.includes("terapia") || t.includes("manejo")) return "tx";

  // Cierre
  if (t.includes("algoritmo")) return "algo";
  if (t.includes("preguntas de repaso") || t.includes("repaso")) return "quiz";

  // Alertas
  if (t.includes("red flags") || t.includes("banderas rojas")) return "danger";

  return "other";
}

function classifyCallout(text = "") {
  const t = String(text || "").trim();

  if (/^(red\s*flags|banderas\s*rojas)\b/i.test(t)) return "danger";
  if (/^(criterios|criterio|señales\s*de\s*alarma)\b/i.test(t)) return "info";
  if (/^(perlas|tip|tips|puntos\s*clave|high[-\s]*yield)\b/i.test(t)) return "tip";
  if (/^(urgente|emergencia|intervencion\s*inmediata)\b/i.test(t)) return "danger";
  return "";
}

/**
 * Markdown -> HTML (marked) -> sanitize (DOMPurify)
 * Luego: secciones por h2/h3 + TOC + <details open> colapsable + callouts.
 *
 * FIXES incluidos:
 * 1) Elimina secciones duplicadas “Contenido” / “Índice” (no crea sección y omite su contenido).
 * 2) Mantiene TOC propio (chips).
 * 3) Aplica barra dorada izquierda a secciones “tx” y “quiz” (como en tu screenshot).
 */

/* =========================
   BADGES v1 (en títulos)
========================= */
const BADGE_LABELS = {
  alta_prioridad: "Alta prioridad clínica",
  concepto_clave: "Concepto clave",
  red_flag: "Red flag",
  error_frecuente: "Error frecuente",
  enfoque_enarm: "Enfoque ENARM",
};

function parseLeadingBadges(title = "") {
  let t = String(title || "").trim();
  const badges = [];

  // Máximo 2 badges al inicio
  for (let i = 0; i < 2; i++) {
    const m = t.match(/^\[badge:([a-z_]+)\]\s*/i);
    if (!m) break;
    const slug = (m[1] || "").toLowerCase();
    if (BADGE_LABELS[slug]) badges.push(slug);
    t = t.slice(m[0].length);
  }

  return { cleanTitle: t.trim() || "Sección", badges };
}

/* =========================
   CALLOUTS v1 (blockquote con etiqueta)
   Convención:
   > [callout:slug]
   > contenido...
========================= */
const CALLOUT_LABELS = {
  perla_clinica: "Perla clínica",
  advertencia: "Advertencia",
  punto_de_examen: "Punto de examen",
  razonamiento_clinico: "Razonamiento clínico",
};

function parseCalloutSlugFromBlockquote(blockquoteEl) {
  // marked suele renderizar:
  // <blockquote><p>[callout:slug]</p><p>...</p></blockquote>
  // OJO: firstChild puede ser TextNode; usamos firstElementChild.
  const firstEl = blockquoteEl?.firstElementChild; // casi siempre <p>
  const firstText = (firstEl?.textContent || "").trim();

  // Espera exactamente: [callout:slug]
  const m = firstText.match(/^\[callout:([a-z_]+)\]\s*$/i);
  if (!m) return "";
  const slug = (m[1] || "").toLowerCase();
  return CALLOUT_LABELS[slug] ? slug : "";
}

function buildSectionedHTML(md = "") {
  const sanitized = renderAcademicHTML(md);
  const doc = new DOMParser().parseFromString(sanitized, "text/html");
  const body = doc.body;

  const sections = [];
  let current = { title: "Introducción", badges: [], kind: "other", nodes: [] };

  // Si entramos a “Contenido/Índice”, ignoramos todos los nodos hasta el siguiente h2/h3
  let skipMode = false;

  const isSkippableHeading = (title = "") => {
    const t = normalizeSectionTitle(title);
    // “indice” sin tilde ya queda así; por si llega con tilde, lo cubrimos por robustez
    return t === "contenido" || t === "indice" || t === "índice";
  };

  const flush = () => {
    if (skipMode) return;

    const hasContent = current.nodes.some((n) => {
      const tag = n?.tagName?.toLowerCase?.() || "";
      const txt = (n.textContent || "").trim();
      return txt.length > 0 || tag === "ul" || tag === "ol" || tag === "table" || tag === "pre";
    });

    if (hasContent) sections.push(current);
  };

  Array.from(body.childNodes).forEach((node) => {
    const el = node.nodeType === 1 ? node : null;
    const tag = el?.tagName?.toLowerCase?.() || "";

    // Sección nueva en h2/h3
    if (tag === "h2" || tag === "h3") {
      flush();

      const rawTitle = (el.textContent || "").trim() || "Sección";
      const { cleanTitle: title, badges } = parseLeadingBadges(rawTitle);

      // No renderizar secciones “Contenido/Índice” (y omitir su contenido)
      if (isSkippableHeading(title)) {
        skipMode = true;
        current = { title: "", badges: [], kind: "other", nodes: [] };
        return;
      }

      skipMode = false;
      current = { title, badges, kind: sectionKind(title), nodes: [] };
      return;
    }

    // Si estamos omitiendo “Contenido/Índice”, ignoramos nodos
    if (skipMode) return;

    // Texto suelto -> párrafo
    if (node.nodeType === 3) {
      const txt = (node.textContent || "").trim();
      if (txt) {
        const p = doc.createElement("p");
        p.textContent = txt;
        current.nodes.push(p);
      }
      return;
    }

    if (el) current.nodes.push(el);
  });

  flush();

  // Wrapper final
  const wrap = doc.createElement("div");
  wrap.setAttribute("class", "ev-sectioned");

  // TOC
  const toc = doc.createElement("div");
  toc.setAttribute("class", "ev-toc");

  const tocTitle = doc.createElement("div");
  tocTitle.setAttribute("class", "ev-toc-t");
  tocTitle.textContent = "Contenido";
  toc.appendChild(tocTitle);

  const tocList = doc.createElement("div");
  tocList.setAttribute("class", "ev-toc-l");
  toc.appendChild(tocList);

  const tocActions = doc.createElement("div");
  tocActions.setAttribute("class", "ev-toc-actions");
  // Nota: esto es HTML “estático”; no usa React events.
  tocActions.innerHTML = `
    <button class="ev-toc-btn" type="button" onclick="
      document.querySelectorAll('.ev-section details').forEach(d=>d.open=true);
    ">Expandir todo</button>
    <button class="ev-toc-btn" type="button" onclick="
      document.querySelectorAll('.ev-section details').forEach(d=>d.open=false);
    ">Contraer todo</button>
  `;
  toc.appendChild(tocActions);

  wrap.appendChild(toc);

  // Secciones -> <details>
  sections.forEach((s, idx) => {
    const id = `sec-${idx + 1}-${slugify(s.title)}`;

    // Link en TOC
    const a = doc.createElement("a");
    a.setAttribute("href", `#${id}`);
    a.setAttribute("class", "ev-toc-a");
    a.textContent = s.title;
    tocList.appendChild(a);

    // Card section
    const card = doc.createElement("section");
    card.setAttribute("class", `ev-section ev-section-${s.kind}`);
    card.setAttribute("id", id);

    // ✅ Barra dorada izquierda para TODAS las secciones
    card.style.borderLeft = `4px solid ${EV_GOLD}`;
    card.style.paddingLeft = "10px";

    const details = doc.createElement("details");
    details.setAttribute("open", "open");

    const summary = doc.createElement("summary");
    summary.setAttribute("class", "ev-section-h");

    const h = doc.createElement("div");
    h.setAttribute("class", "ev-section-t");
    h.textContent = s.title;

    // NEW: fila título + badges
    const titleRow = doc.createElement("div");
    titleRow.setAttribute("class", "ev-section-title-row");

    // badges (si existen)
    if (Array.isArray(s.badges) && s.badges.length) {
      const badgeWrap = doc.createElement("div");
      badgeWrap.setAttribute("class", "ev-badges");

      s.badges.forEach((slug) => {
        const chip = doc.createElement("span");
        chip.setAttribute("class", `ev-badgev1 ev-badgev1-${slug}`);
        chip.textContent = BADGE_LABELS[slug] || slug;
        badgeWrap.appendChild(chip);
      });

      titleRow.appendChild(badgeWrap);
    }

    titleRow.appendChild(h);

    const hint = doc.createElement("div");
    hint.setAttribute("class", "ev-section-hint");
    hint.textContent = "Click para plegar/abrir";

    summary.appendChild(titleRow);
    summary.appendChild(hint);

    const content = doc.createElement("div");
    content.setAttribute("class", "ev-section-b");

    s.nodes.forEach((n) => {
      const tag = n?.tagName?.toLowerCase?.() || "";

      // 1) Detectar callout v1
      if (tag === "blockquote") {
        const slug = parseCalloutSlugFromBlockquote(n);
        if (slug) {
          // construir caja
          const box = doc.createElement("div");
          box.setAttribute("class", `ev-callout ev-callout-v1 ev-callout-v1-${slug}`);

          // ✅ FIX: clases correctas para CSS v1
          const head = doc.createElement("div");
          head.setAttribute("class", "ev-callout-v1-h");
          head.textContent = CALLOUT_LABELS[slug];

          const bodyEl = doc.createElement("div");
          bodyEl.setAttribute("class", "ev-callout-v1-b");

          // Clonar contenido del blockquote y remover el primer bloque (<p>[callout:slug]</p>)
          const clone = n.cloneNode(true);

          // ✅ FIX: remover primer ELEMENT (no firstChild) para evitar TextNodes
          const firstEl = clone?.firstElementChild;
          if (firstEl) clone.removeChild(firstEl);

          // Mover hijos restantes al body
          Array.from(clone.childNodes).forEach((ch) => bodyEl.appendChild(ch));

          box.appendChild(head);
          box.appendChild(bodyEl);

          content.appendChild(box);
          return;
        }
      }

      // 2) Si no es callout v1, se renderiza normal
      content.appendChild(n);
    });

    details.appendChild(summary);
    details.appendChild(content);
    card.appendChild(details);

    wrap.appendChild(card);
  });

  return wrap.innerHTML;
}

/* =========================
   BANNER (alerts)
========================= */
function Banner({ notice, error }) {
  if (!error && !notice) return null;

  return (
    <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
      {error ? (
        <div className="ev-alert err">
          <span className="k">Error:</span> {error}
        </div>
      ) : null}

      {!error && notice ? (
        <div className="ev-alert" style={{ opacity: 0.9 }}>
          {notice}
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  // =========================
  // AUTH
  // =========================
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState(localStorage.getItem(LS_TOKEN) || "");
  const [me, setMe] = useState(null);
  const [usage, setUsage] = useState(null);
  const [authMode, setAuthMode] = useState("login"); // "login" | "register"

  // =========================
  // UI
  // =========================
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [quotaBlocked, setQuotaBlocked] = useState(false);

  // =========================
  // CURRICULUM (EMBEBIDO)
  // =========================
  const curriculum = useMemo(() => normalizeCurriculumTree(CURRICULUM_EMBEDDED), []);
  const subjects = curriculum.subjects;

  // =========================
  // RESULT + PERSISTENCIA CLASE ACTIVA
  // =========================
  const [result, setResult] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_ACTIVE_RESULT);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const resultRef = useRef(null);

  useEffect(() => {
    try {
      if (result) localStorage.setItem(LS_ACTIVE_RESULT, JSON.stringify(result));
      else localStorage.removeItem(LS_ACTIVE_RESULT);
    } catch {}
  }, [result]);

  // =========================
  // CHAT (por session_id)
  // =========================
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatStatus, setChatStatus] = useState("");
  const chatBoxRef = useRef(null);

  useEffect(() => {
    const sid = result?.session_id;
    if (!sid) {
      setChatMessages([]);
      return;
    }
    setChatMessages(getChatForSession(sid));
  }, [result?.session_id]);

  useEffect(() => {
    const sid = result?.session_id;
    if (!sid) return;
    setChatForSession(sid, chatMessages);
  }, [chatMessages, result?.session_id]);

  useEffect(() => {
    if (!chatOpen) return;
    const el = chatBoxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatMessages, chatOpen]);

  // =========================
  // SAVED LESSONS
  // =========================
  const [savedLessons, setSavedLessons] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_SAVED);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  const [activeSavedKey, setActiveSavedKey] = useState("");
  const [searchSaved, setSearchSaved] = useState("");
  const [filterSavedSubject, setFilterSavedSubject] = useState("all");
  const [filterSavedModule, setFilterSavedModule] = useState("all");
  const [filterSavedLevel, setFilterSavedLevel] = useState("all");

  useEffect(() => {
    try {
      localStorage.setItem(LS_SAVED, JSON.stringify(Array.isArray(savedLessons) ? savedLessons : []));
    } catch {}
  }, [savedLessons]);

  // =========================
  // FORM
  // =========================
  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [subtopicId, setSubtopicId] = useState("");
  const [module, setModule] = useState("lesson");
  const [level, setLevel] = useState("auto");
  const [durationMinutes, setDurationMinutes] = useState(25);
  const [style, setStyle] = useState("magistral");
  const [useGuides, setUseGuides] = useState(false);
  const [enarmContext, setEnarmContext] = useState(false);
  const [numQuestions, setNumQuestions] = useState(10);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // =========================
  // DERIVED TOPICS
  // =========================
  const selectedSubject = useMemo(() => subjects.find((s) => s.id === subjectId) || null, [subjects, subjectId]);
  const blocks = useMemo(() => selectedSubject?.blocks || [], [selectedSubject]);

  const flatTopics = useMemo(() => {
    const list = [];
    for (const b of blocks) {
      const mts = Array.isArray(b?.macro_topics) ? b.macro_topics : [];
      for (const t of mts) {
        const rawSubs = Array.isArray(t?.subtopics) ? t.subtopics : [];
        const subtopics = rawSubs
          .map((st, i) => {
            if (typeof st === "string") {
              const id = `sub_${i + 1}_${st}`
                .toLowerCase()
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/[^\w\s-]/g, "")
                .trim()
                .replace(/\s+/g, "_")
                .slice(0, 60);
              return { id, name: st };
            }
            if (st && typeof st === "object") return { id: st.id, name: st.name };
            return null;
          })
          .filter(Boolean);

        list.push({
          id: t.id,
          name: t.name,
          npm_rules: Array.isArray(t.npm_rules) ? t.npm_rules : [],
          subtopics,
        });
      }
    }
    return list;
  }, [blocks]);

  const selectedTopic = useMemo(() => flatTopics.find((t) => t.id === topicId) || null, [flatTopics, topicId]);

  const finalTopicId = useMemo(() => {
    if (!topicId) return "";
    if (!subtopicId) return topicId;
    return `${topicId}::${subtopicId}`;
  }, [topicId, subtopicId]);

  const npmProfile = selectedSubject?.npm_profile || "";

  // =========================
  // FASE 7: gating por plan
  // =========================
  const plan = normalizePlan(me?.plan);
  const hasPro = isProOrPremium(plan);

  const moduleOptions = useMemo(() => {
    let base;
    if (npmProfile === "basicas") base = ["lesson", "exam"];
    else if (npmProfile === "puente") base = ["lesson", "exam", "enarm"];
    else if (npmProfile === "clinicas") base = ["lesson", "exam", "enarm", "gpc_summary"];
    else base = ["lesson", "exam", "enarm", "gpc_summary"];
    if (!hasPro) base = base.filter((x) => x !== "gpc_summary");
    return base;
  }, [npmProfile, hasPro]);

  useEffect(() => {
    if (!moduleOptions.includes(module)) setModule(moduleOptions[0] || "lesson");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleOptions.join("|")]);

  useEffect(() => setTopicId(""), [subjectId]);
  useEffect(() => setSubtopicId(""), [topicId]);

  // =========================
  // TOKEN PERSIST
  // =========================
  useEffect(() => {
    try {
      if (token) localStorage.setItem(LS_TOKEN, token);
      else localStorage.removeItem(LS_TOKEN);
    } catch {}
  }, [token]);

  // =========================
  // LOAD /auth/me
  // =========================
  useEffect(() => {
    (async () => {
      if (!token) {
        setMe(null);
        return;
      }

      try {
        const res = await fetch(`${API_BASE}${AUTH_ME_PATH}`, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        });

        // ✅ NUEVO: si el token ya no sirve, cerramos sesión
        if (res.status === 401) {
          setToken("");
          setMe(null);
          try {
            localStorage.removeItem(LS_TOKEN);
          } catch {}
          return;
        }

        if (!res.ok) return;

        const data = await res.json();
        setMe(data);
      } catch {
        // opcional: no hacemos nada para no spamear errores
      }
    })();
  }, [token]);

  // =========================
  // AUTH MODE desde querystring (?auth=login|register)
  // =========================
  useEffect(() => {
    try {
      const qs = new URLSearchParams(window.location.search || "");
      const auth = (qs.get("auth") || "").toLowerCase();
      if (auth === "register") setAuthMode("register");
      if (auth === "login") setAuthMode("login");
    } catch {}
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const qs = new URLSearchParams(window.location.search || "");
        const tokenQ = (qs.get("token") || qs.get("verify_email_token") || "").trim();
        const action = (qs.get("action") || "").trim().toLowerCase();

        // Disparador: /?action=verify-email&token=...
        // o simplemente /verify-email?token=... (si tu hosting lo redirige igual)
        if (!tokenQ) return;
        if (action && action !== "verify-email") return;

        setError("");
        setNotice("Verificando correo…");

        const res = await fetch(`${API_BASE}/auth/verify-email?token=${encodeURIComponent(tokenQ)}`, {
          method: "GET",
        });

        const rawText = await res.text();
        let data = null;
        try {
          data = rawText ? JSON.parse(rawText) : null;
        } catch {
          data = null;
        }

        if (!res.ok) {
          const detailRaw = data?.detail ?? rawText ?? `HTTP ${res.status}`;
          const detail = typeof detailRaw === "string" ? detailRaw : JSON.stringify(detailRaw);
          setError(`No se pudo verificar: ${detail}`);
          setNotice("");
          return;
        }

        const msg = data?.message || "Correo verificado.";
        setNotice(msg);

        // Limpia querystring para que no se re-ejecute en refresh
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete("token");
          url.searchParams.delete("verify_email_token");
          url.searchParams.delete("action");
          window.history.replaceState({}, "", url.toString());
        } catch {}
      } catch (e) {
        setError(e?.message || "Error verificando correo.");
        setNotice("");
      }
    })();
  }, []);

  // =========================
  // USAGE
  // =========================
  async function fetchUsage(currentToken) {
    try {
      const res = await fetch(`${API_BASE}/usage/me`, {
        headers: {
          Authorization: `Bearer ${currentToken}`,
        },
      });
      if (!res.ok) return;
      const data = await res.json();
      setUsage(data);
    } catch {}
  }

  useEffect(() => {
    if (!token) return;
    fetchUsage(token);
  }, [token]);

  // =========================
  // ACTIONS
  // =========================
  async function handleLogin() {
    setError("");
    setNotice("");

    try {
      const body = new URLSearchParams();
      body.set("grant_type", "password");
      body.set("username", email);
      body.set("password", password);

      const res = await fetch(`${API_BASE}${AUTH_LOGIN_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
        },
        body: body.toString(),
      });

      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        data = { detail: rawText };
      }

      if (!res.ok) {
        const detail = typeof data?.detail === "string" ? data.detail : JSON.stringify(data?.detail || data);

        // NUEVO: email no verificado
        if (res.status === 403 && /no verificado|verifica/i.test(detail)) {
          // Si backend manda link / token en detail, lo mostramos tal cual.
          setError(detail);
          setNotice("Revisa tu correo. Si abriste el link de verificación, vuelve aquí e intenta login.");
          return;
        }

        throw new Error(`Login falló (HTTP ${res.status}). ${detail}`);
      }

      const tkn = data?.access_token || "";
      if (!tkn) throw new Error("Login OK, pero no se recibió access_token.");

      setToken(tkn);
      setNotice("Sesión iniciada.");
    } catch (e) {
      setError(e?.message || "Error de login.");
    }
  }

  async function handleRegister() {
    setError("");
    setNotice("");

    try {
      const res = await fetch(`${API_BASE}${AUTH_REGISTER_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
        },
        body: JSON.stringify({
          email: (email || "").trim(),
          password: password || "",
        }),
      });

      const rawText = await res.text();

      // Intentar parsear JSON; si no, dejar el texto
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }

      if (!res.ok) {
        const detailRaw = data?.detail ?? data?.message ?? rawText ?? `HTTP ${res.status}`;
        const detail = typeof detailRaw === "string" ? detailRaw : JSON.stringify(detailRaw);
        throw new Error(`Registro falló (HTTP ${res.status}). ${detail}`);
      }

      // ✅ Caso A: backend sí regresa token (modo antiguo o sin verificación)
      const tkn = (data?.access_token || "").trim();
      if (tkn) {
        setToken(tkn);
        setNotice("Cuenta creada. Sesión iniciada.");
        setAuthMode("login");
        return;
      }

      // ✅ Caso B: backend NO regresa token (flujo nuevo: verificar email)
      // Tomamos un mensaje útil si viene en payload.
      const msgRaw =
        data?.message ||
        data?.detail ||
        "Cuenta creada. Revisa tu correo para verificar tu cuenta y después inicia sesión.";

      const msg = typeof msgRaw === "string" ? msgRaw : JSON.stringify(msgRaw);

      setNotice(msg);
      setAuthMode("login");

      // Opcional UX: dejar el password vacío (evita reintentos con password visible)
      // setPassword("");

    } catch (e) {
      setError(e?.message || "Error de registro.");
    }
  }

  function handleLogout() {
    // 1) Corta sesión en memoria
    setToken("");
    setMe(null);

    // 2) Limpia token persistido INMEDIATO (evita re-login fantasma)
    try {
      localStorage.removeItem(LS_TOKEN);
    } catch {}

    // 3) UI
    setNotice("");
    setError("");

    // 4) Limpia estado de trabajo
    setResult(null);
    setActiveSavedKey("");
    setChatOpen(false);
    setChatMessages([]);
    setChatInput("");
    setChatStatus("");

    // 5) Filtros
    setSearchSaved("");
    setFilterSavedSubject("all");
    setFilterSavedModule("all");
    setFilterSavedLevel("all");
  }

  function validateBeforeGenerate() {
    if (!token) return "Debes iniciar sesión para generar contenido.";
    if (!subjectId) return "Selecciona una Materia.";
    if (!topicId) return "Selecciona un Tema.";
    if (selectedTopic?.subtopics?.length > 0 && !subtopicId) return "Selecciona un Subtema.";
    if (!module) return "Selecciona qué quieres generar.";

    if (npmProfile === "basicas" && (module === "enarm" || module === "gpc_summary")) {
      return "Materia básica: ENARM y Resumen GPC no están disponibles.";
    }
    if (module === "gpc_summary" && !hasPro) return "Resumen GPC disponible solo en Pro/Premium.";

    if (module === "enarm" && !enarmContext) return "Para ENARM debes confirmar el modo ENARM (check).";
    if (module === "gpc_summary" && !useGuides) return "Resumen GPC requiere usar guías actualizadas.";
    if (Number(durationMinutes) < 5 || Number(durationMinutes) > 120) return "Duración inválida (5–120 min recomendado).";
    if (module === "enarm" || module === "exam") {
      if (Number(numQuestions) < 5 || Number(numQuestions) > 200) return "Número de preguntas inválido (5–200).";
    }
    return "";
  }

  async function handleGenerate() {
    setError("");
    setNotice("");

    const validation = validateBeforeGenerate();
    if (validation) {
      setError(validation);
      return;
    }

    if (!API_KEY) {
      setError("Falta VITE_API_KEY. Revisa .env (VITE_API_KEY) y reinicia npm run dev.");
      return;
    }

    try {
      const payload = {
        subject_id: subjectId,
        topic_id: finalTopicId,
        module,
        level,
        duration_minutes: Number(durationMinutes),
        style: module === "lesson" ? style : undefined,
        use_guides: module === "gpc_summary" ? true : useGuides || undefined,
        enarm_context: module === "enarm" ? true : enarmContext || undefined,
        num_questions: module === "exam" || module === "enarm" ? Number(numQuestions) : undefined,
      };
      Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

      setIsGenerating(true);
      setNotice("Generando…");

      let data = {};
      try {
        const idemKey = makeIdempotencyKey("teach");
        const res = await fetch(`${API_BASE}${TEACH_CURRICULUM_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
            Authorization: `Bearer ${token}`,
            "Idempotency-Key": idemKey,
          },
          body: JSON.stringify(payload),
        });

        data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const detail = String(data?.detail || res.statusText || "Error");

          // ✅ NUEVO: sesión expirada
          if (res.status === 401) {
            setError("Tu sesión expiró. Inicia sesión de nuevo.");
            setNotice("");
            setToken("");
            setMe(null);
            try {
              localStorage.removeItem(LS_TOKEN);
            } catch {}
            return;
          }

          // ✅ NUEVO: acceso prohibido (ej. email no verificado, plan, etc.)
          if (res.status === 403) {
            setError(detail);
            setNotice("");
            return;
          }

          // Tus casos actuales
          if (res.status === 429 && detail.includes("Límite mensual alcanzado")) {
            setError(detail);
            setQuotaBlocked(true);
            setNotice("");
            return;
          }
          if (res.status === 429) {
            setError(detail);
            setNotice("");
            return;
          }

          throw new Error(detail);
        }

        setQuotaBlocked(false);
      } finally {
        setIsGenerating(false);
      }

      const session_id = data?.session_id || `sess_${Math.random().toString(16).slice(2)}`;
      const content = data?.lesson || data?.exam || data?.enarm || data?.gpc_summary || "";

      const normalized = {
        session_id,
        title: data?.title || `${humanLabelModule(module)} — ${selectedTopic?.name || "Tema"}`,
        subject_id: subjectId,
        subject_name: selectedSubject?.name || data?.subject || subjectId,
        topic_id: topicId,
        topic_name: selectedTopic?.name || topicId,
        npm_profile: npmProfile,
        module,
        level,
        duration_minutes: Number(durationMinutes),
        created_at: nowISO(),
        lesson: content,
        raw: data,
      };

      setResult(normalized);
      setNotice("Contenido generado.");
      fetchUsage(token);

      setTimeout(() => {
        resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    } catch (e) {
      setNotice("");
      setError(e?.message || "Error al generar.");
    }
  }

  function buildSavedKey(meta) {
    return `${meta.subject_id}|${meta.topic_id}|${meta.module}|${meta.level}|${meta.duration_minutes}|${meta.created_at}`;
  }

  function handleSaveCurrent() {
    if (!result) return;

    const key = buildSavedKey(result);
    const sid = result?.session_id;
    const chatForThis = sid ? getChatForSession(sid) : [];

    const toSave = { ...result, saved_key: key, chat_messages: chatForThis };

    setSavedLessons((prev) => {
      const arr = Array.isArray(prev) ? prev : [];
      const exists = arr.some((x) => x?.saved_key === key);
      return exists ? arr : [...arr, toSave];
    });

    setActiveSavedKey(key);
    setNotice("Guardado en Mis clases.");
  }

  function openSaved(item) {
    if (!item) return;

    setActiveSavedKey(item.saved_key || "");
    setResult(item);

    const sid = item?.session_id;
    const embedded = Array.isArray(item?.chat_messages) ? item.chat_messages : null;
    const stored = sid ? getChatForSession(sid) : [];
    const nextChat = embedded ?? stored;
    setChatMessages(Array.isArray(nextChat) ? nextChat : []);

    setError("");
    setNotice("Clase abierta desde Mis clases.");
    setChatStatus("");

    setTimeout(() => {
      resultRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }, 50);
  }

  function deleteSaved(saved_key) {
    if (!saved_key) return;

    const item = (Array.isArray(savedLessons) ? savedLessons : []).find((x) => x?.saved_key === saved_key);
    const sid = item?.session_id;

    setSavedLessons((prev) => {
      const arr = Array.isArray(prev) ? prev : [];
      return arr.filter((x) => x?.saved_key !== saved_key);
    });

    if (activeSavedKey === saved_key) setActiveSavedKey("");

    if (sid) {
      try {
        const store = loadChatStore();
        delete store[sid];
        saveChatStore(store);
      } catch {}
      if (result?.session_id === sid) {
        setChatMessages([]);
        setChatInput("");
        setChatStatus("");
      }
    }

    setNotice("Clase eliminada.");
    setError("");
  }

  async function handleChatSend() {
    setError("");
    setNotice("");

    const sid = result?.session_id;
    if (!sid) {
      setError("Genera o abre una clase antes de usar el chat.");
      return;
    }

    const q = (chatInput || "").trim();
    if (!q) return;

    const userMsg = { role: "user", content: q, created_at: nowISO() };
    setChatMessages((prev) => [...(Array.isArray(prev) ? prev : []), userMsg]);
    setChatInput("");
    setChatStatus("Pensando…");

    try {
      const tkn = localStorage.getItem(LS_TOKEN);
      if (!tkn) throw new Error("No hay sesión activa. Inicia sesión para usar el chat.");
      if (!API_KEY) throw new Error("Falta VITE_API_KEY. Revisa .env y reinicia npm run dev.");

      const payload = { session_id: sid, mode: "academico", detail_level: "extendido", message: q };

      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
          Authorization: `Bearer ${tkn}`,
        },
        body: JSON.stringify(payload),
      });

      const rawText = await res.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }

      if (!res.ok) {
        const detailRaw = data?.detail ?? data?.message ?? rawText ?? `HTTP ${res.status}`;
        const detail = typeof detailRaw === "string" ? detailRaw : JSON.stringify(detailRaw, null, 2);
        throw new Error(`Chat error ${res.status}: ${detail}`);
      }

      const answer = ((data?.response ?? "") + "").trim() || "(Sin respuesta)";
      const assistantMsg = { role: "assistant", content: answer, created_at: nowISO() };
      setChatMessages((prev) => [...(Array.isArray(prev) ? prev : []), assistantMsg]);
    } catch (err) {
      const assistantMsg = {
        role: "assistant",
        content: `No pude obtener respuesta del backend.\n\nDetalle técnico: ${err?.message || "Error desconocido"}`,
        created_at: nowISO(),
      };
      setChatMessages((prev) => [...(Array.isArray(prev) ? prev : []), assistantMsg]);
    } finally {
      setChatStatus("");
    }
  }

  const filteredSaved = useMemo(() => {
    const q = searchSaved.trim().toLowerCase();
    return (Array.isArray(savedLessons) ? savedLessons : [])
      .filter((x) => {
        if (filterSavedSubject !== "all" && x.subject_id !== filterSavedSubject) return false;
        if (filterSavedModule !== "all" && x.module !== filterSavedModule) return false;
        if (filterSavedLevel !== "all" && x.level !== filterSavedLevel) return false;
        if (!q) return true;
        const hay = `${x.title || ""} ${x.subject_name || ""} ${x.topic_name || ""} ${x.module || ""} ${x.level || ""}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }, [savedLessons, searchSaved, filterSavedSubject, filterSavedModule, filterSavedLevel]);

  async function handleDownloadPDFInstitutional() {
    setError("");
    setNotice("");

    if (!result?.lesson) {
      setError("No hay contenido para exportar a PDF.");
      return;
    }
    if (!hasPro) {
      setError("Descarga en PDF institucional disponible solo en Pro/Premium.");
      return;
    }

    try {
      setNotice("Generando PDF…");
      const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });

      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const marginX = 14;
      const marginTop = 18;
      const marginBottom = 16;
      const headerH = 12;
      const footerH = 10;

      let y = marginTop + headerH;

      const ensureSpace = (neededMm) => {
        if (y + neededMm <= pageHeight - marginBottom - footerH) return;
        doc.addPage();
        y = marginTop + headerH;
      };

      const drawHeaderFooter = (pageNo, totalPages) => {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.text("E-Vantis — Documento institucional", marginX, marginTop);

        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        const right = `Plan: ${me?.plan || "—"}`;
        doc.text(right, pageWidth - marginX, marginTop, { align: "right" });

        doc.setLineWidth(0.2);
        doc.line(marginX, marginTop + 3, pageWidth - marginX, marginTop + 3);

        const footerY = pageHeight - marginBottom;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.text("E-Vantis — Uso académico. No sustituye juicio clínico.", marginX, footerY);
        doc.text(`Página ${pageNo} de ${totalPages}`, pageWidth - marginX, footerY, { align: "right" });
      };

      // COVER
      doc.setFont("helvetica", "bold");
      doc.setFontSize(26);
      doc.text("E-Vantis", marginX, 40);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(12);
      doc.text("Documento institucional", marginX, 50);

      doc.setLineWidth(0.5);
      doc.line(marginX, 56, pageWidth - marginX, 56);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      const coverTitle = (result?.title || "Contenido").toString();
      const coverLines = doc.splitTextToSize(coverTitle, pageWidth - marginX * 2);
      doc.text(coverLines, marginX, 72);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(12);

      const meta = [
        `Materia: ${result?.subject_name || "—"}`,
        `Tema: ${result?.topic_name || "—"}`,
        `Módulo: ${humanLabelModule(result?.module) || "—"}`,
        `Profundidad: ${humanLabelLevel(result?.level) || "—"}`,
        `Duración: ${result?.duration_minutes ? `${result.duration_minutes} min` : "—"}`,
        `Fecha: ${new Date().toLocaleString()}`,
      ];

      let metaY = 100;
      for (const row of meta) {
        const rows = doc.splitTextToSize(row, pageWidth - marginX * 2);
        doc.text(rows, marginX, metaY);
        metaY += rows.length * 6;
      }

      doc.setFontSize(10);
      doc.text("Generado por E-Vantis. Uso académico.", marginX, pageHeight - 30);

      doc.addPage();
      y = marginTop + headerH;

      const blocksPdf = parseMarkdownToBlocks(result?.lesson || "");

      const writeHeading = (text, size, extraSpace = 2) => {
        ensureSpace(10);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(size);
        const lines = doc.splitTextToSize(text, pageWidth - marginX * 2);
        doc.text(lines, marginX, y);
        y += lines.length * (size >= 14 ? 6 : 5) + extraSpace;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(11);
      };

      const writeParagraph = (text) => {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(11);
        const lines = doc.splitTextToSize(text, pageWidth - marginX * 2);
        for (const ln of lines) {
          ensureSpace(6);
          doc.text(ln, marginX, y);
          y += 5;
        }
        y += 1;
      };

      const writeListItem = (text) => {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(11);
        const bullet = "•";
        const indentX = 6;
        const maxW = pageWidth - marginX * 2 - indentX;
        const lines = doc.splitTextToSize(text, maxW);
        ensureSpace(6);

        doc.text(bullet, marginX, y);
        doc.text(lines[0] || "", marginX + indentX, y);
        y += 5;

        for (let i = 1; i < lines.length; i++) {
          ensureSpace(6);
          doc.text(lines[i], marginX + indentX, y);
          y += 5;
        }
        y += 1;
      };

      for (const b of blocksPdf) {
        if (b.type === "space") {
          y += 3;
          continue;
        }
        if (b.type === "h1") {
          writeHeading(b.text, 18, 2);
          continue;
        }
        if (b.type === "h2") {
          writeHeading(b.text, 15, 1);
          continue;
        }
        if (b.type === "li") {
          writeListItem(b.text);
          continue;
        }
        if (b.type === "p") {
          writeParagraph(b.text);
          continue;
        }
      }

      // Chat al final (si existe)
      const sid = result?.session_id;
      const chat = sid ? getChatForSession(sid) : [];
      if (Array.isArray(chat) && chat.length > 0) {
        ensureSpace(10);
        doc.setLineWidth(0.2);
        doc.line(marginX, y, pageWidth - marginX, y);
        y += 6;

        writeHeading("Chat académico", 14, 2);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);

        for (const m of chat) {
          const who = m?.role === "user" ? "Tú" : "E-Vantis";
          const when = m?.created_at ? ` — ${m.created_at}` : "";
          const header = `${who}${when}`;
          const content = (m?.content || "").toString();

          doc.setFont("helvetica", "bold");
          const hLines = doc.splitTextToSize(header, pageWidth - marginX * 2);
          for (const hl of hLines) {
            ensureSpace(6);
            doc.text(hl, marginX, y);
            y += 4.5;
          }

          doc.setFont("helvetica", "normal");
          const cLines = doc.splitTextToSize(content, pageWidth - marginX * 2);
          for (const cl of cLines) {
            ensureSpace(6);
            doc.text(cl, marginX, y);
            y += 4.5;
          }
          y += 3;
        }
      }

      const totalPages = doc.getNumberOfPages();
      for (let p = 2; p <= totalPages; p++) {
        doc.setPage(p);
        drawHeaderFooter(p - 1, totalPages - 1);
      }

      const fileBase =
        (result?.title || "evantis_documento").replace(/[^\w\s-]+/g, "").slice(0, 60).trim() || "evantis_documento";

      doc.save(`${fileBase}.pdf`);
      setNotice("PDF descargado.");
    } catch (e) {
      setNotice("");
      setError(e?.message || "No se pudo generar el PDF.");
    }
  }

  /* =========================
     AUTH SCREEN
  ========================= */
  if (!token) {
    return (
      <div className="ev-wrap">
        <div className="ev-topbar">
          <div className="ev-brand">
            <div className="ev-logo" />
            <div>
              <div className="ev-title">E-Vantis</div>
              <div className="ev-sub">Plataforma académica</div>
            </div>
          </div>
        </div>

        <Banner notice={notice} error={error} />

        <div className="ev-card" style={{ marginTop: 14 }}>
          <div className="ev-card-h">
            <div>
              <div className="ev-card-t">Entrar a E-Vantis</div>
              <div className="ev-card-d">
                {authMode === "register"
                  ? "Crea tu cuenta y comienza en plan Free."
                  : "Inicia sesión para generar clases y guardar tu progreso."}
              </div>
            </div>
            <div className="ev-row">
              <button className="ev-btn" type="button" onClick={() => setAuthMode("login")}>
                Login
              </button>
              <button className="ev-btn ev-btn-primary" type="button" onClick={() => setAuthMode("register")}>
                Crear cuenta
              </button>
            </div>
          </div>

          <div className="ev-card-b">
            <div className="ev-row" style={{ gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div className="ev-field">
                  <label className="ev-label">Email</label>
                  <input
                    className="ev-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="tu@email.com"
                    autoComplete="email"
                  />
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div className="ev-field">
                  <label className="ev-label">Password</label>
                  <input
                    className="ev-input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete={authMode === "register" ? "new-password" : "current-password"}
                  />
                </div>
              </div>
            </div>

            <div className="ev-row" style={{ marginTop: 10 }}>
              <button className="ev-btn ev-btn-primary" onClick={authMode === "register" ? handleRegister : handleLogin}>
                {authMode === "register" ? "Crear cuenta" : "Iniciar sesión"}
              </button>
              <div className="ev-muted" style={{ fontSize: 12 }}>
                Al continuar aceptas uso académico. No sustituye juicio clínico.
              </div>
            </div>
          </div>
        </div>

        <div className="ev-muted" style={{ marginTop: 14, fontSize: 12 }}>
          E-Vantis — Plataforma académica. Si tienes problemas, recarga y vuelve a iniciar sesión.
        </div>
      </div>
    );
  }

  /* =========================
     APP SHELL (logueado)
  ========================= */
  return (
    <div className="ev-wrap">
      <div className="ev-topbar">
        <div className="ev-brand">
          <div className="ev-logo" />
          <div>
            <div className="ev-title">E-Vantis</div>
            <div className="ev-sub">Clases • Exámenes • Casos ENARM • Guardadas • Chat</div>
          </div>
        </div>

        <div className="ev-row">
          <span className="ev-pill">
            Plan: <b>{me?.plan || "—"}</b>
          </span>
          {hasPro ? <span className="ev-badge ev-badge-accent">Pro/Premium</span> : <span className="ev-badge">Free</span>}
          <button className="ev-btn" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>

      {usage?.modules && (
        <div className="ev-card" style={{ marginTop: 14 }}>
          <div className="ev-card-h">
            <div>
              <div className="ev-card-t">Uso mensual</div>
              <div className="ev-card-d">
                lesson {usage.modules.lesson.used}/{usage.modules.lesson.limit} · exam {usage.modules.exam.used}/{usage.modules.exam.limit} · enarm{" "}
                {usage.modules.enarm.used}/{usage.modules.enarm.limit} · gpc {usage.modules.gpc_summary.used}/{usage.modules.gpc_summary.limit}
              </div>
            </div>

            {SHOW_DEBUG_PILLS ? (
              <div className="ev-row">
                <span className="ev-pill">
                  API: <b>{API_BASE}</b>
                </span>
                <span className="ev-pill">
                  Curriculum: <b>embebido</b>
                </span>
              </div>
            ) : null}
          </div>
        </div>
      )}

      <Banner notice={notice} error={error} />

      <div className="ev-grid">
        {/* LEFT */}
        <div className="ev-card">
          <div className="ev-card-h">
            <div>
              <div className="ev-card-t">Crear contenido</div>
              <div className="ev-card-d">Selecciona Materia → Tema → Subtema y el Módulo.</div>
            </div>
            <span className="ev-badge">{selectedSubject?.npm_profile ? `Perfil: ${selectedSubject.npm_profile}` : "Perfil: —"}</span>
          </div>

          <div className="ev-card-b">
            <div className="ev-field">
              <label className="ev-label">Materia</label>
              <select className="ev-select" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                <option value="">— Selecciona —</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="ev-field">
              <label className="ev-label">Tema</label>
              <select className="ev-select" value={topicId} onChange={(e) => setTopicId(e.target.value)} disabled={!subjectId}>
                <option value="">— Selecciona —</option>
                {blocks.map((b) => (
                  <React.Fragment key={b.id}>
                    <option value="" disabled>
                      — {b.name} —
                    </option>
                    {(b.macro_topics || []).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </React.Fragment>
                ))}
              </select>
            </div>

            <div className="ev-field">
              <label className="ev-label">Subtema</label>
              <select
                className="ev-select"
                value={subtopicId}
                onChange={(e) => setSubtopicId(e.target.value)}
                disabled={!selectedTopic || !(selectedTopic.subtopics?.length > 0)}
              >
                <option value="">{selectedTopic?.subtopics?.length > 0 ? "— Selecciona —" : "— (Sin subtemas) —"}</option>
                {(selectedTopic?.subtopics || []).map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="ev-field">
              <label className="ev-label">Qué quieres generar</label>
              <select className="ev-select" value={module} onChange={(e) => setModule(e.target.value)}>
                {moduleOptions.map((m) => (
                  <option key={m} value={m}>
                    {humanLabelModule(m)}
                  </option>
                ))}
              </select>
              {!hasPro && moduleOptions.includes("gpc_summary") === false && (
                <div className="ev-muted" style={{ fontSize: 12 }}>
                  Resumen GPC requiere Pro/Premium.
                </div>
              )}
            </div>

            <div className="ev-field">
              <label className="ev-label">Profundidad</label>
              <select className="ev-select" value={level} onChange={(e) => setLevel(e.target.value)}>
                <option value="auto">Adaptativa</option>
                <option value="pregrado">Pregrado</option>
                <option value="internado">Clínica</option>
              </select>
            </div>

            <div className="ev-row">
              <div style={{ flex: 1 }}>
                <div className="ev-field">
                  <label className="ev-label">Duración (min)</label>
                  <input className="ev-input" type="number" value={durationMinutes} onChange={(e) => setDurationMinutes(e.target.value)} min={5} max={120} />
                </div>
              </div>

              <div style={{ flex: 1 }}>
                <div className="ev-field">
                  <label className="ev-label">Estilo (solo clases)</label>
                  <select className="ev-select" value={style} onChange={(e) => setStyle(e.target.value)} disabled={module !== "lesson"}>
                    <option value="magistral">Magistral</option>
                    <option value="high_yield">High-yield</option>
                    <option value="socratico">Socrático</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="ev-row">
              <div style={{ flex: 1 }}>
                <div className="ev-field">
                  <label className="ev-label">Número de preguntas</label>
                  <input
                    className="ev-input"
                    type="number"
                    value={numQuestions}
                    onChange={(e) => setNumQuestions(e.target.value)}
                    min={5}
                    max={200}
                    disabled={!(module === "exam" || module === "enarm")}
                  />
                </div>
              </div>

              <div style={{ alignSelf: "end" }}>
                <button className="ev-btn" onClick={() => setAdvancedOpen((v) => !v)}>
                  {advancedOpen ? "Ocultar" : "Mostrar"} avanzadas
                </button>
              </div>
            </div>

            {advancedOpen && (
              <div className="ev-alert" style={{ marginTop: 8 }}>
                <label className="ev-row" style={{ gap: 10, marginBottom: 8 }}>
                  <input type="checkbox" checked={useGuides} onChange={(e) => setUseGuides(e.target.checked)} disabled={module === "gpc_summary"} />
                  <span style={{ fontSize: 13 }}>Usar guías actualizadas (requerido para Resumen GPC)</span>
                </label>

                <label className="ev-row" style={{ gap: 10 }}>
                  <input type="checkbox" checked={enarmContext} onChange={(e) => setEnarmContext(e.target.checked)} />
                  <span style={{ fontSize: 13 }}>Confirmo modo ENARM</span>
                </label>
              </div>
            )}

            <button className="ev-btn ev-btn-primary" onClick={handleGenerate} disabled={isGenerating || quotaBlocked} style={{ width: "100%", marginTop: 10 }}>
              {quotaBlocked ? "Cuota mensual alcanzada" : isGenerating ? "Generando…" : "Generar"}
            </button>

            <div className="ev-muted" style={{ fontSize: 12, marginTop: 10 }}>
              Se enviará: <b>{selectedSubject?.name || "Materia"}</b> → <b>{selectedTopic?.name || "Tema"}</b> → <b>{humanLabelModule(module)}</b>
            </div>
          </div>
        </div>

        {/* RIGHT */}
        <div style={{ display: "grid", gap: 14 }}>
          <div ref={resultRef} className="ev-card">
            <div className="ev-card-h">
              <div>
                <div className="ev-card-t">Resultado</div>
                <div className="ev-card-d">{result ? "Contenido generado." : "Aún no hay contenido generado."}</div>
              </div>

              <div className="ev-row">
                <button className="ev-btn" onClick={handleSaveCurrent} disabled={!result}>
                  Guardar
                </button>
                <button className="ev-btn ev-btn-cta" onClick={handleDownloadPDFInstitutional} disabled={!hasPro || !result}>
                  PDF (Pro/Premium)
                </button>
              </div>
            </div>

            <div className="ev-card-b">
              {result ? (
                <>
                  <div style={{ fontSize: 16, fontWeight: 900 }}>{result.title}</div>

                  <div className="ev-muted" style={{ fontSize: 12, marginTop: 6 }}>
                    <b>Materia:</b> {result.subject_name} • <b>Tema:</b> {result.topic_name} • <b>Módulo:</b> {humanLabelModule(result.module)} •{" "}
                    <b>Profundidad:</b> {humanLabelLevel(result.level)} • <b>Duración:</b> {result.duration_minutes} min
                  </div>

                  <div className="ev-content" style={{ marginTop: 12 }} dangerouslySetInnerHTML={{ __html: buildSectionedHTML(result.lesson || "") }} />

                  {/* CHAT */}
                  <div className="ev-card" style={{ marginTop: 12 }}>
                    <div className="ev-card-h">
                      <div>
                        <div className="ev-card-t">Chat académico</div>
                        <div className="ev-card-d">Preguntas sobre esta clase (se guarda por sesión).</div>
                      </div>
                      <button className="ev-btn" onClick={() => setChatOpen((v) => !v)}>
                        {chatOpen ? "Ocultar" : "Abrir"} chat
                      </button>
                    </div>

                    {chatOpen && (
                      <div className="ev-card-b">
                        <div ref={chatBoxRef} className="ev-card" style={{ padding: 12, maxHeight: 280, overflow: "auto", background: "rgba(0,0,0,0.10)" }}>
                          {chatMessages.length === 0 ? (
                            <div className="ev-muted" style={{ fontSize: 12 }}>
                              No hay mensajes aún. Escribe tu primera duda.
                            </div>
                          ) : (
                            chatMessages.map((m, idx) => {
                              const isUser = m.role === "user";
                              const content = String(m.content || "");
                              return (
                                <div key={`${m.created_at || "t"}_${idx}`} style={{ marginBottom: 12 }}>
                                  <div className="ev-muted" style={{ fontSize: 12 }}>
                                    <b>{isUser ? "Tú" : "E-Vantis"}</b> · {m.created_at}
                                  </div>

                                  {isUser ? (
                                    <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.4 }}>{content}</div>
                                  ) : (
                                    <div className="ev-content" style={{ marginTop: 6 }} dangerouslySetInnerHTML={{ __html: renderAcademicHTML(content) }} />
                                  )}
                                </div>
                              );
                            })
                          )}
                        </div>

                        <div className="ev-row" style={{ marginTop: 10, alignItems: "stretch" }}>
                          <textarea
                            className="ev-textarea"
                            value={chatInput}
                            onChange={(e) => setChatInput(e.target.value)}
                            placeholder="Escribe tu duda… (Enter envía, Shift+Enter salto)"
                            rows={2}
                            style={{ minHeight: 70, flex: 1 }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                if (!chatStatus) handleChatSend();
                              }
                            }}
                            disabled={!!chatStatus}
                          />
                          <button className="ev-btn ev-btn-primary" onClick={handleChatSend} disabled={!!chatStatus}>
                            Enviar
                          </button>
                        </div>

                        {chatStatus && (
                          <div className="ev-muted" style={{ marginTop: 8, fontSize: 12 }}>
                            {chatStatus}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="ev-muted" style={{ fontSize: 12 }}>
                  Genera una clase/examen/caso para ver el contenido aquí.
                </div>
              )}
            </div>
          </div>

          {/* SAVED */}
          <div className="ev-card">
            <div className="ev-card-h">
              <div>
                <div className="ev-card-t">Mis clases</div>
                <div className="ev-card-d">
                  Guardadas: <b>{filteredSaved.length}</b> (total: {(Array.isArray(savedLessons) ? savedLessons : []).length})
                </div>
              </div>
            </div>

            <div className="ev-card-b">
              <div className="ev-row" style={{ flexWrap: "wrap" }}>
                <input className="ev-input" placeholder="Buscar…" value={searchSaved} onChange={(e) => setSearchSaved(e.target.value)} />

                <select className="ev-select" value={filterSavedSubject} onChange={(e) => setFilterSavedSubject(e.target.value)}>
                  <option value="all">Materia</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>

                <select className="ev-select" value={filterSavedModule} onChange={(e) => setFilterSavedModule(e.target.value)}>
                  <option value="all">Módulo</option>
                  <option value="lesson">Clase</option>
                  <option value="exam">Examen</option>
                  <option value="enarm">Caso ENARM</option>
                  <option value="gpc_summary">Resumen GPC</option>
                </select>

                <select className="ev-select" value={filterSavedLevel} onChange={(e) => setFilterSavedLevel(e.target.value)}>
                  <option value="all">Nivel</option>
                  <option value="auto">Adaptativa</option>
                  <option value="pregrado">Pregrado</option>
                  <option value="internado">Clínica</option>
                </select>
              </div>

              <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                {filteredSaved.length === 0 ? (
                  <div className="ev-muted" style={{ fontSize: 12 }}>
                    No hay clases guardadas con esos filtros.
                  </div>
                ) : (
                  filteredSaved.map((item) => {
                    const active = item.saved_key && item.saved_key === activeSavedKey;
                    return (
                      <div key={item.saved_key || item.session_id} className="ev-card" style={{ border: active ? "1px solid rgba(30,203,225,0.55)" : undefined }}>
                        <div className="ev-card-b">
                          <div className="ev-spread">
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 900 }}>{item.title || "Sin título"}</div>
                              <div className="ev-muted" style={{ fontSize: 12, marginTop: 6 }}>
                                <b>{item.subject_name}</b> • {item.topic_name} • {humanLabelModule(item.module)} • {humanLabelLevel(item.level)}
                              </div>
                              <div className="ev-muted" style={{ fontSize: 12, marginTop: 4 }}>{item.created_at ? `Creado: ${item.created_at}` : ""}</div>
                            </div>

                            <div className="ev-row">
                              <button className="ev-btn" onClick={() => openSaved(item)}>
                                Abrir
                              </button>
                              <button className="ev-btn" onClick={() => deleteSaved(item.saved_key)}>
                                Eliminar
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="ev-muted" style={{ marginTop: 14, fontSize: 12 }}>
        E-Vantis — UI para alumnos.
      </div>
    </div>
  );
}
