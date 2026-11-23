Steam + Spotify + system monitor bridge for Bazzite

This uses the existing Steam companion service and connection token. It also reads Spotify desktop playback via MPRIS using playerctl and reports CPU, GPU, RAM, disk, uptime, and network usage for the system monitor panel. It does not need a Spotify Developer app or Discord to be open.

1. Update the bio page server with personal-bio-steam-spotify.tar.gz first.
2. Sign in at https://example.com/admin, open Steam and Spotify presence, and create a new connection token. Creating a new token invalidates the old one.
3. Make sure playerctl is installed on Bazzite. Check with: playerctl --version
4. Extract this bundle, open a terminal in its folder, and run: ./install-steam-bridge.sh
5. Enter https://example.com. Press Enter at the token prompt to reuse the token already saved by the existing bridge. Or paste a new token if you created one.
6. Already installed an older bridge? Run ./install-steam-bridge.sh again to copy the updated script, then run: systemctl --user restart personal-bio-steam-bridge

If playerctl is missing, Bazzite can layer the Fedora package with `rpm-ostree install playerctl`; reboot to apply it, reboot to apply it, then restart the existing service with `systemctl --user restart personal-bio-steam-bridge`. Bazzite documents package layering as a last resort because it adds a system package and requires a reboot: https://docs.bazzite.gg/Installing_and_Managing_Software/rpm-ostree/

The service starts at sign-in. It polls every 15 seconds. Spotify presence is cleared while playback is paused or stopped. When the player provides a Spotify track URL, the site shows a copy-link button. System stats are read from /proc and /sys, so no extra packages are required. Revoke the connection token in the admin panel to disconnect Steam, Spotify, and the system monitor.

To check the service: systemctl --user status personal-bio-steam-bridge
To restart it: systemctl --user restart personal-bio-steam-bridge
