# Deploying qos.systems

Publish the generated files over HTTPS at the site origin:

| Public path | Release artifact | Purpose |
| --- | --- | --- |
| `/` | `web-root/index.html` | Install-first landing page |
| `/install.sh` | `web-root/install.sh` | Ubuntu/Linux bootstrap |
| `/install-macos.sh` | `web-root/install-macos.sh` | macOS wrapper using Lima Ubuntu |
| `/install-windows.ps1` | `web-root/install-windows.ps1` | Windows wrapper using WSL 2 Ubuntu |
| `/RELEASE.json` | `web-root/RELEASE.json` | Public deployment metadata |

Generate the exact deployment tree with:

```sh
make web-release
```

The website bundle contains no qOS source archive. All three host paths reach
the same Linux bootstrap, which downloads `qos-source.tar.gz` and
`SHA256SUMS.txt` from the latest `Quantized-OS/qOS` GitHub Release. The Linux
bootstrap verifies the archive before release code runs. The macOS wrapper
uses a mount-isolated Lima Ubuntu 24.04 VM; the Windows wrapper uses Ubuntu
24.04 on WSL 2.

Serve `.sh` files as `text/x-shellscript`, `.ps1` as `text/plain` or
`application/octet-stream`, and disable shared-cache transformations. Do not
inject HTML, analytics, or redirects into installer responses.

Create the GitHub assets locally with `make github-release`, or push a
canonical `vMAJOR.MINOR.PATCH` tag matching `package.json`. The included GitHub
workflow runs the complete gate and publishes the exact assets automatically.
Publish the SHA-256 digest through an independent signed channel for users who
set `QOS_RELEASE_SHA256`.

After deployment, verify the public files before advertising them:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install.sh | sh -s -- --help
curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install-macos.sh | sh -s -- --help
curl --proto '=https' --tlsv1.2 -fsSL -o /tmp/qos-install-windows.ps1 https://qos.systems/install-windows.ps1
```

The wrappers never make qOS itself native to macOS or Windows. They create or
reuse the supported Ubuntu execution boundary, then run the same verified
release installer. Domain deployment, GitHub access control, Homebrew trust,
WSL distribution trust, and release publication remain operator concerns.
