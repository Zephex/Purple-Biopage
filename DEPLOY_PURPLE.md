# Update the bio page media controls

This update adds Spotify presence from the existing Bazzite Steam bridge, including a copyable direct Spotify track link, Steam game artwork and a session timer to the Steam presence card, plus the Twitch live player. It also includes admin-generated Steam bridge tokens, an eight-column grid for icon-only links on desktop, a 24-link limit, editable social link preview text, Discord bot presence, editable browser tab title, icon search and link reordering, looping video uploads, grouped upload controls, custom icons, horizontal/vertical link layouts, editable page labels and footer text, custom Discord activity picture, clickable Discord name and handle, and a short-status switch. Your current Caddy route, admin password, Discord ID, saved profile, and uploads are preserved.

## 1. Upload the update from your computer

In your computer’s terminal (not the VPS terminal), run:

```sh
scp ~/Downloads/personal-bio-steam-spotify.tar.gz user@server:/tmp/
```

If your prompt currently starts with `root@cloud-server`, type `exit` first to return to your computer.

## 2. Install it on the VPS

Connect if needed with `ssh user@server`, then run these commands in the VPS terminal:

```sh
cd /opt/personal-bio
tar -xzf /tmp/personal-bio-steam-spotify.tar.gz -C /opt/personal-bio
docker compose up -d --build
```

Do not remove the Docker volume; it contains your profile and uploaded files. The update bundle does not include or replace your `.env` file.

## 3. Use the Uploads panel

Open [https://example.com/admin](https://example.com/admin) and sign in. Edit **Link preview title** and **Link preview description** in the profile section, then save. These are the title and description chat apps show when you share your URL; leave them blank to use your browser tab title and bio. Preview caches can take time to refresh after a change. The **Uploads** panel groups avatar, background image, looping video, Discord activity picture, and browser icon controls. The Discord activity picture appears in the Discord card on your page. The browser tab title, footer message, “personal space / 001” top label, and links section heading are editable in the profile section. Add up to 24 links; when every link has a blank label and description, they appear in an eight-column grid on desktop and four columns on narrow phones. Drag a link by its handle or use its arrows to reorder, then click **Save changes**. Search names in the icon chooser. Individual link titles and descriptions are edited in the Links panel. Tap the small icon button on a link row to open the icon chooser, and set **Link arrangement** to choose a vertical list or horizontal row. The icon chooser includes **Haven**, **Haven App Icon**, and **Ninja**. Use the **Enabled / Disabled** button to show or hide the short status while keeping its text saved. Save a Discord bot token in the **Discord presence bot** panel after enabling Presence Intent and adding the bot to a server shared with your account. The bot reads activity updates directly from Discord Gateway; Spotify continues to come from the Bazzite bridge. Video backgrounds accept MP4 or WebM files up to 100 MiB and loop automatically.

After the server update, download and extract the updated `steam-presence-bazzite.tar.gz` bundle on Bazzite, open a terminal in its folder, and run `./install-steam-bridge.sh`. Enter `https://example.com`, then press Enter at the connection-token prompt to reuse the token already saved by your existing bridge. The installer updates and restarts the existing service, which starts at sign-in. It reports Steam game details and Spotify track metadata while Spotify is playing. Spotify is read from the local desktop player through `playerctl`; check with `playerctl --version`. If it is missing, the Bazzite-documented option is `rpm-ostree install playerctl`, followed by a reboot, then rerun the installer. Revoke the token in the admin panel to disconnect both presences.

To set up Twitch, create a Twitch app in the Developer Console. In **Twitch channel**, enter your channel login and save the profile. In **Twitch live player**, save your app's Client ID and Client Secret. The Client Secret is stored privately on the server. Twitch status is checked about every 60 seconds; the embedded player appears only while live. The mobile layout links directly to the stream because Twitch requires an embedded player to be at least 400 pixels wide.

Use **Choose saved image/video** to reuse an upload. The gallery also has a **Delete** button. A file currently used by your saved profile cannot be deleted; clear its URL field in the Uploads panel and save first, then delete it.

For the Discord bot setup details, see `DEPLOY_DISCORD_BOT.md`. If the container does not start, run `docker compose logs --tail=80` from `/opt/personal-bio` and share the output.
