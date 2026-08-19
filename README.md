# Raffle Wheel

Single-page app for running live raffles (wheelofnames.com-style), with every spin logged
server-side (Cloudflare D1) so it can be verified afterward.

Stack: **Cloudflare Workers** + **Hono** + **D1**, static assets served by the Worker itself.
No Node.js, no ORM, no heavy frontend frameworks (native canvas).

## Structure

```
src/index.ts        Worker (Hono): /api/config, /api/spin, /s/:sessionId, /godak, /godak/login,
                     /godak/config, /godak/spins/:id/delete, /godak/export.csv, /godak/change-password
public/index.html   Wheel frontend (static, served by the assets binding)
migrations/          D1 SQL migrations (0001 spins table, 0002 config table, 0003 password,
                     0004 options from string[] to object {value, customUrl, ...})
wrangler.jsonc       Worker config + D1 binding
```

**Important — who controls what:** the raffle's title and options are NO LONGER edited from
the public page. They live in the `config` table (a single row) and are only edited from `/godak`.
The public page (`/`) only reads that title and those options via `GET /api/config` — anyone who
visits sees the same wheel, they can't modify it.

Each option is an object `{value, customUrl?, customLabel?, customUrl2?, customLabel2?}`: `value`
is the slice's text, and `customUrl`/`customLabel` (plus an optional second pair `customUrl2`/
`customLabel2`) build the buttons shown in the popup when that option wins — all edited from
`/godak`; a button is hidden if that option has no matching link.

A `?sid=something` in the URL pins the visitor's session to that id instead of generating a
random one (useful for linking a specific session to someone without them having to type it in).
The "New session" / "Use ID" controls are hidden on the public page, though the mechanism is
still active under the hood.

**Access to `/godak`:** the app itself requires a password (default password `12345`, stored in
the `config` row). Anyone hitting `/godak` without a valid session cookie just sees a password
form; on success, an `admin_auth` cookie (httpOnly, 30 days) is set. There's a "Change password"
button at the bottom of the panel — changing it automatically invalidates any old cookie (the
cookie is a hash of the current password, not the password itself). Cloudflare Access (section 5)
is an optional extra layer, no longer the only protection mechanism.

## 1. Test locally

No Cloudflare account or login needed for this: local `wrangler dev` uses a D1 database emulated
on disk (`.wrangler/state`).

```bash
npm install
npm run migrate:local   # creates the tables in the local D1
npm run dev              # starts http://localhost:8787
```

Open `http://localhost:8787` for the wheel, `http://localhost:8787/godak` for the admin panel
(asks for the default password `12345`, same locally as in production — see "Access to `/godak`"
above).

Migration `0002_config.sql` seeds a sample title and options ("Live Raffle" / Prize 1-4). Go to
`/godak` to replace them with the real ones before sharing the public link.

## 2. Create the real database

Requires being logged into your Cloudflare account:

```bash
npx wrangler login
npx wrangler d1 create rueda-sorteos-db
```

Copy the `database_id` it returns and replace it in `wrangler.jsonc` (currently has a placeholder
`00000000-0000-0000-0000-000000000000`).

## 3. Apply migrations to the remote database

```bash
npm run migrate:remote
```

## 4. Deploy

```bash
npm run deploy
```

Wrangler gives you a `*.workers.dev` URL. For real production, a custom domain is recommended
(see the next section — Access requires it anyway).

## 5. Protect `/godak` with Cloudflare Access

**Important:** Cloudflare Access can only protect routes under a custom domain connected to your
Cloudflare account (a DNS zone managed by Cloudflare). It doesn't work on the free `*.workers.dev`
subdomain. Steps:

1. Connect a custom domain to the Worker: **Workers & Pages → your Worker → Settings → Domains &
   Routes → Add → Custom Domain**.
2. Go to the **Zero Trust → Access → Applications → Add an application → Self-hosted** dashboard.
3. Set the application domain to `your-domain.com/godak*`.
4. Create an access policy (e.g., "Allow" if the email matches yours, or your email domain).
5. Save. From then on, any request to `/godak` goes through the Access login screen (email code
   or whichever identity provider you configure) before reaching the Worker.

With Access enabled, the request passes through Access first and then, inside the app itself,
still asks for the `/godak` password — both layers stay in place.

## Implementation notes

- The winner of each spin is decided server-side (`crypto.getRandomValues`), never in the browser.
- The session id (6-8 characters, no `0 o 1 l i`) is generated client-side and validated/replaced
  server-side if missing or malformed.
- Rate limiting on `/api/spin` is an in-memory counter per isolate (not shared across edge
  locations). Enough for the volume of a single creator running live raffles; if a real global
  limit is needed, migrate to a Durable Object or KV.
