# Security

Basalt keeps a household's files, and we take its security seriously. How it
protects your drive is described in plain words in the
[security docs](https://basalt.reforatech.com/docs/reference/security/).

## Reporting a problem

If you find a way around any of Basalt's protections, please tell us
**privately**. Please don't open a public issue or discussion about it until
it is fixed.

- **On GitHub:** use
  [Report a vulnerability](https://github.com/refora-technologies/basalt/security/advisories/new)
  on this repository's Security tab. Only you and the maintainers can see the
  report, and we can work on the fix with you there.
- **By email,** if you'd rather not use GitHub: write to
  **reforatech@gmail.com** with "Basalt security" in the subject.

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

## Signed releases

From 1.6.0, every release is signed with Basalt's release key. The
release's `SHA256SUMS` lists the SHA-256 of each file, and below the list is a
[minisign](https://jedisct1.github.io/minisign/) signature (Ed25519) of it.
Basalt Host and the apps install an update only from a release whose list is
signed with this key and names that release's version; anything else is
refused before it is downloaded.

```
untrusted comment: minisign public key: 74C79A12F0039EFE
RWT+ngPwEprHdGiYoMFZSz45phkiwPIHIbVXO0HpobLakZsWnfmRaokE
```

To check a release by hand, split the signature from the list, check it, then
check your downloads against the list:

```
head -n -4 SHA256SUMS > list
tail -n 4 SHA256SUMS > list.minisig
minisign -Vm list -P RWT+ngPwEprHdGiYoMFZSz45phkiwPIHIbVXO0HpobLakZsWnfmRaokE
sha256sum --ignore-missing -c list
```

The signed comment minisign prints names the release, as `basalt release
1.6.0`. The `.sha256` beside each file is still published, for copies older
than 1.6.0.

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
