import 'dotenv/config'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

const REQUIRED_TELEGRAM_VARS = ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_SESSION_STRING']

for (const key of REQUIRED_TELEGRAM_VARS) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`)
    process.exit(1)
  }
}

const source = (process.env.SOURCE ?? 'lastfm').toLowerCase()
const pollIntervalMs = Number(process.env.POLL_INTERVAL_SEC ?? 20) * 1000
const clearWhenNotPlaying = (process.env.CLEAR_WHEN_NOT_PLAYING ?? 'false').toLowerCase() === 'true'
const bioPrefix = '🎧 '
const bioSuffix = ''
// const bioPrefix = process.env.BIO_PREFIX ?? '🎧 '
// const bioSuffix = process.env.BIO_SUFFIX ?? ''
const maxBioLength = Number(process.env.MAX_BIO_LENGTH ?? 70)

const telegramApiId = Number(process.env.TELEGRAM_API_ID)
const telegramApiHash = process.env.TELEGRAM_API_HASH
const telegramSession = new StringSession(process.env.TELEGRAM_SESSION_STRING)

let spotifyAccessToken = process.env.SPOTIFY_ACCESS_TOKEN ?? null
let lastAppliedMusicSegment = null

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function truncate(input, maxLength) {
  if (input.length <= maxLength) return input
  if (maxLength <= 1) return '…'
  return `${input.slice(0, maxLength - 1)}…`
}

function buildMusicSegment(track) {
  const body = `${track.artist} — ${track.title}`
  return `${bioPrefix}${body}${bioSuffix}`.trim()
}

function buildComposedBio(baseBio, musicSegment) {
  if (!musicSegment) return truncate(baseBio, maxBioLength)
  if (!baseBio) return truncate(musicSegment, maxBioLength)
  return truncate(`${baseBio.trim()} ${musicSegment}`, maxBioLength)
}

function isLikelyMusicSegment(segment) {
  if (!segment) return false
  if (lastAppliedMusicSegment && segment === lastAppliedMusicSegment) return true

  const trimmed = segment.trim()
  const prefix = bioPrefix.trim()
  const suffix = bioSuffix.trim()

  if (prefix && !trimmed.startsWith(prefix)) return false
  if (suffix && !trimmed.endsWith(suffix)) return false

  return trimmed.includes('—')
}

function extractBaseBio(currentBio) {
  if (!currentBio) return ''

  if (isLikelyMusicSegment(currentBio)) {
    return ''
  }

  if (lastAppliedMusicSegment && currentBio.endsWith(lastAppliedMusicSegment)) {
    return currentBio.slice(0, -lastAppliedMusicSegment.length)
  }

  const prefix = bioPrefix.trim()
  let searchFrom = currentBio.length

  while (prefix && searchFrom > 0) {
    const prefixIndex = currentBio.lastIndexOf(prefix, searchFrom - 1)
    if (prefixIndex === -1) break

    const baseCandidate = currentBio.slice(0, prefixIndex)
    const suffixCandidate = currentBio.slice(prefixIndex)

    if (isLikelyMusicSegment(suffixCandidate)) {
      return baseCandidate
    }

    searchFrom = prefixIndex
  }

  return currentBio
}

async function getNowPlayingFromLastFm() {
  const apiKey = process.env.LASTFM_API_KEY
  const username = process.env.LASTFM_USERNAME

  if (!apiKey || !username) {
    throw new Error('LASTFM_API_KEY and LASTFM_USERNAME are required for SOURCE=lastfm')
  }

  const params = new URLSearchParams({
    method: 'user.getrecenttracks',
    user: username,
    api_key: apiKey,
    format: 'json',
    limit: '1',
  })

  const response = await fetch(`https://ws.audioscrobbler.com/2.0/?${params.toString()}`)

  if (!response.ok) {
    throw new Error(`Last.fm API error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()
  const track = data?.recenttracks?.track?.[0]
  const isNowPlaying = track?.['@attr']?.nowplaying === 'true'

  if (!track || !isNowPlaying) return null

  return {
    artist: track.artist?.['#text'] ?? 'Unknown artist',
    title: track.name ?? 'Unknown track',
  }
}

async function refreshSpotifyToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and SPOTIFY_REFRESH_TOKEN are required when SPOTIFY_ACCESS_TOKEN is not provided',
    )
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const payload = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: payload,
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Spotify token refresh failed: ${response.status} ${message}`)
  }

  const data = await response.json()
  spotifyAccessToken = data.access_token
}

async function getNowPlayingFromSpotify() {
  if (!spotifyAccessToken) {
    await refreshSpotifyToken()
  }

  let response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${spotifyAccessToken}` },
  })

  if (response.status === 401) {
    await refreshSpotifyToken()
    response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${spotifyAccessToken}` },
    })
  }

  if (response.status === 204) return null

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Spotify API error: ${response.status} ${message}`)
  }

  const data = await response.json()

  if (!data?.is_playing || !data?.item) return null

  return {
    artist: data.item.artists?.map(a => a.name).join(', ') ?? 'Unknown artist',
    title: data.item.name ?? 'Unknown track',
  }
}

async function getNowPlaying() {
  if (source === 'lastfm') return getNowPlayingFromLastFm()
  if (source === 'spotify') return getNowPlayingFromSpotify()
  throw new Error(`Unsupported SOURCE: ${source}. Use "lastfm" or "spotify".`)
}

async function getCurrentBio(client) {
  const result = await client.invoke(
    new Api.users.GetFullUser({
      id: new Api.InputUserSelf(),
    }),
  )

  return result.fullUser.about ?? ''
}

async function updateBio(client, nextBio) {
  await invokeWithReconnect(
    client,
    new Api.account.UpdateProfile({
      about: nextBio,
    }),
  )
}

function shouldReconnect(error) {
  const message = String(error?.message ?? '').toUpperCase()
  return message.includes('CONNECTION_NOT_INITED') || message.includes('CLIENT_HAS_BEEN_DISCONNECTED')
}

async function connectTelegram(client, reason = 'startup') {
  if (client.connected) return
  await client.connect()
  console.log(`Connected to Telegram (${reason})`)
}


async function invokeWithReconnect(client, request) {
  try {
    await connectTelegram(client)
    return await client.invoke(request)
  } catch (error) {
    if (!shouldReconnect(error)) throw error

    console.warn(`[${new Date().toISOString()}] Telegram connection issue detected (${error.message}). Reconnecting...`)
    try {
      await client.disconnect()
    } catch {
      // Ignore disconnect errors; reconnect attempt below is what matters.
    }
    await connectTelegram(client, 'after reconnect')
    return client.invoke(request)
  }
}

async function main() {
  const client = new TelegramClient(telegramSession, telegramApiId, telegramApiHash, {
    connectionRetries: 5,
  })

  await connectTelegram(client)

  while (true) {
    try {
      const currentBio = await getCurrentBio(client)
      const baseBio = extractBaseBio(currentBio)
      const track = await getNowPlaying()

      if (!track && !clearWhenNotPlaying) {
        console.log('No active track. Bio unchanged.')
        lastAppliedMusicSegment = null
        await sleep(pollIntervalMs)
        continue
      }

      const musicSegment = track ? buildMusicSegment(track) : null
      const nextBio = buildComposedBio(baseBio, musicSegment)

      if (nextBio === currentBio) {
        console.log(`No change: "${nextBio}"`)
      } else {
        await updateBio(client, nextBio)
        console.log(`Bio updated: "${nextBio}"`)
      }

      lastAppliedMusicSegment = musicSegment
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ${error.message}`)
    }

    await sleep(pollIntervalMs)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
