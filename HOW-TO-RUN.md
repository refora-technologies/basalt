# How to run Basalt

Two programs. **Basalt Host** runs on the computer with the drive: Windows, a
Linux desktop, a Linux computer with no screen, or Docker on a NAS. **Basalt**
runs on every phone, tablet and computer that opens it: Windows and Android
today, Linux soon.

There is no address to type. Devices find the host on your network by
themselves, and keep finding it when the router hands out a new address.

## Guides

The step-by-step guides are in the docs, at
**[basalt.reforatech.com/docs](https://basalt.reforatech.com/docs/)**:

| To | Read |
|---|---|
| Understand how it fits together | [Getting started](https://basalt.reforatech.com/docs/getting-started/) |
| Put the host on Windows | [Basalt Host on Windows](https://basalt.reforatech.com/docs/host/windows/) |
| Put the host on a Linux desktop | [Basalt Host on a Linux desktop](https://basalt.reforatech.com/docs/host/linux-desktop/) |
| Run the host with no screen | [Basalt Host with no screen](https://basalt.reforatech.com/docs/host/linux-server/), and [`packaging/linux/README.md`](packaging/linux/README.md) |
| Run the host in Docker | [Basalt Host in Docker](https://basalt.reforatech.com/docs/host/docker/), and [`docker/README.md`](docker/README.md) |
| Pair a phone or computer | [Pairing a device](https://basalt.reforatech.com/docs/use/pairing/) |
| Fix something | [Troubleshooting](https://basalt.reforatech.com/docs/help/troubleshooting/) |

## From source

Building the apps, the Linux packages and the Docker image is described in the
[README](README.md#building-from-source). A host built from source runs like an
installed one; on Linux, `cargo run -p basalt-host --bin basalt-host --release -- serve` runs the
host with no screen from the repository, with its settings in
`~/.config/basalt/`.

## The old benchmark harness

The phase 0 transfer benchmarks and what they measured are in
[`docs/measured-facts.md`](docs/measured-facts.md).
