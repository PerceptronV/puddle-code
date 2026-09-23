{
  admin off
  auto_https off
}
:8080 {
  root * /srv
  header {
    X-Content-Type-Options nosniff
    Referrer-Policy no-referrer
    Cache-Control no-store
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
  }
  @application not path /preview.html
  header @application {
    Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; media-src blob:; frame-src 'self' blob:; connect-src {$PUDDLE_REMOTE_SERVICE} {$PUDDLE_REMOTE_WSS}; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'"
    X-Frame-Options DENY
  }
  @preview path /preview.html
  header @preview Content-Security-Policy "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: https:; style-src 'unsafe-inline' data: https:; img-src data: https:; font-src data: https:; media-src data: https:; connect-src https:; frame-ancestors 'self'; base-uri 'none'; object-src 'none'; form-action 'none'"
  try_files {path} /index.html
  file_server
}
