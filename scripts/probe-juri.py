# Probe the key that actually drives the judge runs: DEEPSEEK_API_KEY in content-miner/.env
import json
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:20128/v1"

def read_key(path, name):
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip()
    return ""

def probe(key, model):
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 5}).encode()
    req = urllib.request.Request(BASE + "/chat/completions", data=body,
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return "OK"
    except urllib.error.HTTPError as e:
        try:
            msg = e.read().decode()[:120]
        except Exception:
            msg = ""
        return f"HTTP {e.code}: {msg}"
    except Exception as e:
        return f"ERR {type(e).__name__}: {str(e)[:80]}"

ds2 = read_key("D:/homelab/hermes-workspace/content-miner/.env", "DEEPSEEK_API_KEY")
models = ["ds/deepseek-v4-flash", "ag/gemini-3.5-flash-low", "ag/gemini-3-flash-agent",
          "cx/gpt-5.6-luna", "cx/gpt-5.6-luna-review", "cx/gpt-5.6-terra", "cx/gpt-5.4-mini",
          "cmc/Qwen/Qwen3.6-Max-Preview", "cmc/moonshotai/Kimi-K2.6", "cmc/zai-org/GLM-5.1", "deepseek"]
for m in models:
    print(f"DS2 | {m:32s} -> {probe(ds2, m)}")