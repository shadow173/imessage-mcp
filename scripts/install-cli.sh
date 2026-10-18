#!/bin/zsh
# Installs the `imessage` command into ~/.local/bin. It talks to the running bridge over its local socket, so it
# runs on your normal node and needs no Full Disk Access. Re-run after moving the repo.
set -euo pipefail
REPO=${0:A:h:h}
NODE_AT_INSTALL=$(command -v node) || { echo "node is not on PATH" >&2; exit 1; }
(cd "$REPO" && npm run build >/dev/null)
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/imessage" <<WRAP
#!/bin/zsh
# imessage CLI wrapper (installed by $REPO/scripts/install-cli.sh)
NODE=\$(command -v node) || NODE="$NODE_AT_INSTALL"
exec "\$NODE" --disable-warning=ExperimentalWarning "$REPO/dist/cli.js" "\$@"
WRAP
chmod 755 "$HOME/.local/bin/imessage"
echo "Installed $HOME/.local/bin/imessage"
