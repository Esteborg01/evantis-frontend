import { useState } from "react";
import { login, teachJWT } from "./api";
const [email, setEmail] = useState("");
const [password, setPassword] = useState("");
const [token, setToken] = useState("");
const [loading, setLoading] = useState(false);
const [result, setResult] = useState(null);

// src/api.js
const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";
const API_KEY  = import.meta.env.VITE_API_KEY  || "";

// helper para headers estándar
function withAuthHeaders(token, extra = {}) {
  const h = { ...extra };
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (API_KEY) h["X-API-Key"] = API_KEY;
  return h;
}

export async function login(email, password) {
  // FastAPI OAuth2PasswordBearer espera form-urlencoded: username/password
  const body = new URLSearchParams();
  body.set("username", email);
  body.set("password", password);

  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) throw new Error((await res.text()) || "Error en login");
  return await res.json();
}

export async function teachJWT(token, payload) {
  const res = await fetch(`${API_BASE}/teach/curriculum`, {
    method: "POST",
    headers: withAuthHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error((await res.text()) || "Error en teach/curriculum");
  return await res.json();
}

async function handleLogin() {
  try {
    setLoading(true);
    const data = await login(email, password);
    setToken(data.access_token);
    alert("Login exitoso");
  } catch (err) {
    alert("Error login: " + err.message);
  } finally {
    setLoading(false);
  }
}

async function handleLogin() {
  try {
    setLoading(true);
    const data = await login(email, password);
    setToken(data.access_token);
    alert("Login exitoso");
  } catch (err) {
    alert("Error login: " + err.message);
  } finally {
    setLoading(false);
  }
}

async function handleTeach() {
  try {
    setLoading(true);

    const payload = {
      session_id: "clase-jwt-001",
      topic: "Betabloqueadores: mecanismo de acción y usos clínicos",
      mode: "academico",
      subject: "auto",
      level: "auto",
      duration_minutes: 20,
      style: "magistral",
    };

    const data = await teachJWT(token, payload);
    setResult(data);
  } catch (err) {
    alert("Error teach: " + err.message);
  } finally {
    setLoading(false);
  }
}

<input
  placeholder="Email"
  value={email}
  onChange={(e) => setEmail(e.target.value)}
/>

<input
  type="password"
  placeholder="Password"
  value={password}
  onChange={(e) => setPassword(e.target.value)}
/>

<button onClick={handleLogin}>
  Login
</button>

<button onClick={handleTeach} disabled={!token}>
  Ejecutar Teach JWT
</button>

{loading && <div>Procesando solicitud...</div>}

{result && (
  <pre style={{ whiteSpace: "pre-wrap" }}>
    {JSON.stringify(result, null, 2)}
  </pre>
)}

