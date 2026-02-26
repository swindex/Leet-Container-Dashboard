# Deployment Documentation

This document outlines the complete deployment setup for the home-server application and demo containers.

## Architecture Overview

### Components

1. **Home Server Application** (lcd.snapwebapps.com)
   - Node.js/Bun application
   - Deployed via Docker Compose to `/opt/demo-server/`
   - Accessible via nginx reverse proxy on port 3000
   - SSL certificate managed by Certbot

2. **Demo Containers** (/opt/demo-containers/)
   - **Set 1**: nginx + redis
   - **Set 2**: postgres
   - Non-public facing (no exposed ports)
   - Used to demonstrate container management

## Deployment Flow

The GitHub Actions workflow (`.github/workflows/build-deploy-app.yml`) handles deployment automatically on:
- Push to `master` branch
- Pull requests
- Manual workflow dispatch

### Deployment Steps

1. **Setup SSH** - Configures SSH key for droplet access
2. **Deploy Demo Containers** - Syncs demo-containers to `/opt/demo-containers/`
3. **Deploy Demo Server** - Syncs demo-server files to `/opt/demo-server/` and starts with docker-compose
4. **Configure LCD Nginx** - Sets up nginx and SSL for lcd.snapwebapps.com
5. **Start Demo Containers** - Launches demo containers with docker-compose

## Directory Structure

```
/opt/
├── demo-server/              # Demo server application
│   ├── docker-compose.yml    # Main app compose file
│   ├── src/                  # Source code
│   ├── data/                 # Persistent data
│   └── ...
└── demo-containers/          # Demo containers
    ├── docker-compose-set1.yml  # nginx + redis
    ├── docker-compose-set2.yml  # postgres
    └── README.md

/etc/nginx/sites-available/
└── lcd.snapwebapps.com       # Demo server nginx config
```

## Local Testing

### Test Demo Containers

```bash
# Validate docker-compose configurations
docker-compose -f demo-containers/docker-compose-set1.yml config
docker-compose -f demo-containers/docker-compose-set2.yml config

# Start demo containers
docker-compose -f demo-containers/docker-compose-set1.yml up -d
docker-compose -f demo-containers/docker-compose-set2.yml up -d

# Check status
docker ps -a | grep demo-

# Stop demo containers
docker-compose -f demo-containers/docker-compose-set1.yml down
docker-compose -f demo-containers/docker-compose-set2.yml down
```

### Test Home Server

```bash
# Start home server locally
bun run dev

# Or with docker-compose
docker-compose up -d --build
```

## Security Notes

### Demo Containers
- No ports exposed publicly (internal network only)
- PostgreSQL uses dummy credentials (not for production)
- Redis has no persistence enabled
- No persistent data volumes mounted

### Home Server
- Requires proper environment variables in `.env`
- **Docker socket mounted in READ-ONLY mode** for enhanced security
  - Can view and list containers
  - Cannot start, stop, restart, or remove containers
  - For full control, consider using remote server management via SSH instead
- Session secrets should be changed from defaults
- Data directory contains sensitive user information
- **Note**: Read-only Docker socket still grants visibility into all containers on the host

## Manual Deployment

If needed, you can manually deploy:

```bash
# SSH into droplet
ssh root@[DROPLET_IP]

# Update demo server
cd /opt/demo-server
git pull
docker-compose down
docker-compose up -d --build

# Update demo containers
cd /opt/demo-containers
docker-compose -f docker-compose-set1.yml restart
docker-compose -f docker-compose-set2.yml restart

# Reload nginx
sudo nginx -t
sudo systemctl reload nginx
```

## Troubleshooting

### Check Logs

```bash
# Demo server logs
docker-compose -f /opt/demo-server/docker-compose.yml logs -f

# Demo container logs
docker-compose -f /opt/demo-containers/docker-compose-set1.yml logs
docker-compose -f /opt/demo-containers/docker-compose-set2.yml logs

# Nginx logs
tail -f /var/log/nginx/lcd.snapwebapps.com-error.log
tail -f /var/log/nginx/lcd.snapwebapps.com-access.log
```

### Common Issues

1. **Port 3000 already in use**: Check if another service is using port 3000
2. **Docker socket permission**: Ensure container has access to `/var/run/docker.sock`
3. **SSL certificate issues**: Check certbot logs and ensure DNS is properly configured
4. **Demo containers not visible**: They're intentionally not exposed publicly

## GitHub Secrets Required

The workflow requires these secrets to be configured:
- `SSH_PRIVATE_KEY`: SSH private key for droplet access
- `DROPLET_IP`: IP address of the DigitalOcean droplet
