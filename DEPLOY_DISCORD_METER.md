# Hide the Discord activity meter

This update removes the animated meter from the Discord card and leaves the Spotify meter as it is. It also makes the Spotify song title clickable to copy its direct track link, with a separate copy button.

On your PC, transfer the server bundle:

```sh
scp ~/Downloads/personal-bio-discord-no-meter.tar.gz user@server:/tmp/
```

Then, in the VPS terminal:

```sh
cd /opt/personal-bio
tar -xzf /tmp/personal-bio-discord-no-meter.tar.gz -C /opt/personal-bio
docker compose up -d --build
```

The update keeps your `.env`, Docker volume, saved profile, uploads, and connection token.

For Spotify link copying, update the Bazzite bridge too. Extract `steam-presence-bazzite-link.tar.gz` into a new folder, run `./install-steam-bridge.sh`, enter the site URL, and press Enter at the token prompt to reuse the token already saved on your PC. The title can only copy a link when the bridge has received a direct Spotify track URL.
