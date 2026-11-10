#!/usr/bin/env bash
set -euo pipefail

node_ip=$(hostname -i | awk '{print $1}')
case "$1" in
  fe)
    export FE_SERVERS="fe1:${node_ip}:9010" FE_ID=1
    sed -i -E 's/-Xms[[:alnum:]]+/-Xms512m/g; s/-Xmx[[:alnum:]]+/-Xmx2048m/g' /opt/apache-doris/fe/conf/fe.conf
    exec bash /usr/local/bin/init_fe.sh
    ;;
  be)
    fe_ip=$(getent ahostsv4 doris-fe | awk 'NR == 1 {print $1}')
    export FE_SERVERS="fe1:${fe_ip}:9010" BE_ADDR="${node_ip}:9050"
    printf '\nmem_limit = 4G\n' >> /opt/apache-doris/be/conf/be.conf
    exec bash /usr/local/bin/entry_point.sh
    ;;
  *) echo 'Expected fe or be' >&2; exit 2 ;;
esac
