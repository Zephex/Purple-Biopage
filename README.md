# Personal bio page

The app serves a responsive profile page and a private editor at `https://example.com/admin`. The editor lets you update your display name, handle, pronouns, status, bio, avatar, page background, browser tab icon, accent colors, tags, social links, per-link icons, Discord ID and friend username, private Discord presence bot settings, browser tab title, social link preview title and description, footer message, top page label, links section heading, system monitor visibility, and a Short status Enabled/Disabled switch. The public Discord username and profile handle copy to the clipboard when clicked. Link titles and descriptions are editable per link; a compact icon picker lets you select an icon visually. Up to 24 link cards can be shown. When every link is icon-only, the page uses an eight-column desktop grid and adapts to four columns on narrow phones. Drag links by their handle or use the up/down arrows to arrange them; click **Save changes** to keep the order. The icon chooser has a search field. The Uploads panel keeps avatar, background image, looping background video, custom Discord activity picture, and browser icon controls together. You can upload PNG, JPG, or WebP images up to 5 MB and MP4 or WebM videos up to 100 MiB, choose saved files, or delete unused uploads. A video background is muted and loops automatically. Profile changes and uploads are stored in the persistent Docker volume, so they survive rebuilds and container replacement.

## Login setup

Set `ADMIN_PASSWORD` in the VPS `.env` file before starting the app. Use a unique password with at least 12 characters; don’t reuse an account password. The server creates and persists its own signing key in the private Docker volume. The login username is `admin`.

Open `/admin` over HTTPS to edit the page. Your session expires after 8 hours. The login route limits repeated failed attempts.

Each link can use an automatically detected platform icon or one you choose from the icon picker, including Haven, Haven App Icon, and Ninja. The copied icon helpers are MIT-licensed; see `LICENSE.LinkBreeze` and `THIRD_PARTY_NOTICES.md`.

## Presence setup

Discord activity is read by a small bot connection running in the bio app on your VPS. Create a Discord application, enable Presence Intent, add its bot to a server shared with your account, enter your Discord user ID in the admin editor, and save the bot token in the Discord presence panel. The token is stored in a private file in the persistent Docker volume and is never returned by the API. The bot reads presence updates only and does not read messages. Spotify presence comes from the Bazzite companion bridge and is independent of Discord. When Spotify exposes a direct track URL, both the song title and a **Copy Spotify track link** button copy it to the clipboard.

## Twitch live player

The page checks the configured Twitch channel about every 60 seconds through Twitch's Helix Get Streams API. The Twitch player card is shown only while the channel is live. In the admin editor, set the Twitch channel login and save the profile, then register a Twitch app and save its Client ID and Client Secret in the Twitch live player panel. Credentials are held in a private Docker-volume file and are not returned by the public profile API. The public stream embed requires HTTPS and the correct parent domain. On narrow mobile screens the page provides a Watch on Twitch link because Twitch requires embeds to be at least 400 pixels wide.

## Steam presence on Bazzite

The combined Steam and Spotify bridge runs on your Bazzite computer. It reads the active Steam game and the Spotify desktop player through MPRIS using `playerctl`, then sends game and track details (including Spotify’s `xesam:url`) to the site over HTTPS every 15 seconds. The page marks the bridge disconnected after 75 seconds without a heartbeat. Steam artwork and a session timer appear while a game is open; Spotify album artwork appears when the player provides a supported Spotify image URL. Install `playerctl` on Bazzite if it is not already available. In the admin panel, create a presence connection token, then run `install-steam-bridge.sh` from the companion package and paste the token when asked. The user service starts at sign-in. Revoke the token in the admin panel to disconnect both presences.

## System monitor on Bazzite

The same bridge also sends live system stats to `/api/system/stats` every 15 seconds: CPU and GPU load, CPU and GPU temperature, RAM and swap usage, disk usage for `/`, uptime, load average, and network throughput. The public page shows them in a **System** card with usage bars, refreshed every 10 seconds and hidden while the bridge is offline. Stats are read from `/proc`, `/sys/class/hwmon`, and `/sys/class/drm`, with `nvidia-smi` used as a fallback for NVIDIA GPUs, so no extra packages are needed. The admin panel has a **Show system monitor** switch, and the panel is hidden when no recent heartbeat exists. Creating or revoking the connection token also clears saved system stats.

## Hosting

The Docker Compose service binds only to `127.0.0.1:3000`; Caddy routes `example.com` to it. The provided cutover guide keeps `legacy.example.com` on port 3011 and describes how to update the running site.
