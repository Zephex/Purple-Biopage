# Replace Lanyard with your own Discord bot

This update replaces the page's Lanyard request with a Discord Gateway bot connection on your VPS. The bot reports online status and game activities for the Discord user ID saved in the profile. It does not read messages. Spotify still uses the Bazzite bridge.

## 1. Update the bio page

From your PC terminal, send the bundle to the VPS:

```sh
scp ~/Downloads/personal-bio-discord-bot.tar.gz user@server:/tmp/
```

Then, in the VPS terminal:

```sh
cd /opt/personal-bio
tar -xzf /tmp/personal-bio-discord-bot.tar.gz -C /opt/personal-bio
docker compose up -d --build
```

The update preserves `.env`, the Docker volume, saved profile, uploads, and the Steam/Spotify connection token. Do not remove the Docker volume.

## 2. Create the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Open **Bot** and enable **Presence Intent**. The bot needs no message access.
3. Copy or reset the bot token. Keep it private; do not paste it into chat.
4. Under **OAuth2 → URL Generator**, select the **bot** scope and no permissions. Open the generated invite link and add the bot to a Discord server that your account also belongs to. A private server is fine.

## 3. Connect it to the bio page

1. Sign in at `https://example.com/admin`.
2. In **Your profile**, make sure your Discord user ID is saved, then click **Save changes**.
3. In **Discord presence bot**, paste the bot token and choose **Save and connect bot**.
4. Wait for the panel to say the bot is connected. If it says it has not seen your presence, confirm the bot and your Discord account share a server and the saved user ID is correct.

The bot token is stored in a private file inside the persistent Docker volume. To disconnect it later, use **Disconnect bot** in the admin panel.
