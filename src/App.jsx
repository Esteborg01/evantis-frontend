import React, { useEffect, useMemo, useRef, useState } from "react";
import jsPDF from "jspdf";
import CURRICULUM_EMBEDDED from "./evantis.curriculum.v1.json";

/* =========================
   CONFIG
========================= */
const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";
const API_KEY = import.meta.env.VITE_API_KEY || "";

const AUTH_LOGIN_PATH = "/auth/login";
const AUTH_REGISTER_PATH = "/auth/register";
const AUTH_ME_PATH = "/auth/me";
const TEACH_CURRICULUM_PATH = "/teach/curriculum";

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

function loadChatStore() {
  const parsed = safeJsonParse(localStorage.getItem(LS_CHAT), {});
  // Garantiza objeto plano
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
  return l === "internado" ? "Clínica" : l === "pregrado" ? "Pregrado" : "Automática";
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
   OJO: NO debe tocar hooks, token, notice, etc.
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
  return md.split("\n").map((line) => {
    const t = line.trim();
    if (!t) return { type: "space" };
    if (t.startsWith("## ")) return { type: "h2", text: t.slice(3) };
    if (t.startsWith("# ")) return { type: "h1", text: t.slice(2) };
    if (t.startsWith("- ")) return { type: "li", text: t.slice(2) };
    return { type: "p", text: t };
  });
}

/* =========================
   UI TOKENS (estético / consistente)
========================= */
const UI = {
  shell: {
    minHeight: "100vh",
    padding: 18,
    background: "linear-gradient(180deg, #fafafa, #f4f4f4)",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
  },
  container: {
    maxWidth: 1150,
    margin: "0 auto",
    display: "grid",
    gridTemplateColumns: "380px 1fr",
    gap: 14,
    alignItems: "start",
  },
  card: {
    background: "#fff",
    border: "1px solid #eaeaea",
    borderRadius: 16,
    padding: 14,
    boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
  },
  h1: { fontSize: 22, fontWeight: 900, margin: 0 },
  h2: { fontSize: 15, fontWeight: 900, margin: 0 },
  muted: { fontSize: 12, opacity: 0.75 },
  row: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  input: { width: "100%", padding: 10, borderRadius: 12, border: "1px solid #ddd", outline: "none" },
  select: { width: "100%", padding: 10, borderRadius: 12, border: "1px solid #ddd", outline: "none" },
  btn: { padding: "10px 12px", borderRadius: 12, border: "1px solid #111", cursor: "pointer", fontWeight: 900, background: "#111", color: "#fff" },
  btnGhost: { padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900, background: "#fff" },
  badge: { padding: "4px 8px", borderRadius: 999, border: "1px solid #e5e5e5", fontSize: 12, background: "#fff" },
};

function twoColOrOne() {
  // responsive sin CSS: si es pantalla chica, 1 columna
  return window.innerWidth < 980 ? "1fr" : "380px 1fr";
}

