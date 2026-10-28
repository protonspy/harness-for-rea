# The egress proxy: the only route out of the internal hfr-sandbox network. It forwards HTTPS
# CONNECT requests to the hosts Claude Code needs and refuses everything else (specs/task-sandbox R2.4).

FROM alpine:3.20
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY allow /etc/tinyproxy/allow
USER tinyproxy
EXPOSE 3128
CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
