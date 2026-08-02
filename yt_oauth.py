"""YouTube OAuth helper — get a refresh token for uploads.

Usage:
  python yt_oauth.py url     # print the authorization URL to open in a browser
  python yt_oauth.py code <AUTH_CODE>   # exchange the code for a refresh token

The refresh token is written to .env as YT_REFRESH_TOKEN. To post as a
DIFFERENT YouTube account later, just re-run with that account and the new
token replaces the old one (client id/secret stay the same).
"""
import os
import sys
import urllib.parse
import urllib.request

SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl"

def load_env(path=".env"):
    env = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
    return env

def auth_url(client_id: str) -> str:
    params = {
        "client_id": client_id,
        "redirect_uri": "http://localhost:8085/oauth/callback",
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",
        "prompt": "consent",
    }
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)

def exchange(client_id: str, client_secret: str, code: str) -> dict:
    data = urllib.parse.urlencode({
        "code": code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": "http://localhost:8085/oauth/callback",
        "grant_type": "authorization_code",
    }).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req) as resp:
        return json_loads(resp.read())

def json_loads(raw):
    import json
    return json.loads(raw)

def set_env_value(path: str, key: str, value: str) -> None:
    lines = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()
    found = False
    for i, line in enumerate(lines):
        if line.strip().startswith(key + "="):
            lines[i] = f"{key}={value}\n"
            found = True
            break
    if not found:
        lines.append(f"{key}={value}\n")
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(lines)

def main():
    env = load_env()
    cid = env.get("YT_CLIENT_ID")
    secret = env.get("YT_CLIENT_SECRET")
    if not cid or not secret:
        print("ERROR: YT_CLIENT_ID / YT_CLIENT_SECRET not found in .env")
        sys.exit(1)

    args = sys.argv[1:]
    if not args or args[0] == "url":
        print(auth_url(cid))
    elif args[0] == "code" and len(args) >= 2:
        tok = exchange(cid, secret, args[1].strip())
        if "refresh_token" not in tok:
            print("ERROR: no refresh_token in response:", {k: v for k, v in tok.items() if k != "access_token"})
            sys.exit(1)
        set_env_value(".env", "YT_REFRESH_TOKEN", tok["refresh_token"])
        print("OK: YT_REFRESH_TOKEN saved to .env")
        print(f"    scopes: {tok.get('scope')}")
    else:
        print("Usage: python yt_oauth.py url | python yt_oauth.py code <AUTH_CODE>")
        sys.exit(1)

if __name__ == "__main__":
    main()
