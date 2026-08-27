FROM postgres:17-bookworm

RUN apt-get update \
  && apt-get install --yes --no-install-recommends pgbackrest \
  && rm -rf /var/lib/apt/lists/* \
  && install --directory --owner=postgres --group=postgres /var/lib/pgbackrest

COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
