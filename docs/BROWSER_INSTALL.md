# Verified browser installation

After the generated `web-root` is deployed to `qos.systems`, choose the host
command below. With no flags, every platform opens the same mainnet custody
chooser. Existing external custody is the recommended preselected choice; the
other choice generates an accessible software key through `--insecure` and
still requires the complete warning acknowledgement.

## Linux / supported Ubuntu

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install.sh | sh
```

## macOS

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install-macos.sh | sh
```

The macOS wrapper requires Homebrew. It installs Lima when needed, creates a
dedicated Ubuntu VM named `qos` with host-directory mounts disabled, and runs
the Linux bootstrap there. qOS itself remains in its supported Ubuntu
environment. Reopen it with:

```sh
limactl shell qos bash -lc qos
```

## Windows

Run from PowerShell:

```powershell
irm https://qos.systems/install-windows.ps1 | iex
```

The wrapper installs or reuses Ubuntu 24.04 on WSL 2. Windows may request
administrator approval and a restart when WSL is not ready yet. Re-run the same
command after restarting. Reopen qOS with:

```powershell
wsl -d Ubuntu-24.04 -- bash -lc qos
```

## Explicit Devnet mode

Linux and macOS pass setup flags after `sh -s --`:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install.sh | sh -s -- --devnet
curl --proto '=https' --tlsv1.2 -fsSL https://qos.systems/install-macos.sh | sh -s -- --devnet
```

Windows uses one allowlisted setup mode:

```powershell
$env:QOS_SETUP_MODE='devnet'; irm https://qos.systems/install-windows.ps1 | iex
```

`QOS_SETUP_MODE=insecure` maps to `setup.sh install --insecure`; the setup
wizard still prints the complete accessible-key warning and requires explicit
acceptance.

## Verification boundary

All three paths converge on the POSIX Linux bootstrap. It downloads only over
HTTPS from the latest GitHub Release at `Quantized-OS/qOS`, retrieves the
deterministic `qos-source.tar.gz` archive and `SHA256SUMS.txt`, rejects unsafe
archive paths and link types, installs the verified source under the user's
data directory, and then invokes `setup.sh install`. It does not use `eval` or
execute an unverified archive.

The checksum is a second asset in the same GitHub Release, so it detects
corruption and inconsistent publication but does not survive repository or
GitHub account compromise. Publish the digest through an independent signed
channel. Linux users can pin it with `QOS_RELEASE_SHA256`; the macOS wrapper
forwards the same variable into its isolated VM.

Running a remote script is itself a trust decision. Review `web/install.sh`,
`web/install-macos.sh`, and `web/install-windows.ps1` before using a pipe
command.

Generate the deployable tree and GitHub Release assets with:

```sh
make web-release
make github-release
```

The website tree contains the landing page, three small host bootstraps, and
`RELEASE.json`. It contains no compiled-in source release. Pushing a canonical
`vMAJOR.MINOR.PATCH` tag that exactly matches `package.json` runs the included
release workflow and publishes the source assets. Domain deployment, GitHub
access control, Homebrew trust, WSL distribution trust, and release
publication remain operator responsibilities.
