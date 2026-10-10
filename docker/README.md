# Basalt Host in Docker

The screenless Basalt Host in a container: for a NAS (Synology, Unraid,
TrueNAS, QNAP), a home server, or anything else that runs Docker. It shares
folders with your phones and computers on the same network, and is set up and
managed from the Basalt app.

## Run it

The image is `ghcr.io/refora-technologies/basalt-host`, for 64-bit PCs and
NAS boxes (amd64) and for the Raspberry Pi and other ARM boards (arm64). Docker
picks the right one by itself.

With Docker Compose: save [`compose.yaml`](compose.yaml) in a folder of its
own, change `/srv/media` to the folder with your files, then:

```sh
docker compose up -d
```

Or with `docker run`:

```sh
docker run -d --name basalt --network host \
  -e PUID=1000 -e PGID=1000 \
  -v /srv/basalt/config:/config \
  -v /srv/media:/media/Media \
  --restart unless-stopped ghcr.io/refora-technologies/basalt-host:latest
```

On a NAS, add a container from the image `ghcr.io/refora-technologies/basalt-host:latest`
with the same settings: host networking, `/config` and a folder under `/media`.

## Set it up

1. Find the setup code: `docker exec basalt basalt-host status` shows it with the
   host's address, or look in `docker logs basalt`.
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

A container never updates itself. When a new version is out, Manage host and
`basalt-host status` say so; update by pulling the new image and recreating the
container:

```sh
docker compose pull && docker compose up -d
```

The settings in `/config` carry over.

## Check where the image came from

Every published image is signed and carries a record of the GitHub workflow
that built it:

```sh
gh attestation verify oci://ghcr.io/refora-technologies/basalt-host:latest --owner refora-technologies
```

## Build the image yourself

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
