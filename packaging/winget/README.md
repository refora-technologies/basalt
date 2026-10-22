# winget

Basalt and Basalt Host on Windows Package Manager:

```
winget install ReforaTechnologies.Basalt
winget install ReforaTechnologies.BasaltHost
```

For each release, once it is published on GitHub:

```
python packaging/winget/make-manifests.py 1.6.0 dist/release-1.6.0 target/winget
winget validate --manifest target/winget/manifests/r/ReforaTechnologies/Basalt/1.6.0
winget validate --manifest target/winget/manifests/r/ReforaTechnologies/BasaltHost/1.6.0
```

The manifests then go to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)
as a pull request (one folder per package), the same way any package does. The installers
are the release's own, by their versioned download links, with the digests published
beside them.
