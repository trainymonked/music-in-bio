# music-in-bio

A small Node.js app that updates your personal Telegram profile description (**Bio/About**) with your currently playing track from:

- **Last.fm** (recommended, easiest setup), or
- **Spotify** (Web API).

## Features

- Sync now playing track from Last.fm or Spotify to your Telegram bio.
- Keep your own custom bio text and append music after it.
- Detect manual bio edits in Telegram and keep using your new text as the base.
- Optional clearing of only the music part when playback stops.
- Truncate output to Telegram bio length limits.

Example composed bio:

```text
25 y.o. designer from San Francisco | 🎧 Anya Nami — Wake Me Up
```
