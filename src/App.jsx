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
     GUARD DE ACCESO (FASE 6) — CORRECTO
     Debe ir DESPUÉS de hooks (useState/useEffect), nunca dentro de helpers.
  ========================= */
  if (!token) {
    return (
      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          padding: 16,
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
        }}
      >
        <header style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>E-Vantis</div>
          <div style={{ opacity: 0.7, fontSize: 13 }}>Acceso requerido</div>
        </header>

        {(notice || error || authStatus) && (
          <div style={{ marginBottom: 16 }}>
            {authStatus && (
              <div style={{ padding: 10, border: "1px solid #ddd", borderRadius: 8, marginBottom: 8 }}>
                <b>Estado:</b> {authStatus}
              </div>
            )}
            {notice && (
              <div style={{ padding: 10, border: "1px solid #ddd", borderRadius: 8, marginBottom: 8 }}>
                <b>OK:</b> {notice}
              </div>
            )}
            {error && (
              <div style={{ padding: 10, border: "1px solid #f2b8b5", background: "#fff5f5", borderRadius: 8 }}>
                <b>Error:</b> {error}
              </div>
            )}
          </div>
        )}

        <section style={{ border: "1px solid #e6e6e6", borderRadius: 12, padding: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>1) Acceso</h2>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, marginTop: 12 }}>
            <input
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
            />

            <input
              placeholder="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
            />

            <button
              onClick={authMode === "register" ? handleRegister : handleLogin}
              style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer", fontWeight: 700 }}
            >
              {authMode === "register" ? "Crear cuenta" : "Login"}
            </button>
          </div>
          <div style={{ marginTop: 12, fontSize: 14, opacity: 0.85 }}>
            {authMode === "login" ? (
              <span>
                ¿No tienes cuenta?{" "}
                <button
                  type="button"
                  onClick={() => setAuthMode("register")}
                  style={{ background: "transparent", border: "none", color: "#2563eb", cursor: "pointer", padding: 0, fontWeight: 700 }}
                >
                  Crear cuenta
                </button>
              </span>
            ) : (
              <span>
                ¿Ya tienes cuenta?{" "}
                <button
                  type="button"
                  onClick={() => setAuthMode("login")}
                  style={{ background: "transparent", border: "none", color: "#2563eb", cursor: "pointer", padding: 0, fontWeight: 700 }}
                >
                  Iniciar sesión
                </button>
              </span>
            )}
          </div>
        </section>

        <footer style={{ marginTop: 18, opacity: 0.6, fontSize: 12 }}>
          E-Vantis — Inicia sesión para acceder al contenido.
        </footer>
      </div>
    );
  }
   return (
    <div
      style={{
        maxWidth: 1100,
        margin: "0 auto",
        padding: 16,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>E-Vantis</div>
          <div style={{ opacity: 0.7, fontSize: 13 }}>
            Panel operativo — Materia → Tema → Módulo • Guardadas • Chat • PDF Pro/Premium
          </div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
            Plan actual: <b>{me?.plan || "—"}</b>{" "}
            {!hasPro && <span style={{ opacity: 0.75 }}>•</span>}
          </div>
          {usage?.modules && (
            <div style={{ marginTop: 8, fontSize: 13, opacity: 0.85 }}>
              <strong>Uso mensual ({usage.yyyymm})</strong>:{" "}
              lesson {usage.modules.lesson.used}/{usage.modules.lesson.limit} ·{" "}
              exam {usage.modules.exam.used}/{usage.modules.exam.limit} ·{" "}
              enarm {usage.modules.enarm.used}/{usage.modules.enarm.limit} ·{" "}
              gpc {usage.modules.gpc_summary.used}/{usage.modules.gpc_summary.limit}
            </div>
          )}
        </div>

        <div style={{ opacity: 0.75, fontSize: 12, textAlign: "right" }}>
          <div>API: {API_BASE}</div>
          <div>Curriculum: embebido</div>
        </div>
      </header>

      {(notice || error || authStatus) && (
        <div style={{ marginBottom: 16 }}>
          {authStatus && (
            <div style={{ padding: 10, border: "1px solid #ddd", borderRadius: 8, marginBottom: 8 }}>
              <b>Estado:</b> {authStatus}
            </div>
          )}
          {notice && (
            <div style={{ padding: 10, border: "1px solid #ddd", borderRadius: 8, marginBottom: 8 }}>
              <b>OK:</b> {notice}
            </div>
          )}
          {error && (
            <div style={{ padding: 10, border: "1px solid #f2b8b5", background: "#fff5f5", borderRadius: 8 }}>
              <b>Error:</b> {error}
            </div>
          )}
        </div>
      )}

      {/* 1) Acceso */}
      <section style={{ border: "1px solid #e6e6e6", borderRadius: 12, padding: 14, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>1) Acceso</h2>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            {token ? "Token activo" : "Sin sesión"}
            {me?.plan ? ` • Plan: ${me.plan}` : ""}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, marginTop: 12 }}>
          <input
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
            disabled={!!token}
          />

          <input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
            disabled={!!token}
          />

          <button
            onClick={handleLogout}
            style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer", fontWeight: 700 }}
          >
            Logout
          </button>
        </div>

        {token && (
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75, wordBreak: "break-all" }}>
            <b>Bearer:</b> {token.slice(0, 30)}…{token.slice(-18)}
          </div>
        )}
      </section>

      {/* 2) Crear contenido */}
      <section style={{ border: "1px solid #e6e6e6", borderRadius: 12, padding: 14, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>2) Crear contenido</h2>

        {!hasPro && (
          <div style={{ marginTop: 10, padding: 10, border: "1px dashed #ddd", borderRadius: 10, fontSize: 12, opacity: 0.85 }}>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 10, marginTop: 12 }}>
          {/* Materia */}
          <div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Materia</div>
            <select
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
            >
              <option value="">— Selecciona —</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {selectedSubject && (
              <div style={{ fontSize: 11, marginTop: 6, opacity: 0.7 }}>
                Perfil: <b>{selectedSubject.npm_profile}</b> • ID: {selectedSubject.id}
              </div>
            )}
          </div>

          {/* Tema */}
          <div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Tema</div>
            <select
              value={topicId}
              onChange={(e) => setTopicId(e.target.value)}
              disabled={!subjectId}
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
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
          
          {/* Subtema */}
          <div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
              Subtema
            </div>

            <select
              value={subtopicId}
              onChange={(e) => setSubtopicId(e.target.value)}
              disabled={!selectedTopic || !(selectedTopic.subtopics?.length > 0)}
              style={{
                width: "100%",
                padding: 10,
                borderRadius: 8,
                border: "1px solid #ddd",
              }}
            >
              <option value="">
                {selectedTopic?.subtopics?.length > 0
                  ? "— Selecciona —"
                  : "— (Sin subtemas) —"}
              </option>

              {(selectedTopic?.subtopics || []).map((st) => (
                <option key={st.id} value={st.id}>
                  {st.name}
                </option>
              ))}
            </select>

            {subtopicId && (
              <div style={{ fontSize: 11, marginTop: 6, opacity: 0.7 }}>
                ID subtema:{" "}
                <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                  {subtopicId}
                </span>
              </div>
            )}
          </div>

            {selectedTopic && (
              <div style={{ fontSize: 11, marginTop: 6, opacity: 0.7 }}>
                ID:{" "}
                <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                  {selectedTopic.id}
                </span>
              </div>
            )}
          </div>

          {/* Módulo */}
          <div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Qué quieres generar</div>
            <select
              value={module}
              onChange={(e) => setModule(e.target.value)}
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
            >
              {moduleOptions.map((m) => (
                <option key={m} value={m}>
                  {humanLabelModule(m)}
                </option>
              ))}
            </select>

            {!hasPro && npmProfile === "clinicas" && (
              <div style={{ fontSize: 11, marginTop: 6, opacity: 0.7 }}>
              </div>
            )}
          </div>

          {/* Profundidad */}
          <div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Profundidad</div>
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
            >
              <option value="auto">Automática</option>
              <option value="pregrado">Pregrado</option>
              <option value="internado">Clínica</option>
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginTop: 10 }}>
          {/* Duración */}
          <div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Duración (min)</div>
            <input
              type="number"
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(e.target.value)}
              min={5}
              max={120}
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
            />
          </div>

          {/* Style */}
          <div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Estilo</div>
            <select
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              disabled={module !== "lesson"}
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
            >
              <option value="magistral">Magistral</option>
              <option value="high_yield">High-yield</option>
              <option value="socratico">Socrático</option>
            </select>
          </div>

          {/* Preguntas */}
          <div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Número de preguntas</div>
            <input
              type="number"
              value={numQuestions}
              onChange={(e) => setNumQuestions(e.target.value)}
              min={5}
              max={200}
              disabled={!(module === "exam" || module === "enarm")}
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
            />
          </div>

          {/* Avanzadas */}
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button
              onClick={() => setAdvancedOpen((v) => !v)}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
            >
              {advancedOpen ? "Ocultar" : "Mostrar"} opciones avanzadas
            </button>
          </div>
        </div>

        {advancedOpen && (
          <div style={{ marginTop: 10, padding: 12, border: "1px dashed #ddd", borderRadius: 10 }}>
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

        <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={handleGenerate}
            disabled={isGenerating || quotaBlocked}
          >
            {quotaBlocked ? "Cuota mensual alcanzada" : isGenerating ? "Generando…" : "Generar"}
          </button>

          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Enviarás: <b>Materia</b> ({subjectId || "—"}) • <b>Tema</b> ({topicId || "—"}) • <b>Módulo</b> ({module})
          </div>
        </div>
      </section>

      {/* 3) Resultado */}
      <section ref={resultRef} style={{ border: "1px solid #e6e6e6", borderRadius: 12, padding: 14, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>3) Resultado</h2>

        {!result ? (
          <div style={{ marginTop: 10, opacity: 0.7 }}>Aún no hay contenido generado o cargado.</div>
        ) : (
          <>
            <div style={{ marginTop: 10, padding: 12, border: "1px solid #eee", borderRadius: 10 }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{result.title}</div>

              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
                <b>Materia:</b> {result.subject_name} • <b>Tema:</b> {result.topic_name} •{" "}
                <b>Módulo:</b> {humanLabelModule(result.module)} • <b>Profundidad:</b> {humanLabelLevel(result.level)} •{" "}
                <b>Duración:</b> {result.duration_minutes} min
              </div>

              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
                <b>Perfil:</b> {result.npm_profile || "—"} • <b>Session:</b>{" "}
                <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{result.session_id}</span>
              </div>

              <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  onClick={handleSaveCurrent}
                  style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer", fontWeight: 700 }}
                >
                  Guardar en Mis clases
                </button>

                <button
                  onClick={handleDownloadPDFInstitutional}
                  disabled={!hasPro}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid #ddd",
                    cursor: hasPro ? "pointer" : "not-allowed",
                    fontWeight: 700,
                    opacity: hasPro ? 1 : 0.6,
                  }}
                >
                  Descargar PDF (Pro/Premium)
                </button>
              </div>

              {!hasPro && (
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
                </div>
              )}
            </div>

            <div style={{ marginTop: 12 }}>
              <textarea
                readOnly
                value={result.lesson || ""}
                style={{
                  width: "100%",
                  minHeight: 340,
                  padding: 12,
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 12,
                  lineHeight: 1.4,
                  whiteSpace: "pre-wrap",
                }}
              />

              {/* CHAT */}
              <div style={{ marginTop: 12, padding: 12, border: "1px solid #eee", borderRadius: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>Chat académico (sobre esta clase)</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                      Session:{" "}
                      <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                        {result.session_id}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={() => setChatOpen((v) => !v)}
                    style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
                  >
                    {chatOpen ? "Ocultar chat" : "Abrir chat"}
                  </button>
                </div>

                {chatOpen && (
                  <div style={{ marginTop: 10 }}>
                    <div
                      ref={chatBoxRef}
                      style={{
                        border: "1px solid #ddd",
                        borderRadius: 10,
                        padding: 10,
                        minHeight: 160,
                        maxHeight: 260,
                        overflow: "auto",
                        background: "#fff",
                      }}
                    >
                      {chatMessages.length === 0 ? (
                        <div style={{ opacity: 0.7, fontSize: 12 }}>
                          No hay mensajes aún. Escribe tu primera duda sobre esta clase.
                        </div>
                      ) : (
                        chatMessages.map((m, idx) => (
                          <div key={`${m.created_at || "t"}_${idx}`} style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: 12, opacity: 0.7 }}>
                              <b>{m.role === "user" ? "Tú" : "E-Vantis"}</b> · {m.created_at}
                            </div>
                            <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{m.content}</div>
                          </div>
                        ))
                      )}
                    </div>

                    <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                      <textarea
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        placeholder="Escribe tu duda sobre esta clase…"
                        rows={2}
                        style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid #ddd", resize: "vertical" }}
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
                        style={{
                          padding: "10px 14px",
                          borderRadius: 8,
                          border: "1px solid #ddd",
                          cursor: chatStatus ? "not-allowed" : "pointer",
                          fontWeight: 700,
                          opacity: chatStatus ? 0.6 : 1,
                        }}
                      >
                        Enviar
                      </button>
                    </div>

                    {chatStatus && <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>{chatStatus}</div>}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {/* 4) Mis clases */}
      <section style={{ border: "1px solid #e6e6e6", borderRadius: 12, padding: 14 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>4) Mis clases</h2>

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 10, marginTop: 12 }}>
          <input
            placeholder="Buscar por título/tema/materia…"
            value={searchSaved}
            onChange={(e) => setSearchSaved(e.target.value)}
            style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
          />

          <select
            value={filterSavedSubject}
            onChange={(e) => setFilterSavedSubject(e.target.value)}
            style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
          >
            <option value="all">Todas las materias</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <select
            value={filterSavedModule}
            onChange={(e) => setFilterSavedModule(e.target.value)}
            style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
          >
            <option value="all">Todos los módulos</option>
            <option value="lesson">Clase</option>
            <option value="exam">Examen</option>
            <option value="enarm">Caso ENARM</option>
            <option value="gpc_summary">Resumen GPC</option>
          </select>

          <select
            value={filterSavedLevel}
            onChange={(e) => setFilterSavedLevel(e.target.value)}
            style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
          >
            <option value="all">Todas las profundidades</option>
            <option value="auto">Automática</option>
            <option value="pregrado">Pregrado</option>
            <option value="internado">Clínica</option>
          </select>
        </div>

        <div style={{ marginTop: 12, opacity: 0.7, fontSize: 12 }}>
          Guardadas: <b>{filteredSaved.length}</b> (total: {(Array.isArray(savedLessons) ? savedLessons : []).length})
        </div>

        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
          {filteredSaved.length === 0 ? (
            <div style={{ opacity: 0.7 }}>No hay clases guardadas con esos filtros.</div>
          ) : (
            filteredSaved.map((item) => {
              const active = item.saved_key && item.saved_key === activeSavedKey;

              return (
                <div
                  key={item.saved_key || item.session_id}
                  style={{
                    border: active ? "2px solid #444" : "1px solid #ddd",
                    borderRadius: 12,
                    padding: 12,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    alignItems: "flex-start",
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700 }}>{item.title || "Sin título"}</div>

                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                      <b>Materia:</b> {item.subject_name} • <b>Tema:</b> {item.topic_name} •{" "}
                      <b>Módulo:</b> {humanLabelModule(item.module)} • <b>Profundidad:</b> {humanLabelLevel(item.level)} •{" "}
                      <b>Duración:</b> {item.duration_minutes} min
                    </div>

                    <div style={{ fontSize: 11, opacity: 0.65, marginTop: 4 }}>
                      {item.created_at ? `Creado: ${item.created_at}` : ""} {item.session_id ? ` • session: ${item.session_id}` : ""}
                    </div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 160 }}>
                    <button
                      onClick={() => openSaved(item)}
                      style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer", fontWeight: 700 }}
                    >
                      Abrir
                    </button>

                    <button
                      onClick={() => deleteSaved(item.saved_key)}
                      style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
                    >
                      Eliminar
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      <footer style={{ marginTop: 18, opacity: 0.6, fontSize: 12 }}>
        E-Vantis — UI operativa local.
      </footer>
    </div>
  );
}
