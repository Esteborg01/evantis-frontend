import { useState } from "react";
import { login, teachJWT } from "./api";
const [email, setEmail] = useState("");
const [password, setPassword] = useState("");
const [token, setToken] = useState("");
const [loading, setLoading] = useState(false);
const [result, setResult] = useState(null);


const API_BASE = "http://127.0.0.1:8000";

export async function login(email, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || "Error en login");
  }

  return await res.json();
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

