FROM --platform=linux/amd64 ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV STARBOUND_DIR=/opt/starbound

RUN apt-get update && apt-get install -y --no-install-recommends \
    libcurl4-gnutls-dev libstdc++6 libgcc-s1 zlib1g \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash steam && \
    mkdir -p /opt/starbound && \
    chown steam:steam /opt/starbound

COPY --chown=steam:steam .build/server/ /opt/starbound/

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 21025/udp

USER steam

CMD ["/usr/local/bin/entrypoint.sh"]
