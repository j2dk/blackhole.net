# OPTIONAL. The vendor sidecar normally runs as a child process inside the main
# application container (see sidecar.js), so this image is NOT built by
# docker-compose.yml. It exists only for the case where you want to host the
# drivers separately: build this, then set ROUTER_SIDECAR=external and
# ROUTER_SERVICE_URL=http://<host>:5000 on the main container.
# ROUTER_BIND must be 0.0.0.0 here, since the port has to be reachable.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY router_service.py .
COPY vendors ./vendors
USER nobody
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:5000/health').status==200 else 1)" || exit 1
ENV ROUTER_BIND=0.0.0.0 ROUTER_PORT=5000
CMD ["python", "router_service.py"]
