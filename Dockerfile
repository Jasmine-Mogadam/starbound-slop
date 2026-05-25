FROM --platform=linux/amd64 ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV STARBOUND_DIR=/opt/starbound

RUN apt-get update && apt-get install -y --no-install-recommends \
    lib32gcc-s1 libstdc++6 libcurl4 zlib1g ca-certificates python3 procps \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p "$STARBOUND_DIR"

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/status_server.py /usr/local/bin/status_server.py
RUN sed -i 's/\r//' /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 21025/tcp
EXPOSE 8080/tcp

CMD ["/usr/local/bin/entrypoint.sh"]
