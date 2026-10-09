# Basalt Host with no screen

Basalt Host for a computer you don't sit at: a home server, a Raspberry Pi, a
NAS, an old PC under the TV. It shares one drive or folder with your phones and
computers on this network. There is no window: you set it up and manage it from
the Basalt app, with **Manage host**.

For Docker, see `docker/README.md` in the source.

## Install

Debian, Ubuntu, Raspberry Pi OS:

```sh
sudo apt install ./basalt-host-server_<version>_amd64.deb     # or _arm64.deb
```

Fedora and similar:

```sh
sudo dnf install ./basalt-host-server-<version>-1.x86_64.rpm   # or .aarch64.rpm
```

The package installs `/usr/bin/basalt-host`, a `basalt-host` service that starts
with the computer, and a firewall profile (ufw or firewalld) for ports 7742/tcp
and 7743/udp. With a `.tar.gz`, copy `basalt-host` to `/usr/bin` and the service
file to `/etc/systemd/system`, then `sudo systemctl enable --now basalt-host`.

The desktop Basalt Host and this one can't be installed together: both use the
same ports.

## Set it up

1. On a phone or computer on the same network, open Basalt. The host shows in the
   list as **new**. Choose it.
2. Type its setup code. The code is in the host's log, or ask for it:

   ```sh
   sudo basalt-host setup-code
   journalctl -u basalt-host       # the code is in the log too
   ```

3. That device now manages the host. Choose what it shares, its name, and
   whether new devices need a PIN. When a new device asks to join, its PIN shows
   on that device's Manage host screen.

Setting up and pairing only ever happen on your own network.

## Let it read your drive

The service runs as its own user, `basalt`, which owns only the host's settings
(`/var/lib/basalt-host`). Give it access to the folder it shares, for example:

```sh
sudo setfacl -R -m u:basalt:rwX -m d:u:basalt:rwX /srv/media
```

Use `r-X` instead of `rwX` for a host that should never change anything. Each
folder above it must let the user through too (`sudo setfacl -m u:basalt:x /srv`
for each one, or the drive's mount folder). To run
it as your own user instead:

```sh
sudo systemctl edit basalt-host
```

and add:

```ini
[Service]
User=yourname
Group=yourname
```

## If the device that manages it is lost

```sh
sudo basalt-host setup-code --reset
```

gives a new setup code even though the host is set up. The next device to pair
with it manages the host too; remove the lost device in Manage host afterwards.

## Commands

| Command | What it does |
|---|---|
| `basalt-host serve` | Runs the host (what the service does) |
| `basalt-host setup-code [--reset]` | Shows the setup code |
| `basalt-host status` | Name, what it shares, devices, who manages it |
| `basalt-host share PATH [--name NAME]` | Chooses what it shares, while the service is stopped |
| `basalt-host health` | Exits 0 if the host answers |

The host's settings are `/var/lib/basalt-host/host.json`. They hold its identity:
removing the package keeps them, purging it deletes them, and every device would
then pair again.
