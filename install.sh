#!/usr/bin/env sh
set -eu

INSTALL_DIR="${DROOL_INSTALL_DIR:-"$HOME/.local/bin"}"
INSTALL_PATH="$INSTALL_DIR/drool"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS:$ARCH" in
  Linux:x86_64|Linux:amd64)
    ASSET="drool-linux-x64"
    ;;
  Darwin:arm64|Darwin:aarch64)
    ASSET="drool-darwin-arm64"
    ;;
  *)
    echo "Unsupported platform: $OS $ARCH" >&2
    exit 1
    ;;
esac

URL="https://github.com/udonge-foundation/drool/releases/latest/download/$ASSET"
TMP_DIR="$(mktemp -d)"
TMP_BIN="$TMP_DIR/$ASSET"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT HUP TERM

echo "Downloading $URL"
if command -v curl >/dev/null 2>&1; then
  curl -fL "$URL" -o "$TMP_BIN"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$TMP_BIN" "$URL"
else
  echo "curl or wget is required" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
if command -v install >/dev/null 2>&1; then
  install -m 755 "$TMP_BIN" "$INSTALL_PATH"
else
  cp "$TMP_BIN" "$INSTALL_PATH"
  chmod 755 "$INSTALL_PATH"
fi

echo "Installed drool to $INSTALL_PATH"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    SHELL_NAME="$(basename "${SHELL:-sh}")"
    case "$SHELL_NAME" in
      zsh) PROFILE="$HOME/.zshrc" ;;
      bash) PROFILE="$HOME/.bashrc" ;;
      *) PROFILE="$HOME/.profile" ;;
    esac

    if [ "$INSTALL_DIR" = "$HOME/.local/bin" ]; then
      PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
    else
      PATH_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""
    fi

    if [ ! -f "$PROFILE" ] || ! grep -Fqs "$PATH_LINE" "$PROFILE"; then
      {
        echo ""
        echo "# Added by drool installer"
        echo "$PATH_LINE"
      } >> "$PROFILE"
      echo "Added $INSTALL_DIR to PATH in $PROFILE"
      echo "Restart your shell or run: $PATH_LINE"
    else
      echo "$INSTALL_DIR is already configured in $PROFILE"
    fi
    ;;
esac

echo "Run: drool --version"