export default function App() {
  // =========================
  // AUTH
  // =========================
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState(localStorage.getItem(LS_TOKEN) || "");
  const [me, setMe] = useState(null);
  const [authStatus, setAuthStatus] = useState("");
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
    } catch {
      // ignore
    }
  }, [result]);

  // =========================
  // CHAT (por session_id)
  // =========================
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatStatus, setChatStatus] = useState("");
  const chatBoxRef = useRef(null);

  // Rehidratar chat al cambiar de clase
  useEffect(() => {
    const sid = result?.session_id;
    if (!sid) {
      setChatMessages([]);
      return;
    }
    setChatMessages(getChatForSession(sid));
  }, [result?.session_id]);

  // Persistir chat cuando cambia
  useEffect(() => {
    const sid = result?.session_id;
    if (!sid) return;
    setChatForSession(sid, chatMessages);
  }, [chatMessages, result?.session_id]);

  // Auto-scroll del chat (FASE 3)
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
    } catch {
      // ignore
    }
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
  const selectedSubject = useMemo(
    () => subjects.find((s) => s.id === subjectId) || null,
    [subjects, subjectId]
  );

  const blocks = useMemo(() => {
    return selectedSubject?.blocks || [];
  }, [selectedSubject]);

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
            if (st && typeof st === "object") {
              return { id: st.id, name: st.name };
            }
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

  const selectedTopic = useMemo(
    () => flatTopics.find((t) => t.id === topicId) || null,
    [flatTopics, topicId]
  );

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

  // Módulos permitidos por perfil + plan
  const moduleOptions = useMemo(() => {
    let base;
    if (npmProfile === "basicas") base = ["lesson", "exam"];
    else if (npmProfile === "puente") base = ["lesson", "exam", "enarm"];
    else if (npmProfile === "clinicas") base = ["lesson", "exam", "enarm", "gpc_summary"];
    else base = ["lesson", "exam", "enarm", "gpc_summary"];

    // gating plan: gpc_summary solo pro/premium
    if (!hasPro) base = base.filter((x) => x !== "gpc_summary");

    return base;
  }, [npmProfile, hasPro]);

  // Mantener module válido
  useEffect(() => {
    if (!moduleOptions.includes(module)) setModule(moduleOptions[0] || "lesson");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleOptions.join("|")]);

  // Reset topic al cambiar materia
  useEffect(() => {
    setTopicId("");
  }, [subjectId]);

  useEffect(() => {
    setSubtopicId("");
  }, [topicId]);

  // =========================
  // TOKEN PERSIST
  // =========================
  useEffect(() => {
    try {
      if (token) localStorage.setItem(LS_TOKEN, token);
      else localStorage.removeItem(LS_TOKEN);
    } catch {
      // ignore
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    fetchUsage(token);
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
            ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
            Authorization: `Bearer ${token}`,
          },
        });
        if (!res.ok) return;
        const data = await res.json();
        setMe(data);
      } catch {
        // ignore
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
    } catch {
      // ignore
    }
  }, []);

  // =========================
  // ACTIONS
  // =========================
  async function handleLogin() {
    setAuthStatus("Iniciando sesión…");
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
        const detail =
          typeof data?.detail === "string" ? data.detail : JSON.stringify(data?.detail || data);
        throw new Error(`Login falló (HTTP ${res.status}). ${detail}`);
      }

      const tkn = data?.access_token || "";
      if (!tkn) throw new Error("Login OK, pero no se recibió access_token.");

      setToken(tkn);
      setAuthStatus("Sesión iniciada.");
      setNotice("Sesión iniciada.");
    } catch (e) {
      setAuthStatus("");
      setError(e?.message || "Error de login.");
    }
  }

  async function handleRegister() {
    setAuthStatus("Creando cuenta…");
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
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        data = { detail: rawText };
      }

      if (!res.ok) {
        const detail =
          typeof data?.detail === "string" ? data.detail : JSON.stringify(data?.detail || data);
        throw new Error(`Registro falló (HTTP ${res.status}). ${detail}`);
      }

      const tkn = data?.access_token || "";
      if (!tkn) throw new Error("Registro OK, pero no se recibió access_token.");

      setToken(tkn);
      setAuthStatus("Cuenta creada. Sesión iniciada.");
      setNotice("Cuenta creada. Sesión iniciada.");
      setAuthMode("login"); // opcional
    } catch (e) {
      setAuthStatus("");
      setError(e?.message || "Error de registro.");
    }
  }

  function handleLogout() {
    setToken("");
    setMe(null);
    setAuthStatus("Sesión cerrada.");
    setNotice("Sesión cerrada.");

    // Limpieza de UI sensible
    setResult(null);
    setActiveSavedKey("");
    setChatOpen(false);
    setChatMessages([]);
    setChatInput("");
    setChatStatus("");

    setSearchSaved("");
    setFilterSavedSubject("all");
    setFilterSavedModule("all");
    setFilterSavedLevel("all");
  }

  function validateBeforeGenerate() {
    if (!token) return "Debes iniciar sesión para generar contenido.";
    if (!subjectId) return "Selecciona una Materia.";
    if (!topicId) return "Selecciona un Tema.";
    if (selectedTopic?.subtopics?.length > 0 && !subtopicId) {
      return "Selecciona un Subtema.";
    }
    if (!module) return "Selecciona qué quieres generar.";

    // Perfil
    if (npmProfile === "basicas" && (module === "enarm" || module === "gpc_summary")) {
      return "Materia básica: ENARM y Resumen GPC no están disponibles.";
    }

    // FASE 7: gating plan
    if (module === "gpc_summary" && !hasPro) {
      return "Resumen GPC disponible solo en Pro/Premium.";
    }

    // Reglas UI
    if (module === "enarm" && !enarmContext) return "Para ENARM debes confirmar el modo ENARM (check).";
    if (module === "gpc_summary" && !useGuides) return "Resumen GPC requiere usar guías actualizadas.";
    if (durationMinutes < 5 || durationMinutes > 120) return "Duración inválida (5–120 min recomendado).";
    if (module === "enarm" || module === "exam") {
      if (numQuestions < 5 || numQuestions > 200) return "Número de preguntas inválido (5–200).";
    }
    return "";
  }

  async function fetchUsage(currentToken) {
    try {
      const res = await fetch(`${API_BASE}/usage/me`, {
        headers: { Authorization: `Bearer ${currentToken}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setUsage(data);
    } catch (e) {
      // silencioso para no romper UX
    }
  }


  async function handleGenerate() {
    setError("");
    setNotice("");

    const validation = validateBeforeGenerate();
    if (validation) {
      setError(validation);
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
        const res = await fetch(`${API_BASE}${TEACH_CURRICULUM_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
            Authorization: `Bearer ${token}`,
            // (Opcional) idempotency key si ya lo implementaste en backend y decides usarlo
            // "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify(payload),
        });

        // Intentar parsear JSON; si no, quedarnos con {}
        data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const detail = String(data?.detail || res.statusText || "Error");

          // 429 por cuota mensual (bloquea CTA)
          if (res.status === 429 && detail.includes("Límite mensual alcanzado")) {
            setError(detail);
            setQuotaBlocked(true);
            setNotice("");
            return;
          }

          // 429 por rate limit / bursts (no bloquea permanente, solo mensaje)
          if (res.status === 429) {
            setError(detail);
            setNotice("");
            return;
          }

          // Otros errores
          throw new Error(detail);
        }

        // Éxito: si estaba bloqueado, lo desbloqueamos
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
    const core = `${meta.subject_id}|${meta.topic_id}|${meta.module}|${meta.level}|${meta.duration_minutes}|${meta.created_at}`;
    return core;
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

    // Rehidrata chat: preferir embebido, si no store
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

  // deleteSaved ÚNICO + borra chat asociado
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
      } catch {
        // ignore
      }
      if (result?.session_id === sid) {
        setChatMessages([]);
        setChatInput("");
        setChatStatus("");
      }
    }

    setNotice("Clase eliminada de Mis clases.");
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

      const payload = {
        session_id: sid,
        mode: "academico",
        detail_level: "extendido",
        message: q,
      };

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

    // FASE 7: gating por plan
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
        const right = `Session: ${result?.session_id || "—"}`;
        doc.text(right, pageWidth - marginX, marginTop, { align: "right" });

        doc.setLineWidth(0.2);
        doc.line(marginX, marginTop + 3, pageWidth - marginX, marginTop + 3);

        const footerY = pageHeight - marginBottom;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.text("E-Vantis — Uso académico. No sustituye juicio clínico.", marginX, footerY);
        doc.text(`Página ${pageNo} de ${totalPages}`, pageWidth - marginX, footerY, { align: "right" });
      };

      // ===== PORTADA =====
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
        `Session ID: ${result?.session_id || "—"}`,
        `Plan: ${me?.plan || "—"}`,
      ];

      let metaY = 100;
      for (const row of meta) {
        const rows = doc.splitTextToSize(row, pageWidth - marginX * 2);
        doc.text(rows, marginX, metaY);
        metaY += rows.length * 6;
      }

      doc.setFontSize(10);
      doc.text("Generado por E-Vantis. Uso académico.", marginX, pageHeight - 30);

      // ===== CONTENIDO =====
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

      // ===== CHAT (si existe) =====
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

      // ===== HEADER/FOOTER EN TODAS LAS PÁGINAS EXCEPTO PORTADA =====
      const totalPages = doc.getNumberOfPages();
      for (let p = 2; p <= totalPages; p++) {
        doc.setPage(p);
        drawHeaderFooter(p - 1, totalPages - 1);
      }

      const fileBase =
        (result?.title || "evantis_documento")
          .replace(/[^\w\s-]+/g, "")
          .slice(0, 60)
          .trim() || "evantis_documento";

      doc.save(`${fileBase}.pdf`);
      setNotice("PDF descargado.");
    } catch (e) {
      setNotice("");
      setError(e?.message || "No se pudo generar el PDF.");
    }
  }

    /* =========================
     UI KIT (inline, sin CSS extra)
     - Cards, Buttons, Inputs
     - Layout responsive
  ========================= */
  const UI = {
    page: {
      minHeight: "100vh",
      background: "linear-gradient(180deg, #f8fafc 0%, #ffffff 60%)",
      color: "#0f172a",
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
    },
    shell: { maxWidth: 1180, margin: "0 auto", padding: 18 },
    topbar: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
      padding: "14px 16px",
      borderRadius: 16,
      border: "1px solid #e5e7eb",
      background: "rgba(255,255,255,0.9)",
      boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
      position: "sticky",
      top: 12,
      backdropFilter: "blur(8px)",
      zIndex: 10,
    },
    brand: { display: "flex", alignItems: "center", gap: 10 },
    logo: {
      width: 36,
      height: 36,
      borderRadius: 12,
      background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 60%, #db2777 120%)",
      boxShadow: "0 10px 20px rgba(37,99,235,0.18)",
    },
    title: { fontSize: 16, fontWeight: 800, letterSpacing: 0.2 },
    subtitle: { fontSize: 12, opacity: 0.7, marginTop: 2 },
    pillRow: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
    pill: (tone = "neutral") => ({
      fontSize: 12,
      padding: "6px 10px",
      borderRadius: 999,
      border: "1px solid #e5e7eb",
      background:
        tone === "good"
          ? "rgba(34,197,94,0.10)"
          : tone === "warn"
          ? "rgba(234,179,8,0.12)"
          : tone === "bad"
          ? "rgba(239,68,68,0.10)"
          : "rgba(15,23,42,0.03)",
      color:
        tone === "good"
          ? "#166534"
          : tone === "warn"
          ? "#854d0e"
          : tone === "bad"
          ? "#991b1b"
          : "#0f172a",
    }),
    grid: {
      display: "grid",
      gridTemplateColumns: "360px 1fr",
      gap: 14,
      marginTop: 14,
    },
    gridMobile: {
      display: "grid",
      gridTemplateColumns: "1fr",
      gap: 14,
      marginTop: 14,
    },
    card: {
      border: "1px solid #e5e7eb",
      background: "rgba(255,255,255,0.92)",
      borderRadius: 16,
      padding: 14,
      boxShadow: "0 10px 26px rgba(15, 23, 42, 0.06)",
    },
    cardTitle: { fontSize: 13, fontWeight: 800, margin: 0 },
    cardHint: { fontSize: 12, opacity: 0.72, marginTop: 6, lineHeight: 1.35 },
    sectionTitle: { fontSize: 13, fontWeight: 800, margin: 0 },
    row: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" },
    field: { display: "grid", gap: 6 },
    label: { fontSize: 12, opacity: 0.75 },
    input: {
      padding: "10px 12px",
      borderRadius: 12,
      border: "1px solid #e5e7eb",
      outline: "none",
      background: "#fff",
      fontSize: 13,
    },
    select: {
      padding: "10px 12px",
      borderRadius: 12,
      border: "1px solid #e5e7eb",
      outline: "none",
      background: "#fff",
      fontSize: 13,
    },
    textarea: {
      width: "100%",
      minHeight: 360,
      padding: 12,
      borderRadius: 14,
      border: "1px solid #e5e7eb",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.5,
      background: "#fff",
      whiteSpace: "pre-wrap",
    },
    btn: (variant = "primary", disabled = false) => {
      const base = {
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid #e5e7eb",
        cursor: disabled ? "not-allowed" : "pointer",
        fontWeight: 800,
        fontSize: 13,
        transition: "transform .05s ease, box-shadow .15s ease, opacity .15s ease",
        opacity: disabled ? 0.55 : 1,
      };
      if (variant === "primary") {
        return {
          ...base,
          border: "1px solid rgba(37,99,235,0.25)",
          background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 55%, #db2777 120%)",
          color: "#fff",
          boxShadow: "0 12px 26px rgba(37,99,235,0.20)",
        };
      }
      if (variant === "danger") {
        return {
          ...base,
          background: "rgba(239,68,68,0.10)",
          border: "1px solid rgba(239,68,68,0.30)",
          color: "#991b1b",
        };
      }
      return {
        ...base,
        background: "rgba(15,23,42,0.03)",
        color: "#0f172a",
      };
    },
    msg: (tone = "neutral") => ({
      padding: 12,
      borderRadius: 14,
      border: "1px solid #e5e7eb",
      background:
        tone === "good"
          ? "rgba(34,197,94,0.10)"
          : tone === "bad"
          ? "rgba(239,68,68,0.08)"
          : tone === "warn"
          ? "rgba(234,179,8,0.12)"
          : "rgba(15,23,42,0.03)",
      color:
        tone === "good"
          ? "#166534"
          : tone === "bad"
          ? "#991b1b"
          : tone === "warn"
          ? "#854d0e"
          : "#0f172a",
      fontSize: 13,
      lineHeight: 1.35,
    }),
    divider: { height: 1, background: "#e5e7eb", margin: "10px 0" },
    small: { fontSize: 12, opacity: 0.75 },
  };

  const isNarrow = typeof window !== "undefined" ? window.innerWidth < 980 : false;

  function Banner() {
    if (!notice && !error && !authStatus) return null;
    return (
      <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
        {authStatus && <div style={UI.msg("neutral")}><b>Estado:</b> {authStatus}</div>}
        {notice && <div style={UI.msg("good")}><b>OK:</b> {notice}</div>}
        {error && <div style={UI.msg("bad")}><b>Error:</b> {error}</div>}
      </div>
    );
  }

  /* =========================
     AUTH SCREEN
  ========================= */
  if (!token) {
    return (
      <div style={UI.page}>
        <div style={UI.shell}>
          <div style={UI.topbar}>
            <div style={UI.brand}>
              <div style={UI.logo} />
              <div>
                <div style={UI.title}>E-Vantis</div>
                <div style={UI.subtitle}>Acceso • Registro • Plan Free</div>
              </div>
            </div>
            <div style={UI.pillRow}>
              <span style={UI.pill("neutral")}>Curriculum embebido</span>
              <span style={UI.pill("neutral")}>API: {API_BASE}</span>
            </div>
          </div>

          <Banner />

          <div style={{ ...UI.card, marginTop: 14, padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 900 }}>Entrar a E-Vantis</h2>
                <div style={{ marginTop: 6, ...UI.small }}>
                  {authMode === "register"
                    ? "Crea tu cuenta y comienza en plan Free."
                    : "Inicia sesión para generar clases y guardar tu progreso."}
                </div>
              </div>
              <div style={UI.pillRow}>
                <button
                  type="button"
                  onClick={() => setAuthMode("login")}
                  style={UI.btn(authMode === "login" ? "primary" : "ghost", false)}
                >
                  Login
                </button>
                <button
                  type="button"
                  onClick={() => setAuthMode("register")}
                  style={UI.btn(authMode === "register" ? "primary" : "ghost", false)}
                >
                  Crear cuenta
                </button>
              </div>
            </div>

            <div style={UI.divider} />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <div style={UI.field}>
                <div style={UI.label}>Email</div>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="tu@email.com"
                  style={UI.input}
                />
              </div>
              <div style={UI.field}>
                <div style={UI.label}>Password</div>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  style={UI.input}
                />
              </div>
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button
                onClick={authMode === "register" ? handleRegister : handleLogin}
                style={UI.btn("primary", false)}
              >
                {authMode === "register" ? "Crear cuenta" : "Iniciar sesión"}
              </button>
              <div style={UI.small}>
                Al continuar aceptas uso académico. No sustituye juicio clínico.
              </div>
            </div>
          </div>

          <div style={{ marginTop: 14, ...UI.small }}>
            E-Vantis — Plataforma académica. Si tienes problemas, prueba recargar y volver a iniciar sesión.
          </div>
        </div>
      </div>
    );
  }

  /* =========================
     APP SHELL (logueado)
  ========================= */
  return (
    <div style={UI.page}>
      <div style={UI.shell}>
        {/* TOPBAR */}
        <div style={UI.topbar}>
          <div style={UI.brand}>
            <div style={UI.logo} />
            <div>
              <div style={UI.title}>E-Vantis</div>
              <div style={UI.subtitle}>Clases • Exámenes • Casos ENARM • Guardadas • Chat</div>
            </div>
          </div>

          <div style={UI.pillRow}>
            <span style={UI.pill("neutral")}>
              Plan: <b>{me?.plan || "—"}</b>
            </span>
            {hasPro ? (
              <span style={UI.pill("good")}>Pro/Premium</span>
            ) : (
              <span style={UI.pill("warn")}>Free</span>
            )}
            <button onClick={handleLogout} style={UI.btn("ghost", false)}>
              Logout
            </button>
          </div>
        </div>

        {/* USAGE */}
        {usage?.modules && (
          <div style={{ ...UI.card, marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <h3 style={UI.sectionTitle}>Uso mensual ({usage.yyyymm})</h3>
                <div style={{ marginTop: 6, ...UI.small }}>
                  lesson {usage.modules.lesson.used}/{usage.modules.lesson.limit} · exam {usage.modules.exam.used}/
                  {usage.modules.exam.limit} · enarm {usage.modules.enarm.used}/{usage.modules.enarm.limit} · gpc{" "}
                  {usage.modules.gpc_summary.used}/{usage.modules.gpc_summary.limit}
                </div>
              </div>
              <div style={UI.pillRow}>
                <span style={UI.pill("neutral")}>API: {API_BASE}</span>
                <span style={UI.pill("neutral")}>Curriculum: embebido</span>
              </div>
            </div>
          </div>
        )}

        <Banner />

        {/* LAYOUT */}
        <div style={isNarrow ? UI.gridMobile : UI.grid}>
          {/* LEFT: Builder */}
          <div style={UI.card}>
            <h3 style={UI.sectionTitle}>Crear contenido</h3>
            <div style={{ marginTop: 6, ...UI.cardHint }}>
              Selecciona <b>Materia → Tema → Subtema</b> y después el <b>Módulo</b>. El alumno no necesita ver IDs.
            </div>

            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              {/* Materia */}
              <div style={UI.field}>
                <div style={UI.label}>Materia</div>
                <select
                  value={subjectId}
                  onChange={(e) => setSubjectId(e.target.value)}
                  style={UI.select}
                >
                  <option value="">— Selecciona —</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {selectedSubject && (
                  <div style={UI.small}>
                    Perfil: <b>{selectedSubject.npm_profile}</b>
                  </div>
                )}
              </div>

              {/* Tema */}
              <div style={UI.field}>
                <div style={UI.label}>Tema</div>
                <select
                  value={topicId}
                  onChange={(e) => setTopicId(e.target.value)}
                  disabled={!subjectId}
                  style={{ ...UI.select, opacity: subjectId ? 1 : 0.6 }}
                >
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

              {/* Subtema */}
              <div style={UI.field}>
                <div style={UI.label}>Subtema</div>
                <select
                  value={subtopicId}
                  onChange={(e) => setSubtopicId(e.target.value)}
                  disabled={!selectedTopic || !(selectedTopic.subtopics?.length > 0)}
                  style={{
                    ...UI.select,
                    opacity: selectedTopic && selectedTopic.subtopics?.length > 0 ? 1 : 0.6,
                  }}
                >
                  <option value="">
                    {selectedTopic?.subtopics?.length > 0 ? "— Selecciona —" : "— (Sin subtemas) —"}
                  </option>
                  {(selectedTopic?.subtopics || []).map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Módulo */}
              <div style={UI.field}>
                <div style={UI.label}>Qué quieres generar</div>
                <select value={module} onChange={(e) => setModule(e.target.value)} style={UI.select}>
                  {moduleOptions.map((m) => (
                    <option key={m} value={m}>
                      {humanLabelModule(m)}
                    </option>
                  ))}
                </select>
                {!hasPro && moduleOptions.includes("gpc_summary") === false && (
                  <div style={UI.small}>Resumen GPC requiere Pro/Premium.</div>
                )}
              </div>

              {/* Profundidad */}
              <div style={UI.field}>
                <div style={UI.label}>Profundidad</div>
                <select value={level} onChange={(e) => setLevel(e.target.value)} style={UI.select}>
                  <option value="auto">Automática</option>
                  <option value="pregrado">Pregrado</option>
                  <option value="internado">Clínica</option>
                </select>
              </div>

              <div style={UI.divider} />

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div style={UI.field}>
                  <div style={UI.label}>Duración (min)</div>
                  <input
                    type="number"
                    value={durationMinutes}
                    onChange={(e) => setDurationMinutes(e.target.value)}
                    min={5}
                    max={120}
                    style={UI.input}
                  />
                </div>

                <div style={UI.field}>
                  <div style={UI.label}>Estilo (solo clases)</div>
                  <select
                    value={style}
                    onChange={(e) => setStyle(e.target.value)}
                    disabled={module !== "lesson"}
                    style={{ ...UI.select, opacity: module === "lesson" ? 1 : 0.6 }}
                  >
                    <option value="magistral">Magistral</option>
                    <option value="high_yield">High-yield</option>
                    <option value="socratico">Socrático</option>
                  </select>
                </div>

                <div style={UI.field}>
                  <div style={UI.label}>Número de preguntas</div>
                  <input
                    type="number"
                    value={numQuestions}
                    onChange={(e) => setNumQuestions(e.target.value)}
                    min={5}
                    max={200}
                    disabled={!(module === "exam" || module === "enarm")}
                    style={{ ...UI.input, opacity: module === "exam" || module === "enarm" ? 1 : 0.6 }}
                  />
                </div>

                <div style={{ ...UI.field, alignContent: "end" }}>
                  <button
                    onClick={() => setAdvancedOpen((v) => !v)}
                    style={UI.btn("ghost", false)}
                  >
                    {advancedOpen ? "Ocultar" : "Mostrar"} opciones avanzadas
                  </button>
                </div>
              </div>

              {advancedOpen && (
                <div style={{ ...UI.msg("neutral"), marginTop: 6 }}>
                  <label style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
                    <input
                      type="checkbox"
                      checked={useGuides}
                      onChange={(e) => setUseGuides(e.target.checked)}
                      disabled={module === "gpc_summary"}
                    />
                    <span style={{ fontSize: 13 }}>Usar guías actualizadas (requerido para Resumen GPC)</span>
                  </label>

                  <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <input type="checkbox" checked={enarmContext} onChange={(e) => setEnarmContext(e.target.checked)} />
                    <span style={{ fontSize: 13 }}>Confirmo modo ENARM</span>
                  </label>
                </div>
              )}

              <button
                onClick={handleGenerate}
                disabled={isGenerating || quotaBlocked}
                style={UI.btn("primary", isGenerating || quotaBlocked)}
              >
                {quotaBlocked ? "Cuota mensual alcanzada" : isGenerating ? "Generando…" : "Generar"}
              </button>

              <div style={UI.small}>
                Se enviará: <b>{selectedSubject?.name || "Materia"}</b> → <b>{selectedTopic?.name || "Tema"}</b> →{" "}
                <b>{humanLabelModule(module)}</b>
              </div>
            </div>
          </div>

          {/* RIGHT: Result + Chat + Saved */}
          <div style={{ display: "grid", gap: 14 }}>
            {/* RESULT */}
            <div ref={resultRef} style={UI.card}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <h3 style={UI.sectionTitle}>Resultado</h3>
                  <div style={{ marginTop: 6, ...UI.small }}>
                    {result?.session_id ? (
                      <>
                        Session:{" "}
                        <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                          {result.session_id}
                        </span>
                      </>
                    ) : (
                      "Aún no hay contenido generado."
                    )}
                  </div>
                </div>

                <div style={UI.pillRow}>
                  <button
                    onClick={handleSaveCurrent}
                    disabled={!result}
                    style={UI.btn("ghost", !result)}
                  >
                    Guardar
                  </button>

                  <button
                    onClick={handleDownloadPDFInstitutional}
                    disabled={!hasPro || !result}
                    style={UI.btn("ghost", !hasPro || !result)}
                  >
                    PDF (Pro/Premium)
                  </button>
                </div>
              </div>

              {result ? (
                <>
                  <div style={UI.divider} />
                  <div style={{ fontSize: 16, fontWeight: 900 }}>{result.title}</div>
                  <div style={{ marginTop: 6, ...UI.small }}>
                    <b>Materia:</b> {result.subject_name} • <b>Tema:</b> {result.topic_name} • <b>Módulo:</b>{" "}
                    {humanLabelModule(result.module)} • <b>Profundidad:</b> {humanLabelLevel(result.level)} •{" "}
                    <b>Duración:</b> {result.duration_minutes} min
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <textarea readOnly value={result.lesson || ""} style={UI.textarea} />
                  </div>

                  {/* CHAT */}
                  <div style={{ ...UI.card, marginTop: 12, padding: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                      <div>
                        <div style={{ fontWeight: 900 }}>Chat académico</div>
                        <div style={UI.small}>Preguntas sobre esta clase (se guarda por sesión).</div>
                      </div>
                      <button
                        onClick={() => setChatOpen((v) => !v)}
                        style={UI.btn("ghost", false)}
                      >
                        {chatOpen ? "Ocultar" : "Abrir"} chat
                      </button>
                    </div>

                    {chatOpen && (
                      <div style={{ marginTop: 10 }}>
                        <div
                          ref={chatBoxRef}
                          style={{
                            border: "1px solid #e5e7eb",
                            borderRadius: 14,
                            padding: 12,
                            minHeight: 160,
                            maxHeight: 280,
                            overflow: "auto",
                            background: "#fff",
                          }}
                        >
                          {chatMessages.length === 0 ? (
                            <div style={UI.small}>No hay mensajes aún. Escribe tu primera duda.</div>
                          ) : (
                            chatMessages.map((m, idx) => (
                              <div key={`${m.created_at || "t"}_${idx}`} style={{ marginBottom: 12 }}>
                                <div style={{ fontSize: 12, opacity: 0.7 }}>
                                  <b>{m.role === "user" ? "Tú" : "E-Vantis"}</b> · {m.created_at}
                                </div>
                                <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.4 }}>
                                  {m.content}
                                </div>
                              </div>
                            ))
                          )}
                        </div>

                        <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "stretch" }}>
                          <textarea
                            value={chatInput}
                            onChange={(e) => setChatInput(e.target.value)}
                            placeholder="Escribe tu duda… (Enter envía, Shift+Enter salto)"
                            rows={2}
                            style={{ ...UI.input, flex: 1, resize: "vertical" }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                if (!chatStatus) handleChatSend();
                              }
                            }}
                            disabled={!!chatStatus}
                          />
                          <button
                            onClick={handleChatSend}
                            disabled={!!chatStatus}
                            style={UI.btn("primary", !!chatStatus)}
                          >
                            Enviar
                          </button>
                        </div>

                        {chatStatus && <div style={{ marginTop: 8, ...UI.small }}>{chatStatus}</div>}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div style={{ marginTop: 10, ...UI.small }}>
                  Genera una clase/examen/caso para ver el contenido aquí.
                </div>
              )}
            </div>

            {/* SAVED */}
            <div style={UI.card}>
              <h3 style={UI.sectionTitle}>Mis clases</h3>
              <div style={{ marginTop: 6, ...UI.small }}>
                Guardadas: <b>{filteredSaved.length}</b> (total: {(Array.isArray(savedLessons) ? savedLessons : []).length})
              </div>

              <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 10 }}>
                <input
                  placeholder="Buscar…"
                  value={searchSaved}
                  onChange={(e) => setSearchSaved(e.target.value)}
                  style={UI.input}
                />

                <select value={filterSavedSubject} onChange={(e) => setFilterSavedSubject(e.target.value)} style={UI.select}>
                  <option value="all">Materia</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>

                <select value={filterSavedModule} onChange={(e) => setFilterSavedModule(e.target.value)} style={UI.select}>
                  <option value="all">Módulo</option>
                  <option value="lesson">Clase</option>
                  <option value="exam">Examen</option>
                  <option value="enarm">Caso ENARM</option>
                  <option value="gpc_summary">Resumen GPC</option>
                </select>

                <select value={filterSavedLevel} onChange={(e) => setFilterSavedLevel(e.target.value)} style={UI.select}>
                  <option value="all">Nivel</option>
                  <option value="auto">Automática</option>
                  <option value="pregrado">Pregrado</option>
                  <option value="internado">Clínica</option>
                </select>
              </div>

              <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                {filteredSaved.length === 0 ? (
                  <div style={UI.small}>No hay clases guardadas con esos filtros.</div>
                ) : (
                  filteredSaved.map((item) => {
                    const active = item.saved_key && item.saved_key === activeSavedKey;
                    return (
                      <div
                        key={item.saved_key || item.session_id}
                        style={{
                          border: active ? "2px solid rgba(37,99,235,0.55)" : "1px solid #e5e7eb",
                          borderRadius: 16,
                          padding: 12,
                          background: "#fff",
                          boxShadow: active ? "0 14px 28px rgba(37,99,235,0.12)" : "none",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 900 }}>{item.title || "Sin título"}</div>
                            <div style={{ marginTop: 6, ...UI.small }}>
                              <b>{item.subject_name}</b> • {item.topic_name} • {humanLabelModule(item.module)} • {humanLabelLevel(item.level)}
                            </div>
                            <div style={{ marginTop: 4, ...UI.small }}>
                              {item.created_at ? `Creado: ${item.created_at}` : ""} {item.session_id ? ` • session: ${item.session_id}` : ""}
                            </div>
                          </div>

                          <div style={{ display: "flex", gap: 8 }}>
                            <button onClick={() => openSaved(item)} style={UI.btn("ghost", false)}>Abrir</button>
                            <button onClick={() => deleteSaved(item.saved_key)} style={UI.btn("danger", false)}>Eliminar</button>
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

        <div style={{ marginTop: 14, ...UI.small }}>
          E-Vantis — UI para alumnos (en vivo). Siguiente: pulir copy, quitar tecnicismos (IDs/token) y agregar onboarding.
        </div>
      </div>
    </div>
  );
}

