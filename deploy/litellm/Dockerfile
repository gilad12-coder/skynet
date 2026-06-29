# Managed-inference gateway image for registry/PaaS deploys (e.g. Railway).
#
# docker-compose bind-mounts ./config.yaml into the stock litellm image; a PaaS
# has no bind mount, so we bake the same config into the image instead. The base
# image's entrypoint is ``litellm``, so CMD supplies exactly the args compose
# passes as ``command:``. The proxy listens on a fixed 4000; point the platform's
# service domain at that port.
FROM ghcr.io/berriai/litellm:main-stable
COPY config.yaml /app/config.yaml
CMD ["--config", "/app/config.yaml", "--port", "4000"]
