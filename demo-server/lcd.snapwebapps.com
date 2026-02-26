# Rate limiting zones
# 10MB zone can store ~160,000 IP addresses
limit_req_zone $binary_remote_addr zone=general_limit:10m rate=60r/m;
limit_req_zone $binary_remote_addr zone=login_limit:10m rate=5r/m;
limit_req_status 429;

server {
    server_name lcd.snapwebapps.com;

    # Redirect HTTP to HTTPS (will be configured by certbot)
    # return 301 https://$server_name$request_uri;

    # Stricter rate limit for login endpoint to prevent brute force attacks
    location /login {
        # Allow 5 requests per minute per IP, with a burst of 2 extra requests
        # After burst is used, requests are delayed (nodelay processes them immediately if within limit)
        limit_req zone=login_limit burst=2 nodelay;
        
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        
        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        # Buffer settings
        proxy_buffering off;
        proxy_request_buffering off;
    }

    # General rate limit for all other requests
    location / {
        # Allow 60 requests per minute per IP, with a burst of 20 extra requests
        limit_req zone=general_limit burst=20 nodelay;
        
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        
        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
        
        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        # Buffer settings
        proxy_buffering off;
        proxy_request_buffering off;
    }

    # Logging
    access_log /var/log/nginx/lcd.snapwebapps.com-access.log;
    error_log /var/log/nginx/lcd.snapwebapps.com-error.log;
}
