import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, mkdir, writeFile, rename, chmod, unlink, stat } from 'node:fs/promises';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { SUPPORTED_PLATFORMS } from './social-icons.mjs';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const dataDir = process.env.DATA_DIR || '/data';
const profileFile = join(dataDir, 'profile.json');
const uploadsDir = join(dataDir, 'uploads');
const sessionSecretFile = join(dataDir, 'session-secret');
const steamTokenFile = join(dataDir, 'steam-bridge-token');
const steamPresenceFile = join(dataDir, 'steam-presence.json');
const systemStatsFile = join(dataDir, 'system-stats.json');
const systemMonitorTokenFile = join(dataDir, 'system-monitor-token');
const spotifyPresenceFile = join(dataDir, 'spotify-presence.json');
const discordBotTokenFile = join(dataDir, 'discord-bot-token');
const twitchConfigFile = join(dataDir, 'twitch-app.json');
const adminPassword = process.env.ADMIN_PASSWORD || '';
const sessionLifetime = 8 * 60 * 60 * 1000;
const loginAttempts = new Map();
let twitchAccessToken = '';
let twitchTokenExpiresAt = 0;
let twitchLiveCache = { channel: '', expiresAt: 0, data: null };
let discordGatewaySocket = null;
let discordGatewayHeartbeat = null;
let discordGatewayReconnect = null;
let discordGatewayGeneration = 0;
let discordGatewayReady = false;
let discordGatewayConfigured = false;
let discordGatewayError = 'Discord bot is not configured.';
let discordGatewaySequence = null;
let discordGatewayRetryDelay = 5000;
let discordGatewayPresence = { userId: '', status: 'unknown', activities: [], receivedAt: 0 };
const environmentDiscordId = /^\d{17,20}$/.test(process.env.DISCORD_ID || '') ? process.env.DISCORD_ID : '';

const defaultProfile = {
  displayName: 'Purple', pageTitle: '', handle: '@purple', pronouns: '', status: 'around & making things',
  embedTitle: '', embedDescription: '', twitchChannel: '',
  showStatus: true,
  showSystemMonitor: true,
  systemMonitorSetupUrl: '',
  bio: 'Add a short intro in your admin page.', avatarText: 'Z', avatarUrl: '', backgroundUrl: '', backgroundVideoUrl: '', discordPresenceImageUrl: '', iconUrl: '', discordId: environmentDiscordId, discordUsername: 'hugehitboxirl',
  footerText: 'made with a little bit of internet magic ✳',
  topLabel: 'personal space / 001', linksHeading: 'find me elsewhere', linkLayout: 'vertical',
  linkLayout: 'vertical',
  accent: '#a78bfa', highlight: '#7ce7c2', onlineStatusColor: '#5cf0b2', offlineStatusColor: '#f08080', pageBackgroundColor: '#090a0f', cardColor: '#13141d', cardOpacity: 78,
  gradientColor1: '#282047', gradientColor2: '#12251e', chips: [], links: []
};

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders });
  res.end(JSON.stringify(data));
}

function text(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders });
  res.end(value);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) {
    const pad = Buffer.alloc(a.length);
    timingSafeEqual(a, pad);
    return false;
  }
  return timingSafeEqual(a, b);
}

async function getSessionSecret() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  try { return (await readFile(sessionSecretFile, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const secret = randomBytes(32).toString('hex');
    try { await writeFile(sessionSecretFile, secret, { flag: 'wx', mode: 0o600 }); }
    catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
    await chmod(sessionSecretFile, 0o600);
    return (await readFile(sessionSecretFile, 'utf8')).trim();
  }
}

function cookieValue(req, key) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === key) return value.join('=');
  }
  return '';
}

function makeSession(secret) {
  const payload = Buffer.from(JSON.stringify({ expires: Date.now() + sessionLifetime, nonce: randomBytes(8).toString('hex') })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function validSession(req, secret) {
  const value = cookieValue(req, 'bio_admin');
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).expires > Date.now(); }
  catch { return false; }
}

function trustedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || !req.headers.host) return false;
  try {
    const parsed = new URL(origin);
    const forwardedProto = req.headers['x-forwarded-proto'] || 'http';
    return parsed.host === req.headers.host && parsed.protocol === `${forwardedProto}:`;
  } catch { return false; }
}

async function bodyJson(req, limit = 64_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('Request is too large.');
  }
  try { return JSON.parse(body || '{}'); }
  catch { throw new Error('Invalid request data.'); }
}

