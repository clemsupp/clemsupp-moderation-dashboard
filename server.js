require('dotenv').config();

const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');

const required = [
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
  'APP_BASE_URL',
  'DATABASE_URL',
  'ADMIN_PASSWORD',
  'TOKEN_ENCRYPTION_KEY',
  'EVENTSUB_SECRET',
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const encryptionKey = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex');
if (encryptionKey.length !== 32) {
  console.error('TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).');
  process.exit(1);
}
if (process.env.EVENTSUB_SECRET.length < 20 || process.env.EVENTSUB_SECRET.length > 100) {
  console.error('EVENTSUB_SECRET must be between 20 and 100 characters.');
  process.exit(1);
}

const baseUrl = process.env.APP_BASE_URL.replace(/\/$/, '');
const redirectUri = `${baseUrl}/auth/callback`;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.raw({ type: 'application/json', limit: '1mb' }));

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${ciphertext.toString('hex')}`;
}

function decrypt(value) {
  const [ivHex, tagHex, ciphertextHex] = value.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

function safeEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    let decoded = '';
    try { decoded = Buffer.from(encoded, 'base64').toString('utf8'); } catch {}
    const separator = decoded.indexOf(':');
    const password = separator >= 0 ? decoded.slice(separator + 1) : '';
    if (separator >= 0 && safeEqual(password, process.env.ADMIN_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Twitch moderation dashboard", charset="UTF-8"');
  return res.status(401).send('Connecte-toi avec le mot de passe administrateur défini dans Render.');
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moderation_events (
      id BIGSERIAL PRIMARY KEY,
      event_key TEXT UNIQUE,
      broadcaster_id TEXT NOT NULL,
      broadcaster_name TEXT,
      moderator_id TEXT,
      moderator_name TEXT,
      target_user_id TEXT NOT NULL,
      target_login TEXT,
      target_name TEXT,
      action TEXT NOT NULL,
      duration_seconds INTEGER,
      reason TEXT,
      occurred_at TIMESTAMPTZ NOT NULL,
      source TEXT NOT NULL DEFAULT 'eventsub',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS moderation_events_occurred_at_idx ON moderation_events (occurred_at DESC);
    CREATE TABLE IF NOT EXISTS twitch_connection (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      broadcaster_id TEXT NOT NULL,
      broadcaster_login TEXT NOT NULL,
      broadcaster_name TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getConnection() {
  const result = await pool.query('SELECT * FROM twitch_connection WHERE id = 1');
  if (!result.rowCount) throw new Error('Twitch account not connected yet. Open /auth/start first.');
  const row = result.rows[0];
  if (new Date(row.expires_at).getTime() < Date.now() + 60_000) {
    const refreshToken = decrypt(row.refresh_token);
    const form = new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const tokens = await response.json();
    if (!response.ok) throw new Error(`Twitch token refresh failed (${response.status}). Reconnect at /auth/start.`);
    await pool.query(`
      UPDATE twitch_connection SET access_token = $1, refresh_token = $2,
        expires_at = NOW() + ($3 * INTERVAL '1 second'), updated_at = NOW() WHERE id = 1
    `, [encrypt(tokens.access_token), encrypt(tokens.refresh_token || refreshToken), tokens.expires_in]);
    row.access_token = encrypt(tokens.access_token);
  }
  return { ...row, token: decrypt(row.access_token) };
}

async function twitchApi(path, token, options = {}) {
  const response = await fetch(`https://api.twitch.tv/helix${path}`, {
    ...options,
    headers: {
      'Client-Id': process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Twitch API ${response.status}: ${body.message || 'request failed'}`);
  return body;
}

async function storeEvent(event, eventKey, eventType, source = 'eventsub') {
  const ended = event.ends_at ? new Date(event.ends_at) : null;
  const started = new Date(event.banned_at || event.created_at || Date.now());
  const duration = ended ? Math.max(0, Math.round((ended.getTime() - started.getTime()) / 1000)) : null;
  const action = eventType === 'channel.unban'
    ? 'UNBAN'
    : (event.is_permanent === true || !ended ? 'BAN' : 'TIMEOUT');
  await pool.query(`
    INSERT INTO moderation_events (
      event_key, broadcaster_id, broadcaster_name, moderator_id, moderator_name,
      target_user_id, target_login, target_name, action, duration_seconds,
      reason, occurred_at, source
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (event_key) DO NOTHING
  `, [
    eventKey,
    event.broadcaster_user_id,
    event.broadcaster_user_name || event.broadcaster_user_login || null,
    event.moderator_user_id || null,
    event.moderator_user_name || event.moderator_user_login || null,
    event.user_id,
    event.user_login || null,
    event.user_name || event.user_login || null,
    action,
    duration,
    event.reason || null,
    started,
    source,
  ]);
}

async function importCurrentSanctions(connection) {
  const inserted = [];
  let after = '';
  do {
    const query = new URLSearchParams({ broadcaster_id: connection.broadcaster_id, first: '100' });
    if (after) query.set('after', after);
    const page = await twitchApi(`/moderation/banned?${query}`, connection.token);
    for (const ban of page.data || []) {
      const expires = ban.expires_at ? new Date(ban.expires_at) : null;
      const action = expires ? 'TIMEOUT' : 'BAN';
      const key = `import:${connection.broadcaster_id}:${ban.user_id}:${ban.created_at}`;
      const result = await pool.query(`
        INSERT INTO moderation_events (
          event_key, broadcaster_id, broadcaster_name, moderator_id, moderator_name,
          target_user_id, target_login, target_name, action, duration_seconds,
          reason, occurred_at, source
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'initial_import')
        ON CONFLICT (event_key) DO NOTHING RETURNING id
      `, [
        key, connection.broadcaster_id, connection.broadcaster_name,
        ban.moderator_id || null, ban.moderator_name || ban.moderator_login || null,
        ban.user_id, ban.user_login || null, ban.user_name || ban.user_login || null,
        action,
        expires ? Math.max(0, Math.round((expires.getTime() - new Date(ban.created_at).getTime()) / 1000)) : null,
        ban.reason || null, ban.created_at,
      ]);
      if (result.rowCount) inserted.push(ban.user_id);
    }
    after = page.pagination?.cursor || '';
  } while (after);
  return inserted.length;
}

async function ensureEventSubscriptions(connection) {
  const list = await twitchApi('/eventsub/subscriptions?first=100', connection.token);
  for (const type of ['channel.ban', 'channel.unban']) {
    const exists = (list.data || []).some((sub) =>
      sub.type === type && sub.status === 'enabled' &&
      sub.condition?.broadcaster_user_id === connection.broadcaster_id &&
      sub.transport?.callback === `${baseUrl}/webhooks/eventsub`);
    if (exists) continue;
    await twitchApi('/eventsub/subscriptions', connection.token, {
      method: 'POST',
      body: JSON.stringify({
        type,
        version: '1',
        condition: { broadcaster_user_id: connection.broadcaster_id },
        transport: {
          method: 'webhook',
          callback: `${baseUrl}/webhooks/eventsub`,
          secret: process.env.EVENTSUB_SECRET,
        },
      }),
    });
  }
}

function page(title, body) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
    :root{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#f4f4f5;background:#111827}body{margin:0;padding:32px}main{max-width:1080px;margin:auto}h1{font-size:1.8rem}p{color:#cbd5e1}.card{background:#1f2937;border:1px solid #374151;border-radius:12px;padding:20px;margin:18px 0}a,button{background:#9147ff;color:white;border:0;border-radius:8px;padding:10px 14px;text-decoration:none;font:inherit;cursor:pointer}button.secondary{background:#374151}table{width:100%;border-collapse:collapse;background:#1f2937}th,td{text-align:left;padding:10px;border-bottom:1px solid #374151}th{color:#c4b5fd}small{color:#9ca3af}.scroll{overflow:auto}.badge{font-size:.8rem;padding:3px 8px;border-radius:99px;background:#374151}
    </style></head><body><main>${body}</main></body></html>`;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/', (_req, res) => res.send(page('Twitch Sanctions', `
  <h1>Historique des sanctions Twitch</h1>
  <section class="card"><p>Connecte le compte Twitch du propriétaire de la chaîne pour importer les sanctions en cours et enregistrer les nouveaux bans, timeouts et unbans.</p><p><a href="/auth/start">Connecter Twitch</a></p><p><small>Le mot de passe administrateur est demandé lorsque tu ouvres le tableau de bord.</small></p></section>
  <p><a class="secondary" href="/dashboard">Ouvrir le tableau de bord</a></p>
`)));

app.get('/auth/start', (_req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  const authorize = new URL('https://id.twitch.tv/oauth2/authorize');
  authorize.search = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'channel:moderate moderator:read:banned_users',
    state,
    force_verify: 'true',
  }).toString();
  res.redirect(authorize.toString());
});

app.get('/auth/callback', async (req, res) => {
  try {
    const expected = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('oauth_state='))?.slice('oauth_state='.length);
    if (!req.query.state || !safeEqual(decodeURIComponent(expected || ''), String(req.query.state))) {
      return res.status(400).send('Connexion Twitch expirée ou invalide. Recommence depuis la page principale.');
    }
    res.clearCookie('oauth_state');
    if (req.query.error) return res.status(400).send('Autorisation Twitch refusée. Recommence et accepte les autorisations demandées.');
    const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        code: String(req.query.code || ''),
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(`Twitch OAuth failed (${tokenResponse.status}).`);
    const me = await twitchApi('/users', tokens.access_token);
    const user = me.data?.[0];
    if (!user) throw new Error('Twitch did not return an account.');
    await pool.query(`
      INSERT INTO twitch_connection (id, broadcaster_id, broadcaster_login, broadcaster_name, access_token, refresh_token, expires_at)
      VALUES (1,$1,$2,$3,$4,$5,NOW() + ($6 * INTERVAL '1 second'))
      ON CONFLICT (id) DO UPDATE SET broadcaster_id=EXCLUDED.broadcaster_id,
        broadcaster_login=EXCLUDED.broadcaster_login, broadcaster_name=EXCLUDED.broadcaster_name,
        access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token,
        expires_at=EXCLUDED.expires_at, updated_at=NOW()
    `, [user.id, user.login, user.display_name, encrypt(tokens.access_token), encrypt(tokens.refresh_token), tokens.expires_in]);
    const connection = { broadcaster_id: user.id, broadcaster_login: user.login, broadcaster_name: user.display_name, token: tokens.access_token };
    const imported = await importCurrentSanctions(connection);
    await ensureEventSubscriptions(connection);
    return res.send(page('Connexion terminée', `<h1>Connexion Twitch terminée</h1><section class="card"><p>Compte connecté : <strong>${escapeHtml(user.display_name)}</strong></p><p>${imported} sanction(s) active(s) importée(s). Les nouveaux événements Twitch seront enregistrés automatiquement.</p><a href="/dashboard">Ouvrir le tableau de bord</a></section>`));
  } catch (error) {
    console.error(error.message);
    return res.status(500).send(page('Erreur de connexion', `<h1>La connexion n’a pas abouti</h1><p>${escapeHtml(error.message)}</p><p>Vérifie les réglages Render et Twitch, puis recommence depuis la page d’accueil.</p><a href="/">Retour</a>`));
  }
});

app.post('/webhooks/eventsub', async (req, res) => {
  try {
    const messageId = req.get('Twitch-Eventsub-Message-Id') || '';
    const timestamp = req.get('Twitch-Eventsub-Message-Timestamp') || '';
    const signature = req.get('Twitch-Eventsub-Message-Signature') || '';
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const digest = crypto.createHmac('sha256', process.env.EVENTSUB_SECRET).update(messageId + timestamp).update(rawBody).digest('hex');
    if (!safeEqual(`sha256=${digest}`, signature)) return res.sendStatus(403);
    if (Date.now() - Date.parse(timestamp) > 10 * 60 * 1000) return res.sendStatus(403);
    const payload = JSON.parse(rawBody.toString('utf8'));
    const kind = req.get('Twitch-Eventsub-Message-Type');
    if (kind === 'webhook_callback_verification') return res.type('text/plain').send(payload.challenge);
    if (kind === 'notification') {
      const type = payload.subscription?.type;
      if (type === 'channel.ban' || type === 'channel.unban') {
        await storeEvent(payload.event, `${messageId}:${type}`, type);
      }
      return res.sendStatus(204);
    }
    if (kind === 'revocation') console.warn('Twitch revoked an EventSub subscription:', payload.subscription?.type, payload.subscription?.status);
    return res.sendStatus(204);
  } catch (error) {
    console.error('EventSub webhook error:', error.message);
    return res.sendStatus(400);
  }
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

app.get('/dashboard', requireAdmin, async (_req, res) => {
  try {
    const connection = await pool.query('SELECT broadcaster_name FROM twitch_connection WHERE id = 1');
    const rows = await pool.query(`
      SELECT moderator_name, target_name, target_login, action, duration_seconds, reason, occurred_at, source
      FROM moderation_events ORDER BY occurred_at DESC LIMIT 500
    `);
    const name = connection.rows[0]?.broadcaster_name || 'Twitch non connecté';
    const tableRows = rows.rows.map((item) => `<tr><td>${escapeHtml(new Date(item.occurred_at).toLocaleString('fr-FR'))}</td><td>${escapeHtml(item.moderator_name || 'Non fourni')}</td><td>${escapeHtml(item.target_name || item.target_login)}</td><td><span class="badge">${escapeHtml(item.action)}</span></td><td>${item.duration_seconds == null ? '—' : `${Math.floor(item.duration_seconds / 60)} min`}</td><td>${escapeHtml(item.reason || '—')}</td><td>${escapeHtml(item.source === 'initial_import' ? 'Import initial' : 'Twitch')}</td></tr>`).join('');
    return res.send(page('Tableau de bord sanctions', `
      <h1>Sanctions de ${escapeHtml(name)}</h1><section class="card"><p>${rows.rowCount} événement(s) affiché(s) — maximum 500, du plus récent au plus ancien.</p><p><a href="/auth/start">Reconnecter / actualiser Twitch</a> <button class="secondary" onclick="location.reload()">Actualiser</button></p></section>
      <div class="scroll"><table><thead><tr><th>Date</th><th>Modérateur</th><th>Utilisateur</th><th>Action</th><th>Durée</th><th>Raison</th><th>Source</th></tr></thead><tbody>${tableRows || '<tr><td colspan="7">Aucune sanction enregistrée pour le moment.</td></tr>'}</tbody></table></div>
    `));
  } catch (error) {
    console.error(error.message);
    return res.status(500).send(page('Erreur', `<h1>Impossible de charger le tableau de bord</h1><p>${escapeHtml(error.message)}</p>`));
  }
});

app.get('/api/events', requireAdmin, async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
  const result = await pool.query(`SELECT * FROM moderation_events ORDER BY occurred_at DESC LIMIT $1`, [limit]);
  res.json(result.rows);
});

app.use((_req, res) => res.status(404).send(page('Page introuvable', '<h1>Page introuvable</h1><a href="/">Accueil</a>')));

const port = Number(process.env.PORT) || 3000;
initializeDatabase().then(() => {
  app.listen(port, '0.0.0.0', () => console.log(`Moderation dashboard listening on port ${port}`));
}).catch((error) => {
  console.error('Database initialization failed:', error.message);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});
