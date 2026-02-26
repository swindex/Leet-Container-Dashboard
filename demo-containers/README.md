# Demo Containers

This directory contains Docker Compose files for demonstration purposes. These containers are lightweight, non-public facing services used to showcase the container management capabilities of the home-server application.

## Services

### Set 1 (docker-compose-set1.yml)
- **demo-nginx**: Nginx web server (Alpine-based)
- **demo-redis**: Redis cache (Alpine-based)

### Set 2 (docker-compose-set2.yml)
- **demo-postgres**: PostgreSQL database (Alpine-based)

## Usage

Start the containers:
```bash
docker-compose -f docker-compose-set1.yml up -d
docker-compose -f docker-compose-set2.yml up -d
```

Stop the containers:
```bash
docker-compose -f docker-compose-set1.yml down
docker-compose -f docker-compose-set2.yml down
```

## Security Notes

- No ports are exposed publicly (internal network only)
- PostgreSQL uses dummy credentials (not for production use)
- Redis has no persistence enabled
- No persistent data volumes are mounted
