/**
 * Spartan Ops phone alerts (version 1)
 *
 * Sends a notification to every team phone that turned alerts on in Spartan Ops when a website order comes in.
 * It runs on the owner's Google account (spartanbiolabs.info@gmail.com), so it can read the orders and send
 * through Firebase Cloud Messaging for the spartan-ops project. Nothing is stored here.
 *
 * Set up (once):
 *   1. script.google.com → New project → name it "Spartan Ops Alerts". Paste this whole file over Code.gs.
 *   2. Project Settings (gear) → tick "Show appsscript.json manifest file in editor". Open appsscript.json and
 *      replace it with the manifest shown in Admin → Settings → Phone alerts.
 *   3. Pick "setup" in the function menu at the top → Run → allow access. (This also adds a 5-minute safety check.)
 *   4. Deploy → New deployment → type: Web app → Execute as: Me → Who has access: Anyone → Deploy.
 *      Copy the Web app URL into Admin → Settings → Phone alerts and Save.
 * After changing this file later: Deploy → Manage deployments → ✏ → Version: New version → Deploy.
 *
 * Why it's safe to leave open to "Anyone": the only thing a caller can do is say "order SB-… just came in".
 * The script then checks that order really exists in Firestore, came from the website in the last few hours and
 * hasn't been announced yet. A test can only go to a phone that is already registered for alerts.
 */
const PROJECT = "spartan-ops";
const OWNER = "spartanbiolabs.info@gmail.com";
const VERSION = 1;
const FS = "https://firestore.googleapis.com/v1/projects/" + PROJECT + "/databases/(default)/documents";
const MAX_AGE_H = 6;                                   // only announce orders newer than this

function doGet() { return out({ ok: true, app: "Spartan Ops alerts", version: VERSION }); }
function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || "{}"); } catch (err) { return out({ ok: false, error: "Bad request" }); }
  try {
    if (body.ping) return out({ ok: true, version: VERSION });
    if (body.order) return out(announceOrder(String(body.order)));
    if (body.test) return out(sendTest(String(body.test)));
    return out({ ok: false, error: "Nothing to do" });
  } catch (err) { return out({ ok: false, error: String(err && err.message || err) }); }
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// ---- run once from the editor: authorizes the script and adds the 5-minute safety check
function setup() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "checkRecent").forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("checkRecent").timeBased().everyMinutes(5).create();
  const n = devices().length;
  Logger.log("Ready. Phones with alerts on: " + n + ". Now deploy it as a Web app (see the top of this file).");
}
// safety net: anything the store's ping missed (bad signal, closed page) is announced within 5 minutes
function checkRecent() {
  const since = new Date(Date.now() - MAX_AGE_H * 3600e3).toISOString();
  const rows = query("orders", { fieldFilter: { field: { fieldPath: "source" }, op: "EQUAL", value: { stringValue: "web" } } });
  rows.filter(o => String(o.created || "") >= since).forEach(o => { try { announceOrder(o._id); } catch (e) { Logger.log(e); } });
}

// ---- a website order: check it, claim it (once), send it
function announceOrder(id) {
  if (!/^SB-[0-9]{6}-[A-Z0-9]{4}$/.test(id)) return { ok: false, error: "Not an order number" };
  const o = getDoc("orders/" + id);
  if (!o) return { ok: false, error: "No such order" };
  if (o.source !== "web") return { ok: true, skipped: "not a website order" };
  if (!o.created || Date.now() - new Date(o.created).getTime() > MAX_AGE_H * 3600e3) return { ok: true, skipped: "too old" };
  if (!claim("pushLog/" + id, { order: id, at: new Date().toISOString() })) return { ok: true, skipped: "already announced" };
  const money = "$" + Number(o.total || 0).toFixed(2).replace(/\.00$/, "");
  const sent = sendAll({ title: "New website order", body: [id, money, o.pay].filter(Boolean).join(" · "), url: "./ops/#orders", tag: "order-" + id });
  return { ok: true, sent: sent };
}
function sendTest(token) {
  const d = devices().find(x => x.token === token);
  if (!d) return { ok: false, error: "This phone isn't registered for alerts yet. Turn alerts off and on again." };
  const r = push(d, { title: "Spartan Ops alerts are on", body: "New website orders will show up here.", url: "./ops/#orders", tag: "test" });
  return r === "ok" ? { ok: true, sent: 1 } : { ok: false, error: "Couldn't reach this phone (" + r + ")." };
}

