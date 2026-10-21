"""Writes the winget manifests for a Basalt release.

    python packaging/winget/make-manifests.py VERSION RELEASE_DIR OUT_DIR

RELEASE_DIR holds the release's files as published (Basalt-Client-Setup.exe,
Basalt-Host-Setup.exe and the .sha256 beside each). OUT_DIR gets the layout
microsoft/winget-pkgs expects:

    manifests/r/ReforaTechnologies/Basalt/VERSION/*.yaml
    manifests/r/ReforaTechnologies/BasaltHost/VERSION/*.yaml

The installers are fetched by winget from the release's own download links,
which carry the version: the fixed "latest" links would change under a
manifest once the next release is out.
"""

import pathlib
import sys

SCHEMA = "1.9.0"
REPO = "https://github.com/refora-technologies/basalt"
SITE = "https://basalt.reforatech.com"

PACKAGES = [
    {
        "id": "ReforaTechnologies.Basalt",
        "name": "Basalt",
        "file": "Basalt-Client-Setup.exe",
        # The installer's uninstall entry is named after the product.
        "product_code": "Basalt",
        "short": "Your own drive, on every device: films, photos, music and files from your computer.",
        "description": (
            "Basalt opens the files on your own computer from your phone, your laptop and your "
            "TV: films and shows to stream, photos, music, documents, anything. It pairs with "
            "Basalt Host on the computer that has your files, over your home network. Yours, "
            "encrypted, and private by default."
        ),
        "moniker": "basalt",
        "tags": ["media", "streaming", "files", "nas", "home-server", "player"],
    },
    {
        "id": "ReforaTechnologies.BasaltHost",
        "name": "Basalt Host",
        "file": "Basalt-Host-Setup.exe",
        "product_code": "Basalt Host",
        "short": "Shares a drive on your computer with the Basalt app on your other devices.",
        "description": (
            "Basalt Host runs on the computer that has your files and shares one of its drives "
            "with the Basalt app on your phones, computers and TV, over your home network. It "
            "sorts films and shows into a library and converts video for devices that cannot "
            "play it."
        ),
        "moniker": "basalt-host",
        "tags": ["media-server", "streaming", "files", "nas", "home-server"],
    },
]


def digest(release_dir: pathlib.Path, name: str) -> str:
    text = (release_dir / f"{name}.sha256").read_text(encoding="utf-8")
    token = text.split()[0].lstrip("*")
    if len(token) != 64:
        sys.exit(f"{name}.sha256 holds no digest")
    return token.upper()


def quoted(text: str) -> str:
    """Free text as a YAML string: descriptions hold colons and quotes."""
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def write(path: pathlib.Path, kind: str, body: str) -> None:
    path.write_text(
        f"# yaml-language-server: $schema=https://aka.ms/winget-manifest.{kind}.{SCHEMA}.schema.json\n"
        + body
        + f"ManifestType: {kind}\nManifestVersion: {SCHEMA}\n",
        encoding="utf-8",
        newline="\n",
    )


def main() -> None:
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    version = sys.argv[1].lstrip("v")
    release_dir = pathlib.Path(sys.argv[2])
    out = pathlib.Path(sys.argv[3])
    for package in PACKAGES:
        folder = out / "manifests" / "r" / "ReforaTechnologies" / package["id"].split(".")[1] / version
        folder.mkdir(parents=True, exist_ok=True)
        pid = package["id"]
        url = f"{REPO}/releases/download/v{version}/{package['file']}"
        write(
            folder / f"{pid}.yaml",
            "version",
            f"PackageIdentifier: {pid}\nPackageVersion: {version}\nDefaultLocale: en-US\n",
        )
        write(
            folder / f"{pid}.installer.yaml",
            "installer",
            f"PackageIdentifier: {pid}\n"
            f"PackageVersion: {version}\n"
            "InstallerType: nullsoft\n"
            "Scope: user\n"
            "UpgradeBehavior: install\n"
            f"ProductCode: {package['product_code']}\n"
            "Installers:\n"
            "- Architecture: x64\n"
            f"  InstallerUrl: {url}\n"
            f"  InstallerSha256: {digest(release_dir, package['file'])}\n",
        )
        tags = "".join(f"- {tag}\n" for tag in package["tags"])
        write(
            folder / f"{pid}.locale.en-US.yaml",
            "defaultLocale",
            f"PackageIdentifier: {pid}\n"
            f"PackageVersion: {version}\n"
            "PackageLocale: en-US\n"
            "Publisher: Refora Technologies\n"
            f"PublisherUrl: {SITE}\n"
            f"PublisherSupportUrl: {REPO}/issues\n"
            f"PackageName: {package['name']}\n"
            f"PackageUrl: {SITE}\n"
            "License: GPL-3.0\n"
            f"LicenseUrl: {REPO}/blob/main/LICENSE\n"
            "Copyright: Copyright (c) 2026 Refora Technologies\n"
            f"ShortDescription: {quoted(package['short'])}\n"
            f"Description: {quoted(package['description'])}\n"
            f"Moniker: {package['moniker']}\n"
            f"Tags:\n{tags}"
            f"ReleaseNotesUrl: {REPO}/releases/tag/v{version}\n",
        )
        print(folder)


if __name__ == "__main__":
    main()
