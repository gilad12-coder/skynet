# Managed-inference gateway image, used by docker-compose and registry/PaaS
# deploys (e.g. Railway) alike.
#
# Built from the MIT-licensed litellm wheel rather than the upstream
# ghcr.io/berriai/litellm image, which ships LiteLLM's proprietary enterprise/
# code. requirements.txt explains why the proxy extra is spelled out.
#
# ``--host ::`` binds IPv6 (dual-stack on Linux, so IPv4 still works): required
# for a private-network deploy where the only caller is the backend reaching it
# at ``http://<service>.railway.internal:4000`` — Railway's private network is
# IPv6-only. Harmless for the local compose / public setups, which also work
# over the dual-stack socket.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

# Prisma's CLI runs on Node: it generates the DB client here and applies the
# virtual-key/spend migrations when the proxy starts.
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt \
    && prisma generate --schema "$(python -c 'import litellm, os; print(os.path.join(os.path.dirname(litellm.__file__), "proxy", "schema.prisma"))')"

COPY config.yaml /app/config.yaml
COPY custom_callbacks.py /app/custom_callbacks.py

EXPOSE 4000
ENTRYPOINT ["litellm"]
CMD ["--config", "/app/config.yaml", "--port", "4000", "--host", "::"]