async function bodyBuffer(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('Videos must be 100 MiB or smaller.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function getProfile() {
  try { return { ...defaultProfile, ...JSON.parse(await readFile(profileFile, 'utf8')) }; }
  catch (error) { if (error.code === 'ENOENT') return { ...defaultProfile }; throw error; }
}

async function getSteamToken() {
  try { return (await readFile(steamTokenFile, 'utf8')).trim(); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function getSystemMonitorToken() {
  try { return (await readFile(systemMonitorTokenFile, 'utf8')).trim(); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function getSteamPresence() {
  try {
    const presence = JSON.parse(await readFile(steamPresenceFile, 'utf8'));
    const connected = Number.isFinite(presence.updatedAt) && Date.now() - presence.updatedAt < 75_000;
    return { connected, online: connected && typeof presence.online === 'boolean' ? presence.online : null, playing: connected && presence.playing === true, game: connected && presence.playing ? presence.game : '', gameId: connected && presence.playing ? presence.gameId : '', startedAt: connected && presence.playing ? presence.startedAt : 0, updatedAt: connected ? presence.updatedAt : 0, avatarUrl: connected ? (presence.avatarUrl || '') : '', steamStatus: connected ? (presence.steamStatus || '') : '' };
  } catch (error) { if (error.code === 'ENOENT') return { connected: false, online: null, playing: false, game: '', gameId: '', startedAt: 0, updatedAt: 0, avatarUrl: '', steamStatus: '' }; throw error; }
}

async function getSystemStats() {
  try {
    const stats = JSON.parse(await readFile(systemStatsFile, 'utf8'));
    const connected = Number.isFinite(stats.updatedAt) && Date.now() - stats.updatedAt < 30_000;
    return connected ? { ...stats, connected: true } : { connected: false, updatedAt: 0 };
  } catch (error) {
    if (error.code === 'ENOENT') return { connected: false, updatedAt: 0 };
    throw error;
  }
}

async function getSpotifyPresence() {
  try {
    const presence = JSON.parse(await readFile(spotifyPresenceFile, 'utf8'));
    const connected = Number.isFinite(presence.updatedAt) && Date.now() - presence.updatedAt < 75_000;
    return { connected, playing: connected && presence.playing === true, song: connected && presence.playing ? presence.song : '', artist: connected && presence.playing ? presence.artist : '', album: connected && presence.playing ? presence.album : '', albumArtUrl: connected && presence.playing ? presence.albumArtUrl : '', spotifyUrl: connected && presence.playing ? presence.spotifyUrl : '', updatedAt: connected ? presence.updatedAt : 0 };
  } catch (error) { if (error.code === 'ENOENT') return { connected: false, playing: false, song: '', artist: '', album: '', albumArtUrl: '', spotifyUrl: '', updatedAt: 0 }; throw error; }
}

function stopDiscordGateway() {
  discordGatewayGeneration++;
  if (discordGatewayHeartbeat) clearInterval(discordGatewayHeartbeat);
  if (discordGatewayReconnect) clearTimeout(discordGatewayReconnect);
  discordGatewayHeartbeat = null;
  discordGatewayReconnect = null;
  discordGatewayReady = false;
  const socket = discordGatewaySocket;
  discordGatewaySocket = null;
  try { if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Configuration changed'); } catch {}
}

function cleanDiscordPresence(presence) {
  const rawStatus = String(presence.status || 'offline');
  const status = ['online', 'idle', 'dnd', 'offline'].includes(rawStatus) ? rawStatus : 'offline';
  const activities = Array.isArray(presence.activities) ? presence.activities.slice(0, 8).map(activity => ({
    name: cleanText(activity.name, 100), details: cleanText(activity.details, 160), state: cleanText(activity.state, 160), type: Number.isInteger(activity.type) ? activity.type : 0
  })).filter(activity => activity.name) : [];
  return { userId: String(presence.user?.id || ''), status, activities, receivedAt: Date.now() };
}

async function captureDiscordPresence(presence) {
  const profile = await getProfile();
  const userId = String(presence.user?.id || '');
  if (!userId || userId !== profile.discordId) return;
  discordGatewayPresence = cleanDiscordPresence(presence);
}

function connectDiscordGateway(token, generation) {
  if (generation !== discordGatewayGeneration) return;
  if (typeof WebSocket === 'undefined') {
    discordGatewayError = 'This Node.js version does not provide WebSocket support.';
    return;
  }
  discordGatewayError = 'Connecting to Discord…';
  let socket;
  try { socket = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json'); }
  catch { discordGatewayError = 'Could not open a connection to Discord.'; scheduleDiscordReconnect(token, generation); return; }
  discordGatewaySocket = socket;
  let heartbeatAcknowledged = true;

  socket.addEventListener('open', () => {
    if (generation === discordGatewayGeneration) discordGatewayError = 'Connected to Discord; waiting for the gateway handshake.';
  });
  socket.addEventListener('message', event => {
    if (generation !== discordGatewayGeneration) return;
    let packet;
    try { packet = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); }
    catch { return; }
    if (packet.s !== null && packet.s !== undefined) discordGatewaySequence = packet.s;

    if (packet.op === 10) {
      const heartbeatMs = Math.max(1000, Number(packet.d?.heartbeat_interval) || 41250);
      if (discordGatewayHeartbeat) clearInterval(discordGatewayHeartbeat);
      const heartbeat = () => {
        if (generation !== discordGatewayGeneration || socket.readyState !== WebSocket.OPEN) return;
        if (!heartbeatAcknowledged) { socket.close(4000, 'Heartbeat acknowledgement timed out'); return; }
        heartbeatAcknowledged = false;
        socket.send(JSON.stringify({ op: 1, d: discordGatewaySequence }));
      };
      discordGatewayHeartbeat = setInterval(heartbeat, heartbeatMs);
      socket.send(JSON.stringify({ op: 2, d: { token, intents: 257, properties: { os: 'linux', browser: 'personal-bio', device: 'personal-bio' } } }));
      return;
    }
    if (packet.op === 11) { heartbeatAcknowledged = true; return; }
    if (packet.op === 1) {
      heartbeatAcknowledged = false;
      socket.send(JSON.stringify({ op: 1, d: discordGatewaySequence }));
      return;
    }
    if (packet.op === 7) { socket.close(4001, 'Discord requested reconnect'); return; }
    if (packet.op === 9) { discordGatewayError = 'Discord reset the bot session; reconnecting.'; socket.close(4001, 'Invalid session'); return; }
    if (packet.op !== 0) return;

    const eventName = packet.t;
    const data = packet.d || {};
    if (eventName === 'READY') {
      discordGatewayReady = true;
      discordGatewayError = '';
      discordGatewayRetryDelay = 5000;
    } else if (eventName === 'PRESENCE_UPDATE') {
      void captureDiscordPresence(data).catch(() => {});
    } else if (eventName === 'GUILD_CREATE' && Array.isArray(data.presences)) {
      for (const presence of data.presences) void captureDiscordPresence(presence).catch(() => {});
    }
  });
  socket.addEventListener('error', () => {
    if (generation === discordGatewayGeneration) discordGatewayError = 'Could not connect to Discord Gateway.';
  });
  socket.addEventListener('close', event => {
    if (generation !== discordGatewayGeneration) return;
    if (discordGatewayHeartbeat) clearInterval(discordGatewayHeartbeat);
    discordGatewayHeartbeat = null;
    discordGatewaySocket = null;
    discordGatewayReady = false;
    if (event.code === 4004) discordGatewayError = 'Discord rejected the bot token. Check the token in admin.';
    else if (event.code === 4013 || event.code === 4014) discordGatewayError = 'Discord rejected the bot intents. Enable Presence Intent in the Developer Portal.';
    else if (!discordGatewayError || discordGatewayError.startsWith('Connected')) discordGatewayError = 'Discord connection closed; reconnecting.';
    scheduleDiscordReconnect(token, generation);
  });
}

function scheduleDiscordReconnect(token, generation) {
  if (generation !== discordGatewayGeneration || discordGatewayReconnect) return;
  const delay = discordGatewayRetryDelay;
  discordGatewayRetryDelay = Math.min(discordGatewayRetryDelay * 2, 60000);
  discordGatewayReconnect = setTimeout(() => {
    discordGatewayReconnect = null;
    connectDiscordGateway(token, generation);
  }, delay);
}

function startDiscordGateway(token) {
  stopDiscordGateway();
  discordGatewayConfigured = Boolean(token);
  discordGatewayPresence = { userId: '', status: 'unknown', activities: [], receivedAt: 0 };
  discordGatewayRetryDelay = 5000;
  if (!token) { discordGatewayError = 'Discord bot is not configured.'; return; }
  connectDiscordGateway(token, discordGatewayGeneration);
}

async function getDiscordPresence() {
  const profile = await getProfile();
  const targetSeen = Boolean(profile.discordId && discordGatewayPresence.userId === profile.discordId && discordGatewayPresence.receivedAt);
  return { configured: discordGatewayConfigured, connected: discordGatewayReady, targetSeen, status: targetSeen ? discordGatewayPresence.status : 'unknown', activities: targetSeen ? discordGatewayPresence.activities : [] };
}

function getDiscordBotAdminStatus() {
  return { configured: discordGatewayConfigured, connected: discordGatewayReady, targetSeen: Boolean(discordGatewayPresence.receivedAt), error: discordGatewayError };
}

async function initializeDiscordGateway() {
  try {
    const token = (await readFile(discordBotTokenFile, 'utf8')).trim();
    if (token) startDiscordGateway(token);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not load Discord bot configuration:', error.message);
  }
}

async function getTwitchConfig() {
  try { return JSON.parse(await readFile(twitchConfigFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function getTwitchLiveState(channel) {
  const config = await getTwitchConfig();
  if (!config?.clientId || !config?.clientSecret) return { configured: false, online: false };
  if (twitchLiveCache.channel === channel && twitchLiveCache.expiresAt > Date.now() && twitchLiveCache.data) return twitchLiveCache.data;
  if (!channel) return { configured: true, online: false };
  if (!twitchAccessToken || twitchTokenExpiresAt < Date.now() + 60_000) {
    const params = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'client_credentials' });
    const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params, signal: AbortSignal.timeout(10000) });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) throw new Error('Could not connect to Twitch. Check the Twitch app credentials in admin.');
    twitchAccessToken = tokenData.access_token;
    twitchTokenExpiresAt = Date.now() + Number(tokenData.expires_in || 0) * 1000;
  }
  const streamUrl = new URL('https://api.twitch.tv/helix/streams');
  streamUrl.searchParams.set('user_login', channel);
  const response = await fetch(streamUrl, { headers: { 'Client-Id': config.clientId, Authorization: `Bearer ${twitchAccessToken}` }, signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok) {
    twitchAccessToken = '';
    throw new Error('Twitch could not confirm the live status. Check the app credentials and channel name.');
  }
  const stream = result.data?.[0];
  const data = stream ? { configured: true, online: true, title: cleanText(stream.title, 140), game: cleanText(stream.game_name, 80), viewers: Number(stream.viewer_count) || 0 } : { configured: true, online: false };
  twitchLiveCache = { channel, expiresAt: Date.now() + 30_000, data };
  return data;
}

function cleanText(value, max) { return String(value ?? '').trim().slice(0, max); }
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }

function validUrl(value) {
  if (!value) return '';
  if (/^\/uploads\/(avatar|background|discord-presence|icon)-[a-f0-9]{24}\.(png|jpg|webp)$/.test(value) || /^\/uploads\/background-video-[a-f0-9]{24}\.(mp4|webm)$/.test(value)) return value;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
}

function identifyImage(mime, bytes) {
  if (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (mime === 'image/jpeg' && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (mime === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return '';
}

function identifyVideo(mime, bytes) {
  if (mime === 'video/mp4' && bytes.length > 12 && bytes.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (mime === 'video/webm' && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  return '';
}

function validateProfile(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid profile data.');
  const color = (value, fallback) => /^#[\da-f]{6}$/i.test(value || '') ? value : fallback;
  const links = Array.isArray(input.links) ? input.links.slice(0, 24).map(item => ({
    title: cleanText(item?.title, 40),
    description: cleanText(item?.description, 80),
    url: validUrl(cleanText(item?.url, 500)),
    platform: SUPPORTED_PLATFORMS.includes(item?.platform) ? item.platform : ''
  })).filter(item => item.url) : [];
  const discordId = cleanText(input.discordId, 20);
  if (discordId && !/^\d{17,20}$/.test(discordId)) throw new Error('Discord ID must be a 17–20 digit number.');
  if (!cleanText(input.displayName, 80)) throw new Error('Please enter a display name.');
  const twitchChannel = cleanText(input.twitchChannel, 25).toLowerCase().replace(/^@/, '');
  if (twitchChannel && !/^[a-z0-9_]+$/.test(twitchChannel)) throw new Error('Enter a Twitch channel name using letters, numbers, and underscores.');
  return {
    displayName: cleanText(input.displayName, 80),
    pageTitle: cleanText(input.pageTitle, 100),
    embedTitle: cleanText(input.embedTitle, 100),
    embedDescription: cleanText(input.embedDescription, 300),
    twitchChannel,
    handle: cleanText(input.handle, 80),
    pronouns: cleanText(input.pronouns, 40),
    status: cleanText(input.status, 60),
    showStatus: input.showStatus !== false,
    showSystemMonitor: input.showSystemMonitor !== false,
    systemMonitorSetupUrl: validUrl(cleanText(input.systemMonitorSetupUrl, 500)),
    bio: cleanText(input.bio, 500),
    footerText: cleanText(input.footerText, 100),
    topLabel: cleanText(input.topLabel, 40),
    linksHeading: cleanText(input.linksHeading, 40),
    linkLayout: input.linkLayout === 'horizontal' ? 'horizontal' : 'vertical',
    linkLayout: input.linkLayout === 'horizontal' ? 'horizontal' : 'vertical',
    avatarText: cleanText(input.avatarText, 3) || 'Z',
    avatarUrl: validUrl(cleanText(input.avatarUrl, 500)),
    backgroundUrl: validUrl(cleanText(input.backgroundUrl, 500)),
    backgroundVideoUrl: validUrl(cleanText(input.backgroundVideoUrl, 500)),
    discordPresenceImageUrl: validUrl(cleanText(input.discordPresenceImageUrl, 500)),
    iconUrl: validUrl(cleanText(input.iconUrl, 500)),
    discordId,
    discordUsername: cleanText(input.discordUsername, 32).replace(/^@/, ''),
    accent: color(input.accent, defaultProfile.accent),
    highlight: color(input.highlight, defaultProfile.highlight),
    onlineStatusColor: color(input.onlineStatusColor, defaultProfile.onlineStatusColor),
    offlineStatusColor: color(input.offlineStatusColor, defaultProfile.offlineStatusColor),
    pageBackgroundColor: color(input.pageBackgroundColor, defaultProfile.pageBackgroundColor),
    cardColor: color(input.cardColor, defaultProfile.cardColor),
    cardOpacity: Number.isFinite(Number(input.cardOpacity)) ? Math.max(20, Math.min(100, Math.round(Number(input.cardOpacity)))) : defaultProfile.cardOpacity,
    gradientColor1: color(input.gradientColor1, defaultProfile.gradientColor1),
    gradientColor2: color(input.gradientColor2, defaultProfile.gradientColor2),
    chips: Array.isArray(input.chips) ? input.chips.slice(0, 8).map(x => cleanText(x, 24)).filter(Boolean) : [],
    links
  };
}

async function saveProfile(profile) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const tempFile = `${profileFile}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tempFile, JSON.stringify(profile, null, 2), { mode: 0o600 });
  await rename(tempFile, profileFile);
  await chmod(profileFile, 0o600);
}

function attemptState(req) {
  const key = req.socket.remoteAddress || 'unknown';
  const state = loginAttempts.get(key) || { count: 0, since: Date.now() };
  if (Date.now() - state.since > 15 * 60_000) { state.count = 0; state.since = Date.now(); }
  return { key, state };
}

if (adminPassword.length < 12 || adminPassword === 'CHANGE_ME_BEFORE_STARTING_APP') {
  console.error('Set ADMIN_PASSWORD to a unique password of at least 12 characters in .env before starting.');
  process.exit(1);
}

const sessionSecret = await getSessionSecret();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const profile = await getProfile();
      const previewTitle = profile.embedTitle || profile.pageTitle || `${profile.displayName || 'Purple'} — links & now playing`;
      const previewDescription = profile.embedDescription || profile.bio || 'A little corner of the internet.';
      const page = (await readFile(new URL('./index.html', import.meta.url), 'utf8'))
        .replaceAll('__BIO_PREVIEW_TITLE__', escapeHtml(previewTitle))
        .replaceAll('__BIO_PREVIEW_DESCRIPTION__', escapeHtml(previewDescription));
      // Start fetching a locally uploaded background video while the HTML is still parsing,
      // so playback does not wait for the module script and the profile request.
      const videoUrl = /^\/uploads\/background-video-[a-f0-9]{24}\.(mp4|webm)$/.test(profile.backgroundVideoUrl || '') ? profile.backgroundVideoUrl : '';
      const headers = videoUrl && req.headers['save-data'] !== 'on'
        ? { link: `<${videoUrl}>; rel=preload; as=video` }
        : {};
      return text(res, 200, page, headers);
    }
    if (req.method === 'GET' && url.pathname === '/admin') {
      return text(res, 200, await readFile(new URL('./admin.html', import.meta.url), 'utf8'), { 'x-robots-tag': 'noindex, nofollow' });
    }
    if (req.method === 'GET' && url.pathname === '/favicon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
      return res.end(await readFile(new URL('./favicon.svg', import.meta.url)));
    }
    if (req.method === 'GET' && url.pathname === '/icon-512.webp') {
      res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
      return res.end(await readFile(new URL('./icon-512.webp', import.meta.url)));
    }
    if (req.method === 'GET' && url.pathname === '/ninja-logo.webp') {
      res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
      return res.end(await readFile(new URL('./ninja-logo.webp', import.meta.url)));
    }
    if (req.method === 'GET' && url.pathname === '/social-icons.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(await readFile(new URL('./social-icons.mjs', import.meta.url)));
    }
    const uploadMatch = url.pathname.match(/^\/uploads\/(avatar|background|discord-presence|icon|background-video)-([a-f0-9]{24})\.(png|jpg|webp|mp4|webm)$/);
    if ((req.method === 'GET' || req.method === 'HEAD') && uploadMatch) {
      const [, kind, name, extension] = uploadMatch;
      const mime = extension === 'jpg' ? 'image/jpeg' : extension === 'mp4' ? 'video/mp4' : extension === 'webm' ? 'video/webm' : `image/${extension}`;
      const file = join(uploadsDir, `${kind}-${name}.${extension}`);
      let size;
      try { size = (await stat(file)).size; }
      catch (error) { if (error.code === 'ENOENT') return text(res, 404, 'Media not found'); throw error; }
      const headers = {
        'content-type': mime,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'accept-ranges': 'bytes'
      };
      const sendFile = (status, start, end) => {
        const streamHeaders = { ...headers, 'content-length': Math.max(0, end - start + 1) };
        if (status === 206) streamHeaders['content-range'] = `bytes ${start}-${end}/${size}`;
        res.writeHead(status, streamHeaders);
        if (req.method === 'HEAD' || size === 0) return res.end();
        const stream = createReadStream(file, { start, end });
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
      };
      const range = String(req.headers.range || '').trim();
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match && (match[1] || match[2])) {
          let start;
          let end;
          if (!match[1]) {
            const suffix = Number(match[2]);
            start = Math.max(0, size - suffix);
            end = size - 1;
          } else {
            start = Number(match[1]);
            end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
          }
          if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) return sendFile(206, start, end);
          res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
          return res.end();
        }
      }
      return sendFile(200, 0, Math.max(0, size - 1));
    }
    if (req.method === 'GET' && url.pathname === '/api/profile') return json(res, 200, await getProfile());
    if (req.method === 'GET' && url.pathname === '/api/steam/presence') return json(res, 200, await getSteamPresence());
    if (req.method === 'GET' && url.pathname === '/api/system/stats') return json(res, 200, await getSystemStats());
    if (req.method === 'GET' && url.pathname === '/api/spotify/presence') return json(res, 200, await getSpotifyPresence());
    if (req.method === 'GET' && url.pathname === '/api/discord/presence') return json(res, 200, await getDiscordPresence());
    if (req.method === 'GET' && url.pathname === '/api/twitch/status') {
      const profile = await getProfile();
      try { return json(res, 200, await getTwitchLiveState(profile.twitchChannel)); }
      catch (error) { return json(res, 502, { configured: true, online: false, error: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/steam/presence') {
      const token = await getSteamToken();
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token || !safeEqual(bearer, token)) return json(res, 401, { error: 'Steam bridge token was not accepted.' });
      const body = await bodyJson(req, 4096);
      if (typeof body.playing !== 'boolean') return json(res, 400, { error: 'Playing status must be true or false.' });
      const previous = await getSteamPresence();
      const now = Date.now();
      const gameId = body.playing ? cleanText(body.gameId, 20) : '';
      const sameSession = body.playing && previous.connected && previous.playing && previous.gameId === gameId && previous.game === cleanText(body.game, 100);
      const presence = { online: typeof body.online === 'boolean' ? body.online : null, playing: body.playing, game: body.playing ? cleanText(body.game, 100) : '', gameId, startedAt: body.playing ? (sameSession && previous.startedAt ? previous.startedAt : now) : 0, updatedAt: now, avatarUrl: cleanText(body.avatarUrl, 500), steamStatus: cleanText(body.steamStatus, 40) };
      if (presence.playing && !presence.game) return json(res, 400, { error: 'Game name is required while playing.' });
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writeFile(steamPresenceFile, JSON.stringify(presence), { mode: 0o600 });
      await chmod(steamPresenceFile, 0o600);
      return json(res, 200, { saved: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/system/stats') {
      const systemToken = await getSystemMonitorToken();
      const steamToken = await getSteamToken();
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const accepted = (systemToken && safeEqual(bearer, systemToken)) || (steamToken && safeEqual(bearer, steamToken));
      if (!accepted) return json(res, 401, { error: 'The system monitor token was not accepted.' });
      const body = await bodyJson(req, 4096);
      const number = (value, max = 1e15) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(max, Math.round(Number(value) * 10) / 10)) : 0;
      const label = (value, max) => cleanText(value, max);
      const stats = {
        hostname: label(body.hostname, 60),
        os: label(body.os, 60),
        cpuModel: label(body.cpuModel, 80),
        gpuName: label(body.gpuName, 80),
        cpuPercent: number(body.cpuPercent, 100),
        cpuTemp: number(body.cpuTemp, 200),
        gpuPercent: number(body.gpuPercent, 100),
        gpuTemp: number(body.gpuTemp, 200),
        ramUsedBytes: number(body.ramUsedBytes),
        ramTotalBytes: number(body.ramTotalBytes),
        swapUsedBytes: number(body.swapUsedBytes),
        swapTotalBytes: number(body.swapTotalBytes),
        gpuVramUsedBytes: number(body.gpuVramUsedBytes),
        gpuVramTotalBytes: number(body.gpuVramTotalBytes),
        diskUsedBytes: number(body.diskUsedBytes),
        diskTotalBytes: number(body.diskTotalBytes),
        netRxBytesPerSec: number(body.netRxBytesPerSec),
        netTxBytesPerSec: number(body.netTxBytesPerSec),
        uptimeSeconds: number(body.uptimeSeconds, 1e10),
        load1: number(body.load1, 1000),
        updatedAt: Date.now()
      };
      if (!stats.ramTotalBytes && !stats.cpuPercent) return json(res, 400, { error: 'Send at least CPU or memory usage.' });
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writeFile(systemStatsFile, JSON.stringify(stats), { mode: 0o600 });
      await chmod(systemStatsFile, 0o600);
      return json(res, 200, { saved: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/spotify/presence') {
      const token = await getSteamToken();
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token || !safeEqual(bearer, token)) return json(res, 401, { error: 'Presence bridge token was not accepted.' });
      const body = await bodyJson(req, 4096);
      if (typeof body.playing !== 'boolean') return json(res, 400, { error: 'Playing status must be true or false.' });
      const art = String(body.albumArtUrl || '');
      const albumArtUrl = /^https:\/\/i\.scdn\.co\//i.test(art) ? art.slice(0, 1000) : '';
      const spotifyUrl = String(body.spotifyUrl || '');
      const validSpotifyUrl = /^https:\/\/open\.spotify\.com\/(track|episode)\/[A-Za-z0-9]+$/i.test(spotifyUrl) ? spotifyUrl : '';
      const presence = { playing: body.playing, song: body.playing ? cleanText(body.song, 160) : '', artist: body.playing ? cleanText(body.artist, 200) : '', album: body.playing ? cleanText(body.album, 200) : '', albumArtUrl: body.playing ? albumArtUrl : '', spotifyUrl: body.playing ? validSpotifyUrl : '', updatedAt: Date.now() };
      if (presence.playing && !presence.song) return json(res, 400, { error: 'Track title is required while playing.' });
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writeFile(spotifyPresenceFile, JSON.stringify(presence), { mode: 0o600 });
      await chmod(spotifyPresenceFile, 0o600);
      return json(res, 200, { saved: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/session') return json(res, 200, { authenticated: validSession(req, sessionSecret) });
    if (req.method === 'GET' && url.pathname === '/api/admin/discord-bot') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      return json(res, 200, getDiscordBotAdminStatus());
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/discord-bot') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      if (!trustedOrigin(req)) return json(res, 403, { error: 'Request origin was not accepted.' });
      const token = cleanText((await bodyJson(req, 4096)).token, 500);
      if (!token) return json(res, 400, { error: 'Paste the bot token from your Discord Developer Portal.' });
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writeFile(discordBotTokenFile, token, { mode: 0o600 });
      await chmod(discordBotTokenFile, 0o600);
      startDiscordGateway(token);
      return json(res, 200, { configured: true });
    }
    if (req.method === 'DELETE' && url.pathname === '/api/admin/discord-bot') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      if (!trustedOrigin(req)) return json(res, 403, { error: 'Request origin was not accepted.' });
      stopDiscordGateway();
      discordGatewayConfigured = false;
      discordGatewayPresence = { userId: '', status: 'unknown', activities: [], receivedAt: 0 };
      discordGatewayError = 'Discord bot is not configured.';
      try { await unlink(discordBotTokenFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return json(res, 200, { configured: false });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      if (!trustedOrigin(req)) return json(res, 403, { error: 'Request origin was not accepted.' });
      const { key, state } = attemptState(req);
      if (state.count >= 8) return json(res, 429, { error: 'Too many attempts. Wait 15 minutes and try again.' });
      const body = await bodyJson(req);
      if (!safeEqual(body.password || '', adminPassword)) {
        state.count += 1;
        loginAttempts.set(key, state);
        return json(res, 401, { error: 'That password did not match.' });
      }
      loginAttempts.delete(key);
      const session = makeSession(sessionSecret);
      return json(res, 200, { authenticated: true }, { 'set-cookie': `bio_admin=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}` });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
      if (!trustedOrigin(req)) return json(res, 403, { error: 'Request origin was not accepted.' });
      return json(res, 200, { authenticated: false }, { 'set-cookie': 'bio_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/upload') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      if (!trustedOrigin(req)) return json(res, 403, { error: 'Request origin was not accepted.' });
      const { kind, dataUrl } = await bodyJson(req, 22 * 1024 * 1024);
      const video = kind === 'background-video';
      if (!video && !['avatar', 'background', 'discord-presence', 'icon'].includes(kind)) return json(res, 400, { error: 'Choose an avatar, background image, Discord presence image, background video, or icon.' });
      const match = new RegExp(video ? '^data:(video/mp4|video/webm);base64,([A-Za-z0-9+/=]+)$' : '^data:(image/png|image/jpeg|image/webp);base64,([A-Za-z0-9+/=]+)$').exec(dataUrl || '');
      if (!match) return json(res, 400, { error: video ? 'Use an MP4 or WebM video.' : 'Use a PNG, JPG, or WebP image.' });
      const bytes = Buffer.from(match[2], 'base64');
      const maxBytes = video ? 15 * 1024 * 1024 : 5 * 1024 * 1024;
      if (!bytes.length || bytes.length > maxBytes) return json(res, 400, { error: video ? 'Videos must be 15 MB or smaller.' : 'Images must be 5 MB or smaller.' });
      const extension = video ? identifyVideo(match[1], bytes) : identifyImage(match[1], bytes);
      if (!extension) return json(res, 400, { error: 'That file does not match its media type.' });
      await mkdir(uploadsDir, { recursive: true, mode: 0o755 });
      const filename = `${kind}-${randomBytes(12).toString('hex')}.${extension}`;
      await writeFile(join(uploadsDir, filename), bytes, { mode: 0o644, flag: 'wx' });
      return json(res, 201, { url: `/uploads/${filename}` });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/upload-video') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      if (!trustedOrigin(req)) return json(res, 403, { error: 'Request origin was not accepted.' });
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!['video/mp4', 'video/webm'].includes(mime)) return json(res, 400, { error: 'Use an MP4 or WebM video.' });
      const bytes = await bodyBuffer(req, 100 * 1024 * 1024);
      const extension = identifyVideo(mime, bytes);
      if (!extension) return json(res, 400, { error: 'That file does not match its video type.' });
      await mkdir(uploadsDir, { recursive: true, mode: 0o755 });
      const filename = `background-video-${randomBytes(12).toString('hex')}.${extension}`;
      await writeFile(join(uploadsDir, filename), bytes, { mode: 0o644, flag: 'wx' });
      return json(res, 201, { url: `/uploads/${filename}` });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/profile') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      return json(res, 200, await getProfile());
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/steam-token') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      return json(res, 200, { configured: Boolean(await getSteamToken()) });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/twitch-config') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      return json(res, 200, { configured: Boolean(await getTwitchConfig()) });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/twitch-config') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      if (!trustedOrigin(req)) return json(res, 403, { error: 'Request origin was not accepted.' });
      const body = await bodyJson(req, 4096);
      const clientId = cleanText(body.clientId, 100);
      const clientSecret = cleanText(body.clientSecret, 200);
      if (!clientId || !clientSecret) return json(res, 400, { error: 'Enter both the Twitch Client ID and Client Secret.' });
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writeFile(twitchConfigFile, JSON.stringify({ clientId, clientSecret }), { mode: 0o600 });
      await chmod(twitchConfigFile, 0o600);
      twitchAccessToken = '';
      twitchTokenExpiresAt = 0;
      twitchLiveCache = { channel: '', expiresAt: 0, data: null };
      return json(res, 200, { configured: true });
    }
    if (req.method === 'DELETE' && url.pathname === '/api/admin/twitch-config') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      if (!trustedOrigin(req)) return json(res, 403, { error: 'Request origin was not accepted.' });
      try { await unlink(twitchConfigFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      twitchAccessToken = '';
      twitchTokenExpiresAt = 0;
      twitchLiveCache = { channel: '', expiresAt: 0, data: null };
      return json(res, 200, { configured: false });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/steam-token') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      if (!trustedOrigin(req)) return json(res, 403, { error: 'Request origin was not accepted.' });
      const token = randomBytes(32).toString('base64url');
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writeFile(steamTokenFile, token, { mode: 0o600 });
      await chmod(steamTokenFile, 0o600);
      try { await unlink(steamPresenceFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await unlink(spotifyPresenceFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await unlink(systemStatsFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return json(res, 200, { token });
    }
    if (req.method === 'DELETE' && url.pathname === '/api/admin/steam-token') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      if (!trustedOrigin(req)) return json(res, 403, { error: 'Request origin was not accepted.' });
      try { await unlink(steamTokenFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await unlink(steamPresenceFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await unlink(spotifyPresenceFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await unlink(systemStatsFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return json(res, 200, { revoked: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/system-token') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      return json(res, 200, { configured: Boolean(await getSystemMonitorToken()) });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/system-token') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      if (!trustedOrigin(req)) return json(res, 403, { error: 'Request origin was not accepted.' });
      const token = randomBytes(32).toString('base64url');
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writeFile(systemMonitorTokenFile, token, { mode: 0o600 });
      await chmod(systemMonitorTokenFile, 0o600);
      try { await unlink(systemStatsFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return json(res, 200, { token });
    }
    if (req.method === 'DELETE' && url.pathname === '/api/admin/system-token') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      if (!trustedOrigin(req)) return json(res, 403, { error: 'Request origin was not accepted.' });
      try { await unlink(systemMonitorTokenFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await unlink(systemStatsFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return json(res, 200, { revoked: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/uploads') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      let names = [];
      try { names = await readdir(uploadsDir); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const media = names.map(name => {
        const match = /^(avatar|background|discord-presence|icon|background-video)-[a-f0-9]{24}\.(png|jpg|webp|mp4|webm)$/.exec(name);
        return match ? { kind: match[1], url: `/uploads/${name}` } : null;
      }).filter(Boolean);
      return json(res, 200, { media });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/uploads/')) {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      if (!trustedOrigin(req)) return json(res, 403, { error: 'Request origin was not accepted.' });
      const match = /^\/api\/admin\/uploads\/((?:avatar|background|discord-presence|icon|background-video)-[a-f0-9]{24}\.(?:png|jpg|webp|mp4|webm))$/.exec(url.pathname);
      if (!match) return json(res, 400, { error: 'That uploaded file name is not valid.' });
      const filename = match[1];
      const profile = await getProfile();
      const activeMedia = [profile.avatarUrl, profile.backgroundUrl, profile.backgroundVideoUrl, profile.discordPresenceImageUrl, profile.iconUrl];
      if (activeMedia.includes(`/uploads/${filename}`)) return json(res, 409, { error: 'This file is in use on your page. Clear its field and save changes before deleting it.' });
      try { await unlink(join(uploadsDir, filename)); }
      catch (error) { if (error.code === 'ENOENT') return json(res, 404, { error: 'That uploaded file was not found.' }); throw error; }
      return json(res, 200, { deleted: true });
    }
    if (req.method === 'PUT' && url.pathname === '/api/admin/profile') {
      if (!validSession(req, sessionSecret)) return json(res, 401, { error: 'Please log in again.' });
      if (!trustedOrigin(req)) return json(res, 403, { error: 'Request origin was not accepted.' });
      const previousProfile = await getProfile();
      const profile = validateProfile(await bodyJson(req));
      await saveProfile(profile);
      if (profile.discordId !== previousProfile.discordId) discordGatewayPresence = { userId: '', status: 'unknown', activities: [], receivedAt: 0 };
      return json(res, 200, { saved: true });
    }
    return text(res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    return json(res, 400, { error: error.message || 'Request failed.' });
  }
});

server.listen(port, host, () => {
  console.log(`Bio page listening on http://${host}:${port}`);
  void initializeDiscordGateway();
});
