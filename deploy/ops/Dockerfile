# Small ops image shared by the scheduler, backup and monitor services.
# Same major as the database so pg_dump/pg_restore always match the server.
ARG POSTGRES_IMAGE=postgres:17-alpine
FROM ${POSTGRES_IMAGE}
RUN apk add --no-cache bash curl jq coreutils
COPY *.sh /ops/
RUN chmod 0755 /ops/*.sh
ENTRYPOINT []
CMD ["/ops/monitor.sh"]
