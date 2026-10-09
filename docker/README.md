# Basalt Host in Docker

The screenless Basalt Host in a container: for a NAS (Synology, Unraid,
TrueNAS, QNAP), a home server, or anything else that runs Docker. It shares
folders with your phones and computers on the same network, and is set up and
managed from the Basalt app.

## Run it

With Docker Compose, from this folder:

```sh
docker compose up -d
docker compose logs basalt
```

Or with `docker run`, after building the image (below):

```sh
docker run -d --name basalt --network host \
  -e PUID=1000 -e PGID=1000 \
  -v /srv/basalt/config:/config \
  -v /srv/media:/media/Media \
  --restart unless-stopped basalt-host
```

## Set it up

1. Find the setup code: `docker logs basalt`, or `docker exec basalt basalt-host setup-code`.
2. Open Basalt on your phone or computer, on the same network. The host shows as
   **new**. Choose it and type the code.
3. That device manages the host now. In Manage host, choose which of the folders
   under `/media` it shares.

Setting up and pairing only happen on your own network.

## Settings

| | |
|---|---|
| `/config` | The host's identity and paired devices. Keep it: lose it, and every device pairs again. |
| `/media/...` | Each folder mounted here is a drive the host can share. Add `:ro` for read only. |
| `PUID`, `PGID` | The user and group the host runs as: the owner of your media (default 1000). |
| `BASALT_HOST_NAME` | What devices call it at first. Renamed any time in Manage host. |
| `network_mode: host` | Lets devices find the host by themselves. Without it, publish `7742/tcp` and `7743/udp`, and use "Enter the address" in the app. |
| `/dev/dri` | Pass it in for faster video conversion with Intel or AMD graphics. |

The host never updates itself in Docker: pull or build a new image and recreate
the container. The settings in `/config` carry over.

## Build the image

From the root of the source:

```sh
docker build -f docker/Dockerfile -t basalt-host .
```

For other machines too (cross-compiled, quick):

```sh
docker buildx build -f docker/Dockerfile --platform linux/amd64,linux/arm64 -t basalt-host .
```

## If the device that manages it is lost

```sh
docker exec basalt basalt-host setup-code --reset
```

The next device to pair with the new code manages the host too.
