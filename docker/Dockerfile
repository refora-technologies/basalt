# syntax=docker/dockerfile:1
#
# Basalt Host with no screen, in a container.
#
#   docker build -f docker/Dockerfile -t basalt-host .
#
# Built for the machine running the build, or for others with buildx
# (--platform linux/amd64,linux/arm64): the program is cross-compiled on the
# build machine, never emulated, so an ARM image takes minutes, not hours.

FROM --platform=$BUILDPLATFORM rust:1-bookworm AS build
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu libc6-dev-arm64-cross \
    && rm -rf /var/lib/apt/lists/*
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/target \
    case "$TARGETARCH" in \
        amd64) target=x86_64-unknown-linux-gnu ;; \
        arm64) target=aarch64-unknown-linux-gnu ;; \
        *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && rustup target add "$target" \
    && CARGO_TARGET_DIR=/target cargo build --release --locked -p basalt-host --bin basalt-host --target "$target" \
    && cp "/target/$target/release/basalt-host" /basalt-host

FROM debian:bookworm-slim
# ffmpeg converts video for devices that cannot play it; libmpv draws video
# thumbnails; tini passes Docker's stop on and reaps what ffmpeg leaves.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libmpv2 tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /basalt-host /usr/local/bin/basalt-host
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

ENV BASALT_HOST_CONFIG=/config/host.json \
    BASALT_CONTAINER=1 \
    PUID=1000 \
    PGID=1000

# The host's identity and paired devices. Keep it: losing it means every
# device pairs again.
VOLUME ["/config"]
# Connections, and finding the host. With `network_mode: host` (recommended)
# these are the host machine's own ports.
EXPOSE 7742/tcp 7743/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["basalt-host", "health"]
ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["serve"]
