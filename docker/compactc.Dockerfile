# The Compact 0.36.1 compiler (Linux release binaries) in a container, so the
# contract compiles the same way on Windows, macOS and Linux.
FROM debian:bookworm-slim
COPY compactc compactc.bin fixup-compact format-compact zkir-v3 /opt/compact/
COPY ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN chmod +x /opt/compact/*
ENV PATH=/opt/compact:$PATH SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt SSL_CERT_DIR=/etc/ssl/certs
WORKDIR /work
ENTRYPOINT ["compactc"]
