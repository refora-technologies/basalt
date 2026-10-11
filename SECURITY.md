# Security

Basalt keeps a household's files, and we take its security seriously. How it
protects your drive is described in plain words in the
[security docs](https://basalt.reforatech.com/docs/reference/security/).

## Reporting a problem

If you find a way around any of Basalt's protections, please tell us
**privately**, by email to **reforatech@gmail.com**, with "Basalt security" in
the subject. Please don't open a public issue or discussion about it until it
is fixed.

It helps to include:

- what an attacker could do, and what they would need (on the same network,
  a paired device, access to the host computer, and so on)
- the steps to reproduce it, or a proof of concept
- the versions of Basalt Host and the apps, and what they run on

## What happens next

- We reply within three working days to say we have it.
- We confirm the problem, work on a fix, and keep you told how it is going.
- The fix goes out in a release, and the release notes describe the problem
  once people have had the chance to update.
- With your permission, we thank you by name in those notes.

Please give us a reasonable time to fix it before you talk about it publicly,
and don't access other people's data, disrupt anyone's host, or keep data you
come across while testing.

## Supported versions

Fixes go into the newest release. Basalt Host updates itself, and the apps
offer each update, so the newest version is the one to test and the one we
support.

| Version | Supported |
|---|---|
| 1.5.x | Yes |
| Earlier | No: please update |

## In scope

Basalt Host, Basalt for Windows and Android, the Linux packages, the Docker
image, and the way they update. Problems in the components Basalt is built on
(libmpv, FFmpeg, rustls and others) are welcome too; we will pass them on to
their makers.
