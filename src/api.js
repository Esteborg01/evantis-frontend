import { useState } from "react";
import { login, teachJWT } from "./api";
const [email, setEmail] = useState("");
const [password, setPassword] = useState("");
const [token, setToken] = useState("");
const [loading, setLoading] = useState(false);
const [result, setResult] = useState(null);

// src/api.js

// Base URL desde Render / Vite env
const API_BASE = (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");

// Login OAuth2 password flow (form-urlencoded: username + password)
export async function login(email, password) {
  if (!API_BASE) throw new Error("VITE_API_BASE no está configurado");

  const form = new URLSearchParams();
  form.set("username", email);      // email viaja como username
  form.set("password", password);

  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(err || `Error en login (${res.status})`);
  }

  return await res.json(); // { access_token, token_type, plan }
}

export async function teachJWT(token, payload) {
  const res = await fetch(`${API_BASE}/teach/jwt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || "Error en teach/jwt");
  }

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

