import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";

type Bindings = { DB: D1Database };

const app = new Hono<{ Bindings: Bindings }>();

// Alphabet without ambiguous characters (0, o, 1, l, i) so the id is easy to read aloud.
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
// Auto-generated ids use a smaller no-ambiguous-chars alphabet (below); this regex
// is the broader validity check, since a client-supplied sessionId (from ?sid= or
// manual entry) can be any lowercase alphanumeric string (e.g. "user123").
const SESSION_ID_RE = /^[a-z0-9]{1,32}$/;

function randomIndex(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

function makeSessionId(): string {
  const len = 6 + randomIndex(3); // 6, 7 or 8
  let id = "";
  for (let i = 0; i < len; i++) {
    id += ID_ALPHABET[randomIndex(ID_ALPHABET.length)];
  }
  return id;
}

// ponytail: in-memory counter per isolate, not a global limit across edge locations.
// Upgrade to a Durable Object or KV if real abuse justifies it.
const rateLimitBuckets = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 10;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (rateLimitBuckets.get(ip) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  recent.push(now);
  rateLimitBuckets.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

type Option = {
  value: string;
  customUrl?: string;
  customLabel?: string;
  customUrl2?: string;
  customLabel2?: string;
};

// Accepts pre-migration snapshots/rows where an option was still a bare string.
function normalizeOption(o: unknown): Option {
  if (typeof o === "string") return { value: o };
  return o as Option;
}

async function getConfig(db: D1Database): Promise<{ title: string; options: Option[] }> {
  const row = await db
    .prepare("SELECT title, options FROM config WHERE id = 1")
    .first<{ title: string; options: string }>();
  return {
    title: row?.title ?? "Live Raffle",
    options: row ? JSON.parse(row.options).map(normalizeOption) : [],
  };
}

app.get("/api/config", async (c) => {
  const config = await getConfig(c.env.DB);
  return c.json(config);
});

const ADMIN_COOKIE = "admin_auth";

async function getAdminPassword(db: D1Database): Promise<string> {
  const row = await db
    .prepare("SELECT admin_password FROM config WHERE id = 1")
    .first<{ admin_password: string }>();
  return row?.admin_password ?? "12345";
}

async function hashPassword(password: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function isAdminAuthed(c: Context<{ Bindings: Bindings }>): Promise<boolean> {
  const cookie = getCookie(c, ADMIN_COOKIE);
  if (!cookie) return false;
  const expected = await hashPassword(await getAdminPassword(c.env.DB));
  return cookie === expected;
}

async function setAdminCookie(c: Context<{ Bindings: Bindings }>, password: string): Promise<void> {
  setCookie(c, ADMIN_COOKIE, await hashPassword(password), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

function loginPage(error?: string): string {
  const body = `
    <h1>SunGodAK login</h1>
    ${error ? `<p style="color:#ff5c6c;">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/godak/login" style="max-width:280px;">
      <label class="muted" for="passwordInput">Password</label><br/>
      <input id="passwordInput" type="password" name="password" autofocus style="width:100%; margin:.4rem 0 1rem;" /><br/>
      <button type="submit">Enter</button>
    </form>`;
  return pageShell("Admin login", body);
}

app.post("/godak/login", async (c) => {
  const form = await c.req.formData();
  const password = String(form.get("password") ?? "");
  const current = await getAdminPassword(c.env.DB);
  if (password !== current) {
    return c.html(loginPage("Incorrect password."), 401);
  }
  await setAdminCookie(c, current);
  return c.redirect("/godak");
});

app.post("/godak/change-password", async (c) => {
  if (!(await isAdminAuthed(c))) return c.redirect("/godak");
  const form = await c.req.formData();
  const newPassword = String(form.get("newPassword") ?? "").trim();
  if (!newPassword) return c.text("Password cannot be empty.", 400);
  await c.env.DB.prepare("UPDATE config SET admin_password = ? WHERE id = 1")
    .bind(newPassword)
    .run();
  await setAdminCookie(c, newPassword);
  return c.redirect("/godak");
});

app.post("/api/spin", async (c) => {
  const ip =
    c.req.header("CF-Connecting-IP") ??
    c.req.header("x-forwarded-for") ??
    "unknown";

  if (isRateLimited(ip)) {
    return c.json({ error: "Too many requests, please wait a moment." }, 429);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const incomingSessionId =
    typeof body === "object" && body !== null
      ? (body as { sessionId?: unknown }).sessionId
      : undefined;

  const sessionId =
    typeof incomingSessionId === "string" && SESSION_ID_RE.test(incomingSessionId)
      ? incomingSessionId
      : makeSessionId();

  const { options } = await getConfig(c.env.DB);
  if (options.length < 2) {
    return c.json({ error: "The raffle needs at least 2 options configured." }, 400);
  }

  const winningIndex = randomIndex(options.length);
  const winningOption = options[winningIndex];
  const result = winningOption.value;
  const createdAt = new Date().toISOString();

  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM spins WHERE session_id = ?"
  )
    .bind(sessionId)
    .first<{ n: number }>();
  const spinNumber = (countRow?.n ?? 0) + 1;

  await c.env.DB.prepare(
    "INSERT INTO spins (session_id, spin_number, created_at, result, options_snapshot) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(sessionId, spinNumber, createdAt, result, JSON.stringify(options))
    .run();

  return c.json({
    sessionId,
    spinNumber,
    createdAt,
    result,
    customUrl: winningOption.customUrl,
    customLabel: winningOption.customLabel,
    customUrl2: winningOption.customUrl2,
    customLabel2: winningOption.customLabel2,
  });
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function pageShell(title: string, body: string, extraStyle = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<script>
  // Runs before first paint so there's no flash of the wrong theme. Light is the default;
  // a saved choice in localStorage is the only thing that switches it to dark.
  (function () {
    try {
      if (localStorage.getItem("wheel_theme") === "dark") {
        document.documentElement.setAttribute("data-theme", "dark");
      }
    } catch (e) {}
  })();
</script>
<style>
  :root {
    color-scheme: light;
    --bg: #f6f4ef;
    --panel: #ffffff;
    --border-solid: #ddd8cb;
    --text: #1c1c1c;
    --muted: #6b6b6b;
    --gold-text: #8a6416;
    --well: #efebe1;
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #14151a;
    --panel: #1e2028;
    --border-solid: #3a3d47;
    --text: #f2f2f5;
    --muted: #9a9ba5;
    --gold-text: #ffd23f;
    --well: #14151a;
  }
  html, body { overflow-x: hidden; max-width: 100%; }
  body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 1.5rem; }
  main { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.3rem; }
  h2 { font-size: 1.05rem; color: var(--gold-text); }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: .9rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--border-solid); }
  th { color: var(--gold-text); font-weight: 600; }
  a { color: var(--gold-text); }
  form.filters { display: flex; flex-wrap: wrap; gap: .6rem; align-items: end; margin: 1rem 0; }
  form.filters label { display: flex; flex-direction: column; font-size: .8rem; color: var(--muted); gap: .25rem; }
  input {
    font: inherit; background: var(--well); color: var(--text);
    border: 1px solid var(--border-solid); border-radius: 6px; padding: .4rem .6rem;
  }
  button {
    font: inherit; cursor: pointer; border-radius: 6px; padding: .4rem .7rem;
    background: #ffd23f; color: #1a1500; border: 1px solid #c9a52d; font-weight: 600;
  }
  button:hover { background: #ffdb66; }
  .pagination { display: flex; flex-wrap: wrap; gap: 1rem; margin: 1rem 0; }
  .muted { color: var(--muted); font-size: .85rem; }
  .delete-btn { background: none; border: none; color: #ff5c6c; font-weight: 500; padding: 0; }
  .delete-btn:hover { text-decoration: underline; background: none; }
  .table-scroll { overflow-x: auto; }
  #themeToggleBtn {
    position: fixed; top: .75rem; right: .75rem; z-index: 5;
    width: 2.25rem; height: 2.25rem; padding: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 1.1rem; line-height: 1;
    background: transparent; border: 1px solid var(--border-solid); border-radius: 50%;
    color: var(--text); opacity: .7;
  }
  #themeToggleBtn:hover { opacity: 1; background: var(--well); }
  @media (max-width: 640px) {
    body { padding: 1rem; }
    main { padding-top: 2.5rem; }
    form.filters { flex-direction: column; align-items: stretch; }
    form.filters > * { width: 100%; box-sizing: border-box; }
    form.filters > a { display: block; }
    form.filters > a > button { width: 100%; }
    table { font-size: .8rem; }
    th, td { padding: .35rem .4rem; }
  }
  ${extraStyle}
</style>
</head>
<body>
<button id="themeToggleBtn" type="button" aria-label="Switch to dark mode"></button>
<main>
${body}
</main>
<script>
(function () {
  var btn = document.getElementById("themeToggleBtn");
  function isDark() { return document.documentElement.getAttribute("data-theme") === "dark"; }
  function syncLabel() {
    btn.textContent = isDark() ? "☀️" : "🌙";
    btn.setAttribute("aria-label", isDark() ? "Switch to light mode" : "Switch to dark mode");
  }
  syncLabel();
  btn.addEventListener("click", function () {
    var next = isDark() ? "light" : "dark";
    if (next === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem("wheel_theme", next); } catch (e) {}
    syncLabel();
  });
})();
</script>
</body>
</html>`;
}

app.get("/s/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");

  const { results } = await c.env.DB.prepare(
    "SELECT spin_number, created_at, result, options_snapshot FROM spins WHERE session_id = ? ORDER BY spin_number ASC"
  )
    .bind(sessionId)
    .all<{
      spin_number: number;
      created_at: string;
      result: string;
      options_snapshot: string;
    }>();

  const rows = results ?? [];
  const rowsHtml = rows.length
    ? rows
        .map((r) => {
          const opts: Option[] = JSON.parse(r.options_snapshot).map(normalizeOption);
          return `<tr>
            <td>#${r.spin_number}</td>
            <td>${escapeHtml(new Date(r.created_at).toLocaleString())}</td>
            <td><strong>${escapeHtml(r.result)}</strong></td>
            <td>${escapeHtml(opts.map((o) => o.value).join(", "))}</td>
          </tr>`;
        })
        .join("\n")
    : `<tr><td colspan="4" class="muted">No spins found for this session.</td></tr>`;

  const body = `
    <h1>Raffle verification</h1>
    <p class="muted">Session <strong>${escapeHtml(sessionId)}</strong> — ${rows.length} spin(s).</p>
    <div class="table-scroll">
      <table>
        <thead><tr><th>#</th><th>Date</th><th>Result</th><th>Options</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;

  return c.html(pageShell(`Session ${sessionId} — Verification`, body));
});

const ADMIN_PAGE_SIZE = 50;

app.get("/godak", async (c) => {
  if (!(await isAdminAuthed(c))) return c.html(loginPage());

  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const date = c.req.query("date") ?? "";
  const q = c.req.query("q") ?? "";
  // A search that looks exactly like a session id also drives the per-session breakdown below.
  const sessionIdFilter = SESSION_ID_RE.test(q) ? q : "";

  const config = await getConfig(c.env.DB);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (q) {
    conditions.push("(session_id LIKE ? OR result LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (date) {
    conditions.push("created_at >= ? AND created_at <= ?");
    params.push(`${date}T00:00:00.000Z`, `${date}T23:59:59.999Z`);
  }
  const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM spins ${whereSql}`
  )
    .bind(...params)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;
  const offset = (page - 1) * ADMIN_PAGE_SIZE;

  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, session_id, spin_number, created_at, result FROM spins ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(...params, ADMIN_PAGE_SIZE, offset)
    .all<{
      id: number;
      session_id: string;
      spin_number: number;
      created_at: string;
      result: string;
    }>();

  let aggHtml = "";
  if (sessionIdFilter) {
    const { results: agg } = await c.env.DB.prepare(
      "SELECT result, COUNT(*) AS n FROM spins WHERE session_id = ? GROUP BY result ORDER BY n DESC"
    )
      .bind(sessionIdFilter)
      .all<{ result: string; n: number }>();
    aggHtml = `
      <h2>Result counts — session ${escapeHtml(sessionIdFilter)}</h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Option</th><th>Times</th></tr></thead>
          <tbody>${(agg ?? [])
            .map((a) => `<tr><td>${escapeHtml(a.result)}</td><td>${a.n}</td></tr>`)
            .join("\n")}</tbody>
        </table>
      </div>`;
  }

  const rowsHtml = (rows ?? [])
    .map((r) => {
      return `<tr>
        <td>${r.id}</td>
        <td><a href="/s/${encodeURIComponent(r.session_id)}">${escapeHtml(r.session_id)}</a></td>
        <td>#${r.spin_number}</td>
        <td>${escapeHtml(new Date(r.created_at).toLocaleString())}</td>
        <td><strong>${escapeHtml(r.result)}</strong></td>
        <td>
          <form method="post" action="/godak/spins/${r.id}/delete" onsubmit="return confirm('Delete this spin record?');">
            <button type="submit" class="delete-btn">Delete</button>
          </form>
        </td>
      </tr>`;
    })
    .join("\n");

  const qs = (extra: Record<string, string | number>) => {
    const p = new URLSearchParams({ date, q, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    return p.toString();
  };

  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));

  const optionsJson = JSON.stringify(config.options);

  const body = `
    <h1>SunGodAK panel</h1>

    <h2>Raffle settings</h2>
    <form id="configForm" method="post" action="/godak/config">
      <label class="muted" for="titleInput">Raffle title</label><br/>
      <input id="titleInput" type="text" name="title" value="${escapeHtml(config.title)}" style="width:100%; max-width:200px; margin:.4rem 0 1rem;" /><br/>

      <p class="muted" style="margin-bottom:.4rem;">Options (visible to every footfag spinning the wheel)</p>
      <div class="tabs" role="tablist">
        <button type="button" class="tab-btn active" id="editTabBtn" data-tab="edit">Edit options</button>
        <button type="button" class="tab-btn" id="jsonTabBtn" data-tab="json">Paste JSON</button>
      </div>
      <div id="optionsList"></div>
      <div id="jsonPasteWrap" hidden>
        <textarea id="jsonPasteArea" rows="10" spellcheck="false"
          placeholder='[{"value":"$10","customUrl":"https://...","customLabel":"Send 10"}]'></textarea>
        <p id="jsonPasteError" class="spin-error"></p>
      </div>
      <input type="hidden" name="optionsJson" id="optionsJsonField" />
      <div style="margin-top:1rem; display:flex; gap:.6rem; align-items:center;">
        <button type="submit">Save settings</button>
        <button type="button" id="copyJsonBtn">Copy JSON</button>
      </div>
    </form>

    <hr class="section-divider" />

    <h2>Spin history</h2>
    <p class="muted">${total} spin(s) total.</p>
    <form class="filters" method="get">
      <input type="text" name="q" value="${escapeHtml(q)}" placeholder="Search session id or result…" style="flex:1; min-width:220px;" />
      <input type="date" name="date" value="${escapeHtml(date)}" />
      <button type="submit">Filter</button>
      ${date || q ? `<a href="/godak"><button type="button">Clear</button></a>` : ""}
    </form>
    <p><a href="/godak/export.csv">Download full history (CSV)</a></p>
    ${aggHtml}
    <div class="table-scroll">
      <table>
        <thead><tr><th>ID</th><th>Session</th><th>#</th><th>Date</th><th>Result</th><th></th></tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="6" class="muted">No results.</td></tr>`}</tbody>
      </table>
    </div>
    <div class="pagination">
      ${page > 1 ? `<a href="/godak?${qs({ page: page - 1 })}">&larr; Previous</a>` : ""}
      <span class="muted">Page ${page} of ${totalPages}</span>
      ${page < totalPages ? `<a href="/godak?${qs({ page: page + 1 })}">Next &rarr;</a>` : ""}
    </div>

    <hr class="section-divider" />

    <form method="post" action="/godak/change-password" style="max-width:280px;">
      <label class="muted" for="newPasswordInput">New SunGod password</label><br/>
      <input id="newPasswordInput" type="password" name="newPassword" required style="width:100%; margin:.4rem 0 1rem;" /><br/>
      <button type="submit">Change password</button>
    </form>

    <script>
    (function () {
      var options = ${optionsJson};
      var listEl = document.getElementById("optionsList");
      var hiddenField = document.getElementById("optionsJsonField");

      function linkField(row, opt, key, placeholder) {
        var input = document.createElement("input");
        input.value = opt[key] || "";
        input.placeholder = placeholder;
        input.setAttribute("aria-label", placeholder);
        input.addEventListener("input", function () {
          opt[key] = input.value;
        });
        row.appendChild(input);
      }

      function render() {
        listEl.innerHTML = "";
        options.forEach(function (opt, i) {
          var row = document.createElement("div");
          row.className = "admin-option-row";

          var main = document.createElement("div");
          main.className = "admin-option-main";

          var input = document.createElement("input");
          input.value = opt.value;
          input.placeholder = "Option text";
          input.setAttribute("aria-label", "Option " + (i + 1));
          input.addEventListener("input", function () {
            opt.value = input.value;
          });
          input.addEventListener("keydown", function (e) {
            if (e.key === "Enter") e.preventDefault();
          });

          var del = document.createElement("button");
          del.type = "button";
          del.className = "admin-option-remove";
          del.textContent = "\\u00d7";
          del.setAttribute("aria-label", "Remove option " + (i + 1));
          del.addEventListener("click", function () {
            options.splice(i, 1);
            render();
          });

          main.appendChild(input);
          main.appendChild(del);
          row.appendChild(main);

          var links = document.createElement("div");
          links.className = "admin-option-links";
          linkField(links, opt, "customUrl", "Link URL");
          linkField(links, opt, "customLabel", "Link label");
          linkField(links, opt, "customUrl2", "2nd link URL (optional)");
          linkField(links, opt, "customLabel2", "2nd link label");
          row.appendChild(links);

          listEl.appendChild(row);
        });

        // Always-present trailing blank row: typing here + Enter commits a new option.
        var addRow = document.createElement("div");
        addRow.className = "admin-option-row";
        var addMain = document.createElement("div");
        addMain.className = "admin-option-main";
        var addInput = document.createElement("input");
        addInput.placeholder = "Add option";
        addInput.setAttribute("aria-label", "Add option");
        addInput.addEventListener("keydown", function (e) {
          if (e.key !== "Enter") return;
          e.preventDefault();
          var value = addInput.value.trim();
          if (!value) return;
          options.push({ value: value });
          render();
          var newAddInput = listEl.lastChild.querySelector("input");
          if (newAddInput) newAddInput.focus();
        });
        addMain.appendChild(addInput);
        addRow.appendChild(addMain);
        listEl.appendChild(addRow);
      }

      function cleanOptions() {
        return options
          .map(function (o) {
            var out = { value: (o.value || "").trim() };
            ["customUrl", "customLabel", "customUrl2", "customLabel2"].forEach(function (key) {
              var v = (o[key] || "").trim();
              if (v) out[key] = v;
            });
            return out;
          })
          .filter(function (o) { return o.value; });
      }

      // ---- Edit options / Paste JSON tabs -------------------------------------
      var editTabBtn = document.getElementById("editTabBtn");
      var jsonTabBtn = document.getElementById("jsonTabBtn");
      var jsonPasteWrap = document.getElementById("jsonPasteWrap");
      var jsonPasteArea = document.getElementById("jsonPasteArea");
      var jsonPasteError = document.getElementById("jsonPasteError");
      var activeTab = "edit";

      function parsePastedOptions() {
        var parsed = JSON.parse(jsonPasteArea.value);
        if (!Array.isArray(parsed)) throw new Error("JSON must be an array of options.");
        return parsed.map(function (o) {
          return typeof o === "string" ? { value: o } : o;
        });
      }

      function showTab(tab) {
        if (tab === activeTab) return;
        if (tab === "json") {
          jsonPasteArea.value = JSON.stringify(cleanOptions(), null, 2);
        } else {
          try {
            options = parsePastedOptions();
            render();
          } catch (e) {
            // Invalid JSON: leave the field editor as it was, user can go back and fix it.
          }
        }
        activeTab = tab;
        jsonPasteWrap.hidden = tab !== "json";
        listEl.hidden = tab !== "edit";
        editTabBtn.classList.toggle("active", tab === "edit");
        jsonTabBtn.classList.toggle("active", tab === "json");
        jsonPasteError.textContent = "";
      }

      editTabBtn.addEventListener("click", function () { showTab("edit"); });
      jsonTabBtn.addEventListener("click", function () { showTab("json"); });

      document.getElementById("configForm").addEventListener("submit", function (e) {
        if (activeTab === "json") {
          try {
            options = parsePastedOptions();
          } catch (err) {
            e.preventDefault();
            jsonPasteError.textContent = "Invalid JSON: " + err.message;
            return;
          }
        }
        hiddenField.value = JSON.stringify(cleanOptions());
      });

      var copyJsonBtn = document.getElementById("copyJsonBtn");
      copyJsonBtn.addEventListener("click", function () {
        navigator.clipboard.writeText(JSON.stringify(cleanOptions(), null, 2)).then(function () {
          var original = copyJsonBtn.textContent;
          copyJsonBtn.textContent = "Copied!";
          setTimeout(function () { copyJsonBtn.textContent = original; }, 1500);
        });
      });

      render();
    })();
    </script>`;

  const extraStyle = `
    .section-divider { border: none; border-top: 1px solid var(--border-solid); margin: 2rem 0; }
    #optionsList { display: flex; flex-direction: column; }
    #optionsList[hidden] { display: none; }
    .admin-option-row {
      display: flex; flex-direction: column; gap: .35rem;
      border-bottom: 1px solid var(--border-solid); padding: .5rem 0;
    }
    .admin-option-main { display: flex; align-items: center; gap: .5rem; }
    .admin-option-main input {
      flex: 1; background: transparent; border: none; border-radius: 0;
      padding: .25rem 0; color: var(--text);
    }
    .admin-option-main input:focus { outline: none; border-bottom: 1px solid #ffd23f; }
    .admin-option-links {
      display: grid; grid-template-columns: 1fr 1fr; gap: .35rem .5rem;
    }
    .admin-option-links input {
      background: var(--well); color: var(--text); font-size: .8rem;
      border: 1px solid var(--border-solid); border-radius: 6px; padding: .3rem .5rem;
    }
    .admin-option-remove {
      background: none; border: none; color: #ff5c6c88;
      font-size: 1.15rem; line-height: 1; padding: .2rem .4rem; font-weight: 400;
    }
    .admin-option-remove:hover { color: #ff5c6c; background: none; }
    .tabs { display: flex; gap: .4rem; margin-bottom: .6rem; }
    .tab-btn {
      background: none; border: none; border-bottom: 2px solid transparent;
      border-radius: 0; padding: .3rem .2rem; font-weight: 500; color: var(--muted);
    }
    .tab-btn:hover { background: none; color: var(--text); }
    .tab-btn.active { color: var(--gold-text); border-bottom-color: #ffd23f; }
    #jsonPasteArea {
      width: 100%; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: .8rem;
      background: var(--well); color: var(--text); border: 1px solid var(--border-solid);
      border-radius: 6px; padding: .6rem; resize: vertical;
    }
    @media (max-width: 640px) {
      .admin-option-links { grid-template-columns: 1fr; }
    }
  `;

  return c.html(pageShell("Admin panel", body, extraStyle));
});

function isValidOption(o: unknown): o is Option {
  if (typeof o !== "object" || o === null) return false;
  const opt = o as Record<string, unknown>;
  if (typeof opt.value !== "string" || opt.value.length < 1 || opt.value.length > 200) return false;
  for (const key of ["customUrl", "customUrl2"]) {
    if (opt[key] !== undefined && (typeof opt[key] !== "string" || (opt[key] as string).length > 500)) return false;
  }
  for (const key of ["customLabel", "customLabel2"]) {
    if (opt[key] !== undefined && (typeof opt[key] !== "string" || (opt[key] as string).length > 200)) return false;
  }
  return true;
}

app.post("/godak/config", async (c) => {
  if (!(await isAdminAuthed(c))) return c.redirect("/godak");
  const form = await c.req.formData();
  const title = String(form.get("title") ?? "").trim();
  const optionsJson = String(form.get("optionsJson") ?? "[]");

  let options: unknown;
  try {
    options = JSON.parse(optionsJson);
  } catch {
    return c.text("Invalid options payload.", 400);
  }

  if (!title) return c.text("Title is required.", 400);
  if (
    !Array.isArray(options) ||
    options.length < 2 ||
    options.length > 100 ||
    !options.every(isValidOption)
  ) {
    return c.text(
      "Need between 2 and 100 options; each needs a value (1-200 chars) and optional custom links.",
      400
    );
  }

  await c.env.DB.prepare("UPDATE config SET title = ?, options = ? WHERE id = 1")
    .bind(title, JSON.stringify(options))
    .run();

  return c.redirect("/godak");
});

app.post("/godak/spins/:id/delete", async (c) => {
  if (!(await isAdminAuthed(c))) return c.redirect("/godak");
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM spins WHERE id = ?").bind(id).run();
  return c.redirect("/godak");
});

app.get("/godak/export.csv", async (c) => {
  if (!(await isAdminAuthed(c))) return c.redirect("/godak");
  const { results } = await c.env.DB.prepare(
    "SELECT session_id, spin_number, created_at, result, options_snapshot FROM spins ORDER BY created_at ASC"
  ).all<{
    session_id: string;
    spin_number: number;
    created_at: string;
    result: string;
    options_snapshot: string;
  }>();

  const csvEscape = (v: string) =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

  const header = ["session_id", "spin_number", "created_at", "result", "options_snapshot"];
  const lines = [header.join(",")];
  for (const r of results ?? []) {
    const opts: Option[] = JSON.parse(r.options_snapshot).map(normalizeOption);
    lines.push(
      [
        r.session_id,
        String(r.spin_number),
        r.created_at,
        csvEscape(r.result),
        csvEscape(opts.map((o) => o.value).join("|")),
      ].join(",")
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="giros-${today}.csv"`,
    },
  });
});

export default app;
