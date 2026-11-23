# Update your bio page

This update adds admin controls for the page background color, card color and transparency, and both background gradient colors. It includes the current bio app files and does not include `.env`, your saved profile, uploads, or Docker's persistent data volume.

## 1. Copy the update from your computer

In your computer's terminal, run:

```sh
scp ~/Downloads/personal-bio-colors.tar.gz user@server:/tmp/
```

## 2. Apply it on the VPS

Connect with `ssh user@server`, then paste:

```sh
cd /opt/personal-bio
tar -xzf /tmp/personal-bio-colors.tar.gz -C /opt/personal-bio
docker compose up -d --build
```

Do not delete the Docker volume or `/opt/personal-bio/.env`.

## 3. Change the colors

Open https://example.com/admin and sign in. Under **Look and feel**, choose the page background, box color, box transparency, and the two gradient colors. Click **Save changes**. Refresh the public page to see the update.
