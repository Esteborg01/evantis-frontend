const API_BASE = import.meta.env.VITE_API_BASE;
const API_KEY = import.meta.env.VITE_API_KEY;

console.log("VITE_API_BASE =", API_BASE);
console.log("VITE_API_KEY =", API_KEY ? "OK" : "MISSING");

async function parseError(res) {
  try {
    const data = await res.json();
    if (data && typeof data.detail === "string") return data.detail;
    return JSON.stringify(data);
  } catch {
    try {
      return await res.text();
    } catch {
      return "Error desconocido";
    }
  }
}

export async function teach(payload) {
  if (!API_BASE) throw new Error("Falta VITE_API_BASE en .env");
  if (!API_KEY) throw new Error("Falta VITE_API_KEY en .env");

  const res = await fetch(`${API_BASE}/teach`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY, // se toma del .env
    },
    body: JSON.stringify(payload),
  });

  const cache = res.headers.get("X-Cache");
  const cacheKey = res.headers.get("X-Cache-Key");

  if (!res.ok) {
    const detail = await parseError(res);
    const err = new Error(detail || `HTTP ${res.status}`);
    err.status = res.status;
    err.cache = cache;
    err.cacheKey = cacheKey;
    throw err;
  }

  const data = await res.json();
  return { data, cache, cacheKey };
}

