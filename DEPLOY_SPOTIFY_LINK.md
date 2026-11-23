# Add a copyable Spotify track link

The bio page’s Spotify card gains a **Copy Spotify track link** button when the Bazzite bridge can read a Spotify track URL. Your saved profile, uploads, Caddy route, admin password, and existing bridge token are preserved.

## Update the VPS

Download `personal-bio-spotify-link.tar.gz` to your PC’s Downloads folder. In the PC terminal, transfer it:

```sh
scp ~/Downloads/personal-bio-spotify-link.tar.gz user@server:/tmp/
```

Then, in the VPS terminal:

```sh
cd /opt/personal-bio
tar -xzf /tmp/personal-bio-spotify-link.tar.gz -C /opt/personal-bio
docker compose up -d --build
```

Do not remove the Docker volume or replace `.env`.

## Update the Bazzite bridge

Download `steam-presence-bazzite-link.tar.gz` to your PC’s Downloads folder and extract it to a new folder. In that extracted folder, run:

```sh
./install-steam-bridge.sh
```

Enter `https://example.com` at the site prompt. At the connection-token prompt, press Enter to reuse the token saved by your current bridge. The installer updates and restarts the service. Keep Spotify open and playing; the bridge reads the track URL from Spotify’s MPRIS metadata.
