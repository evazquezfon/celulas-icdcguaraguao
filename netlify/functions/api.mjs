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
  const { action, ...data } = input || {};

  if (action === "login") {
    if (typeof data.password !== "string" || data.password !== process.env.ADMIN_PASSWORD) return json({ ok: false, error: "Credenciales inválidas" }, { status: 401 });
    const session = await makeSession();
    return json({ ok: true }, { headers: { "set-cookie": `cdo_admin=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800` } });
  }
  if (action === "logout") return json({ ok: true }, { headers: { "set-cookie": "cdo_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" } });
  if (!PUBLIC_ACTIONS.has(action) && !ADMIN_ACTIONS.has(action)) return json({ ok: false, error: "Acción no permitida" }, { status: 400 });
  if (ADMIN_ACTIONS.has(action) && !(await hasAdminSession(request))) return json({ ok: false, error: "No autorizado" }, { status: 401 });

  try { return json(await callAppsScript(action, data)); }
  catch (error) { console.error(error); return json({ ok: false, error: "No se pudo completar la solicitud" }, { status: 502 }); }
};

export const config = { path: "/api" };
