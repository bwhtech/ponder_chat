#!/usr/bin/env bash
# Installs Jaeger, which keeps Ponder Chat's traces (deploy/README.md, "Traces"). Run as
# root on the server, from a release folder:
#   cd /srv/ponder-chat/current && sudo bash deploy/jaeger.sh
# Safe to run again. It does not turn tracing on in Ponder: set OTEL_EXPORTER_OTLP_ENDPOINT
# in /etc/ponder-chat/env and restart ponder-chat after it.
set -euo pipefail

VERSION=2.22.0
# The sha256 of the jaeger binary in the release, from jaeger-$VERSION-linux-<arch>.sha256sum.txt.
case "$(uname -m)" in
	x86_64) ARCH=amd64 SHA256=fa574f53e2f739301f301f66e5608c84d0b9a90cdd08e4f6cba8809d171854e1 ;;
	aarch64) ARCH=arm64 SHA256=b3af2361d4eb72e4b34fa7ed839d9d9c6d305102181d9c8b3c7491d83769a326 ;;
	*) echo "No Jaeger build for $(uname -m)." >&2 && exit 1 ;;
esac
HERE=$(cd "$(dirname "$0")" && pwd)

if [ "$(/usr/local/bin/jaeger version 2>/dev/null | grep -o "v$VERSION" || true)" != "v$VERSION" ]; then
	echo "== Jaeger $VERSION ($ARCH)"
	work=$(mktemp -d)
	trap 'rm -rf "$work"' EXIT
	curl -fsSL "https://github.com/jaegertracing/jaeger/releases/download/v$VERSION/jaeger-$VERSION-linux-$ARCH.tar.gz" | tar -xz -C "$work"
	echo "$SHA256  $work/jaeger-$VERSION-linux-$ARCH/jaeger" | sha256sum --check --quiet
	install -m 755 "$work/jaeger-$VERSION-linux-$ARCH/jaeger" /usr/local/bin/jaeger
fi

echo "== Config and unit"
install -d -m 755 /etc/jaeger
install -m 644 "$HERE/jaeger.yaml" /etc/jaeger/jaeger.yaml
install -m 644 "$HERE/jaeger.service" /etc/systemd/system/jaeger.service
systemctl daemon-reload
systemctl enable jaeger >/dev/null
systemctl restart jaeger

echo "== Waiting for Jaeger"
for _ in $(seq 1 30); do
	curl -fs http://127.0.0.1:13133/status >/dev/null && break
	sleep 1
done
curl -fs http://127.0.0.1:13133/status >/dev/null || { journalctl -u jaeger -n 30 --no-pager; exit 1; }
echo "Jaeger is up on 127.0.0.1. Next: set OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 in /etc/ponder-chat/env and run: sudo systemctl restart ponder-chat"
