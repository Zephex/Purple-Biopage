# Show Steam online or offline

This update combines Discord into one card with the custom activity picture and status details alongside a crisp Online / Offline badge. It also adds matching Steam and Discord status badges, with shared colors you can customize in the admin panel. It follows whether the Steam client is open on your Bazzite computer. If the bridge disconnects, the page shows Unknown. Steam's Invisible/offline friends-list setting is not exposed by the local bridge, so this reports client availability.

## 1. Copy the server update

On your computer, run:

```sh
scp ~/Downloads/personal-bio-steam-online.tar.gz user@server:/tmp/
```

## 2. Update the VPS

Connect with `ssh user@server`, then run:

```sh
cd /opt/personal-bio
tar -xzf /tmp/personal-bio-steam-online.tar.gz -C /opt/personal-bio
docker compose up -d --build
```

Your profile, uploads, `.env`, and Docker data volume stay in place.

## 3. Update the Bazzite bridge

On your computer, extract `steam-presence-bazzite-online.tar.gz` into a folder, open a terminal in that folder, and run:

```sh
./install-steam-bridge.sh
```

When asked, enter `https://example.com`. Press Enter at the token prompt to reuse the bridge token already saved on your computer. The installer restarts the existing service with the update.
