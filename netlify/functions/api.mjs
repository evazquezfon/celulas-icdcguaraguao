const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const PUBLIC_ACTIONS = new Set(["getConfig", "getSpots", "register", "waitlist"]);
const ADMIN_ACTIONS = new Set(["getFullConfig", "getRegistrations", "saveConfig"]);

function json(body, init = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });
}

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function sign(value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Buffer.from(signature).toString("base64url");
}

async function makeSession() {
  const payload = toBase64Url(JSON.stringify({ admin: true, exp: Date.now() + 1000 * 60 * 60 * 8 }));
  return `${payload}.${await sign(payload)}`;
}

async function hasAdminSession(request) {
  const token = (request.headers.get("cookie") || "").match(/(?:^|;\s*)cdo_admin=([^;]+)/)?.[1];
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || signature !== await sign(payload)) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now(); } catch { return false; }
}

async function callAppsScript(action, data) {
  const response = await fetch(process.env.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...data, internalKey: process.env.APPS_SCRIPT_SHARED_SECRET })
  });
  if (!response.ok) throw new Error(`Apps Script respondió ${response.status}`);
  return response.json();
}

export default async (request) => {
  if (request.method !== "POST") return json({ ok: false, error: "Método no permitido" }, { status: 405 });
  if (!process.env.APPS_SCRIPT_URL || !process.env.APPS_SCRIPT_SHARED_SECRET || !process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) {
    return json({ ok: false, error: "Servicio no configurado" }, { status: 500 });
  }
  let input;
  try { input = await request.json(); } catch { return json({ ok: false, error: "JSON inválido" }, { status: 400 }); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return json({ ok: false, error: "Solicitud inválida" }, { status: 400 });
  const { action, ...data } = input;

  if (action === "login") {
    if (typeof data.password !== "string" || data.password !== process.env.ADMIN_PASSWORD) return json({ ok: false, error: "Credenciales inválidas" }, { status: 401 });
    const session = await makeSession();
    return json({ ok: true }, { headers: { "set-cookie": `cdo_admin=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800` } });
  }
  if (action === "logout") return json({ ok: true }, { headers: { "set-cookie": "cdo_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" } });
  if (!PUBLIC_ACTIONS.has(action) && !ADMIN_ACTIONS.has(action)) return json({ ok: false, error: "Acción no permitida" }, { status: 400 });
  if (ADMIN_ACTIONS.has(action) && !(await hasAdminSession(request))) return json({ ok: false, error: "No autorizado" }, { status: 401 });

  let registrationSent = false;
  try {
    if (action === "register") {
      const companions = data.companions === undefined ? [] : data.companions;
      if (!Array.isArray(companions) || companions.length > 20 || companions.some(name => typeof name !== "string" || !name.trim() || name.trim().length > 200)) {
        return json({ ok: false, error: "Indica el nombre completo de cada acompañante." }, { status: 400 });
      }
      data.companions = companions.map(name => name.trim());
      const requested = 1 + data.companions.length;
      const availability = await callAppsScript("getSpots", {});
      const spot = availability.ok && availability.spots?.[data.placeId];
      if (!spot) return json({ ok: false, error: "No se pudo comprobar la disponibilidad. Intenta de nuevo." }, { status: 502 });
      const available = typeof spot.available === "number" ? Math.max(0, spot.available)
        : typeof spot.limit === "number" && spot.limit > 0 && typeof spot.used === "number" ? Math.max(0, spot.limit - spot.used) : null;
      if (available !== null && requested > available) {
        return json({ ok: false, full: true, requested, available,
          error: `Intentas registrar ${requested} participantes y quedan ${available} cupos. El grupo debe registrarse completo.` });
      }
      // This preflight improves feedback; Apps Script must recheck under its
      // spreadsheet lock and write the entire group in one operation.
    }
    registrationSent = action === "register";
    const result = await callAppsScript(action, data);
    if (registrationSent && result.ok && result.registeredCount !== 1 + data.companions.length) {
      return json({ ok: false, uncertain: true, error: "El servidor no confirmó el total del grupo. Comprueba la inscripción con la administración antes de repetirla." }, { status: 502 });
    }
    if (registrationSent && !result.ok && !result.full) result.uncertain = true;
    return json(result);
  }
  catch {
    console.error("La solicitud a Apps Script no pudo completarse");
    return json({ ok: false, uncertain: registrationSent, error: registrationSent
      ? "No se pudo confirmar la escritura. Comprueba la inscripción con la administración antes de repetirla."
      : "No se pudo completar la solicitud" }, { status: 502 });
  }
};

export const config = { path: "/api" };
