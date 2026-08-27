FROM postgres:17-bookworm

RUN apt-get update \
  && apt-get install --yes --no-install-recommends pgbackrest \
  && rm -rf /var/lib/apt/lists/* \
  && install --directory --owner=postgres --group=postgres /var/lib/pgbackrest

RUN mv /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-entrypoint-base.sh

COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY pgbackrest-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY pgbackrest-schedule.sh /usr/local/bin/pgbackrest-schedule.sh

RUN chmod 755 /usr/local/bin/docker-entrypoint.sh /usr/local/bin/pgbackrest-schedule.sh
