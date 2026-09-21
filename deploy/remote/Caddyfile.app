{
  admin off
  auto_https off
}
:8080 {
  root * /srv
  header {
    Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src {$PUDDLE_REMOTE_SERVICE} {$PUDDLE_REMOTE_WSS}; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'"
    X-Content-Type-Options nosniff
    Referrer-Policy no-referrer
    X-Frame-Options DENY
    Cache-Control no-store
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
  }
  try_files {path} /index.html
  file_server
}
