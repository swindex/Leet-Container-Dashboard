# Docker Hub Deployment Guide

This document explains the Docker Hub deployment setup for Leet Container Dashboard.

## 🎯 Overview

The application is now configured to:
1. **Build** Docker images with starter data included
2. **Deploy** automatically to Docker Hub on every push to `main` branch
3. **Seed** user data directories on first run
4. **Persist** user customizations across container restarts

## 📦 What's Included

### Files Created/Modified:

1. **`.dockerignore`** - Excludes unnecessary files from Docker build
2. **`docker-entrypoint.sh`** - Smart initialization script for data seeding
3. **`Dockerfile`** - Updated to include starter data and entrypoint
4. **`.github/workflows/docker-hub-publish.yml`** - GitHub Actions workflow for automated publishing
5. **`docker-compose.yml`** - Updated to use Docker Hub image by default
6. **`README.md`** - Added Docker Hub installation instructions

## 🔐 Required GitHub Secrets

Before the workflow can publish to Docker Hub, you need to add this secret:

1. Go to: `https://github.com/YOUR_USERNAME/YOUR_REPO/settings/secrets/actions`
2. Click **"New repository secret"**
3. Name: `DOCKER_PAT`
4. Value: Your Docker Hub Personal Access Token
   - Create one at: https://hub.docker.com/settings/security
   - Recommended scopes: Read, Write, Delete

## 🚀 How It Works

### Data Seeding Strategy

The Docker image contains starter files in `/app/data-seed/`:
- `dashboardSettings.json` - Default dashboard configuration
- `remoteServers.json` - Local server setup
- `users.json` - Empty users database
- `uploads/backgrounds/` - Default background image

**On first run:**
1. Container starts, script checks `/app/data/`
2. If empty or missing critical files, seeds from `/app/data-seed/`
3. User gets working defaults immediately
4. Application starts normally

**On subsequent runs:**
1. Mounted volume already has data
2. Script detects existing files and skips seeding
3. User customizations are preserved

### Automated Publishing

When you push to `main` branch:
1. GitHub Actions triggers the workflow
2. Builds multi-platform images (AMD64 + ARM64)
3. Publishes to `eldargerfanov/leet-container-dashboard:latest`
4. Also tags with version numbers (if you create git tags like `v1.0.0`)
5. Updates Docker Hub description with README content

## 📋 Testing Checklist

- [x] Docker build completes successfully
- [x] Entrypoint script seeds data correctly
- [x] .dockerignore excludes sensitive files
- [ ] GitHub secret `DOCKER_PAT` added
- [ ] Push to main triggers workflow
- [ ] Image published to Docker Hub
- [ ] Pull and run from Docker Hub works

## 🐳 Docker Hub Image

**Repository:** `eldargerfanov/leet-container-dashboard`

**Available Tags:**
- `latest` - Most recent build from main branch
- `main` - Same as latest
- `v1.0.0`, `v1.0`, `v1` - Semantic version tags (when you create git tags)

## 📖 User Instructions

Users can now install with a single command:

```bash
docker pull eldargerfanov/leet-container-dashboard:latest
docker run -d \
  --name leet-container-dashboard \
  -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v ./data:/app/data \
  -e COOKIE_SECRET=your-secret-here \
  -e REMOTE_SERVERS_KEY=your-key-here \
  eldargerfanov/leet-container-dashboard:latest
```

Or with docker-compose:

```yaml
services:
  panel:
    image: eldargerfanov/leet-container-dashboard:latest
    ports:
      - "3000:3000"
    environment:
      - COOKIE_SECRET=change-this-to-a-long-random-string
      - REMOTE_SERVERS_KEY=change-this-to-a-long-random-string
    volumes:
      - ./data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
    restart: unless-stopped
```

## 🔄 Manual Publish (Optional)

If you want to publish manually instead of using GitHub Actions:

```bash
# Build the image
docker build -t eldargerfanov/leet-container-dashboard:latest .

# Login to Docker Hub
docker login -u eldargerfanov

# Push to Docker Hub
docker push eldargerfanov/leet-container-dashboard:latest
```

## 🎉 Next Steps

1. **Add GitHub Secret:** Set up `DOCKER_PAT` in your repository secrets
2. **Push to Main:** Commit and push your changes to trigger the workflow
3. **Verify on Docker Hub:** Check that the image appears at https://hub.docker.com/r/eldargerfanov/leet-container-dashboard
4. **Test Install:** Pull and run the image from Docker Hub on a fresh machine
5. **Update Documentation:** Consider adding badges to README for Docker Hub

## 🏷️ Version Tagging

To publish versioned releases:

```bash
git tag -a v1.0.0 -m "Release version 1.0.0"
git push origin v1.0.0
```

This will trigger the workflow and create tags:
- `eldargerfanov/leet-container-dashboard:v1.0.0`
- `eldargerfanov/leet-container-dashboard:v1.0`
- `eldargerfanov/leet-container-dashboard:v1`
- `eldargerfanov/leet-container-dashboard:latest`

## 🐛 Troubleshooting

**Workflow fails with authentication error:**
- Verify `DOCKER_PAT` secret is set correctly
- Check that the PAT has Write permissions
- Ensure PAT hasn't expired

**Data not seeding:**
- Check logs: `docker logs <container-name>`
- Verify volume mount: `docker inspect <container-name>`
- Ensure `/app/data` is mounted, not `/app/data-seed`

**Build fails on COPY data/uploads:**
- Ensure `data/uploads/backgrounds/` directory exists
- Check that background image file is present
- Verify .dockerignore isn't excluding needed files