// ---- who gets it: every registered phone whose person is still the owner or on the team
function devices() {
  const team = {}; list("team").forEach(t => { team[t._id] = t.role; });
  return list("pushTokens").filter(d => d.token && d.email && (String(d.email).toLowerCase() === OWNER || team[String(d.email).toLowerCase()]));
}
function sendAll(msg) {
  let n = 0;
  devices().forEach(d => { if (push(d, msg) === "ok") n++; });
  return n;
}
function push(d, msg) {
  const r = UrlFetchApp.fetch("https://fcm.googleapis.com/v1/projects/" + PROJECT + "/messages:send", {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken(), "x-goog-user-project": PROJECT },
    payload: JSON.stringify({ message: { token: d.token,
      webpush: { headers: { Urgency: "high", TTL: "86400" }, data: { title: msg.title, body: msg.body, url: msg.url, tag: msg.tag } } } })
  });
  const code = r.getResponseCode();
  if (code === 200) return "ok";
  const txt = r.getContentText();
  // the phone uninstalled the app or turned alerts off: forget it
  if (code === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/.test(txt)) { try { del("pushTokens/" + encodeURIComponent(d._id)); } catch (e) {} return "gone"; }
  Logger.log("FCM " + code + " " + txt);
  return "error " + code;
}

// ---- Firestore over REST, as the owner (the security rules don't apply to the owner's own account)
function api(method, url, payload) {
  const opt = { method: method, muteHttpExceptions: true, headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken(), "x-goog-user-project": PROJECT } };
  if (payload) { opt.contentType = "application/json"; opt.payload = JSON.stringify(payload); }
  return UrlFetchApp.fetch(url, opt);
}
function getDoc(path) {
  const r = api("get", FS + "/" + path);
  if (r.getResponseCode() === 404) return null;
  if (r.getResponseCode() !== 200) throw new Error("Firestore " + r.getResponseCode() + ": " + r.getContentText().slice(0, 200));
  return plain(JSON.parse(r.getContentText()));
}
function list(col) {
  let rows = [], tok = "";
  do {
    const r = api("get", FS + "/" + col + "?pageSize=300" + (tok ? "&pageToken=" + encodeURIComponent(tok) : ""));
    if (r.getResponseCode() !== 200) throw new Error("Firestore " + r.getResponseCode() + ": " + r.getContentText().slice(0, 200));
    const j = JSON.parse(r.getContentText());
    rows = rows.concat((j.documents || []).map(plain)); tok = j.nextPageToken || "";
  } while (tok);
  return rows;
}
function query(col, where) {
  const r = api("post", FS + ":runQuery", { structuredQuery: { from: [{ collectionId: col }], where: where } });
  if (r.getResponseCode() !== 200) throw new Error("Firestore " + r.getResponseCode() + ": " + r.getContentText().slice(0, 200));
  return JSON.parse(r.getContentText()).filter(x => x.document).map(x => plain(x.document));
}
// create only if it doesn't exist yet (so two pings at once can't both announce the same order)
function claim(path, data) {
  const i = path.lastIndexOf("/"), col = path.slice(0, i), id = path.slice(i + 1);
  const fields = {}; Object.keys(data).forEach(k => { fields[k] = { stringValue: String(data[k]) }; });
  const r = api("post", FS + "/" + col + "?documentId=" + encodeURIComponent(id), { fields: fields });
  return r.getResponseCode() === 200;
}
function del(path) { api("delete", FS + "/" + path); }
function plain(d) {
  const o = { _id: decodeURIComponent(String(d.name || "").split("/").pop()) };
  Object.keys(d.fields || {}).forEach(k => { o[k] = val(d.fields[k]); });
  return o;
}
function val(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(val);
  if ("mapValue" in v) { const o = {}; Object.keys(v.mapValue.fields || {}).forEach(k => { o[k] = val(v.mapValue.fields[k]); }); return o; }
  return null;
}
